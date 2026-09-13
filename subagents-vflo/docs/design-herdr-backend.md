# Herdr execution backend for subagents-vflo

## Goal

When the parent pi session runs inside a [Herdr](https://herdr) workspace, spawned
subagents should open as real pi sessions in new Herdr panes instead of the
extension's RPC-runner + inspector flow. Everything else (result delivery,
lifecycle semantics, cleanup) stays equivalent. Outside Herdr, nothing changes.

## Why a backend abstraction

`runChild()` in `src/runner.ts` already implements one complete execution model:
spawn headless pi in RPC mode, drive it over stdin/stdout, resolve on first
settled turn, close stdin, parse exit. A Herdr subagent is a *different*
execution model (interactive TUI in a pane, session JSONL as the observation
surface, no process handle) but the *same* contract:

```ts
interface SubagentBackend {
  spawn(spec: SubagentSpec): Promise<SubagentHandle>
}
```

`SubagentHandle` is the exact seam the existing code consumes:

```ts
interface SubagentHandle {
  result: Promise<ChildRunResult>       // resolves once, terminal semantics
  control?: SubagentProcessControl      // sendMessage / abort; undefined for refused spawns
  process?: ChildProcess                // RPC backend only; Herdr children have no process handle
}
```

`index.ts` keeps its orchestration; it calls `backend.spawn(spec)` and consumes
the handle. The old `onProcessReady`/`onProcessExit` callbacks are replaced by
handle attachment plus post-result cleanup. Backends are chosen once per
runtime by `createBackend()` using `selectBackendKind()`.

## How the parent observes a Herdr child

There is **no RPC channel** — the child is an interactive TUI in a pane. Herdr's
own `idle`/`done` status is explicitly *not* authoritative (it is a UI-seen
state, not task semantics). The authoritative observation surface is the child's
**session JSONL**, which pi appends to on every `message_end`:

1. Parent creates a fresh session dir (`mkdtemp /tmp/pi-subagent-*`), passed to
   the child via `--session-dir`. Session files land there (flat or nested —
   watcher globs recursively).
2. A `SessionWatcher` (fs.watch on the dir + read-from-offset with torn-line
   buffering) parses assistant messages:
   - `stopReason: "toolUse"` → turn continues (working)
   - `stopReason: "stop"` + non-empty text → **task completed** → result text =
     text of the *last* assistant message (matches RPC `finalOutput` semantics)
   - `stopReason: "aborted"` → turn aborted: instance stays running, a "waiting
     for input" note is surfaced; pane/session stay alive for manual steering
   - `stopReason: "error"` → child turn errored → recorded as error
3. Pane death (via `herdr pane get` polling — JSON `pane_not_found` error) is
   resolved against the last observed stopReason:
   - last was `stop`/completed → completed (exit race, result already known)
   - last was `aborted` → aborted (user interrupted, then pane closed)
   - last was `error` → error
   - nothing/mid-turn → error "pane closed before completing"
   - parent-requested close (`control.abort()`) → aborted, never success
4. An errored child turn (`stopReason: "error"`) that sits idle past a 30s
   grace fails the task, mirroring the RPC runner; every new session message
   resets the grace so pi's automatic in-turn retries are tolerated.
5. Startup failures are caught synchronously: `pane split` / `agent start`
   reject → spawn rejects → task error. `agent start` failure may leave an
   empty pane → parent closes it (`herdr pane close`), best effort.

This keeps Herdr's status as a *hint* (only used to disambiguate pane death)
and the JSONL as the source of truth.

## Turn lifecycle vs task lifecycle

- **Turn** = one assistant pass; observed per assistant message in JSONL.
- **Task** = the whole child session; terminal only via pane death / explicit
  abort / (future) `subagent_done`.

An interrupted (aborted) turn does **not** complete the task. The child stays
alive; the user can type into the pane; a later normal turn completion still
resolves the task normally. Manual intervention never disables automatic
completion — completion is decided per-stopReason, not per-session-history.

## Process control mapping

| Parent API        | Default backend              | Herdr backend                          |
| ----------------- | ---------------------------- | -------------------------------------- |
| `sendMessage`     | RPC `prompt` over stdin      | `herdr agent prompt <name> <text>`     |
| `abort`           | RPC `abort` / SIGTERM        | `herdr pane close` (kills the child)   |
| killAll           | SIGTERM → SIGKILL            | `herdr pane close` for every controlled instance |

## Verifying against reality

- `docs/smoke-herdr-cli.mjs` (run from inside a Herdr pane) exercises the
  exact argv sequences against the real binary: split without focus steal,
  pi agent start, pane state, close + not-found classification. No model call.
- `src/session-fixture.test.ts` replays a real captured session file
  (`src/fixtures/real-pi-session.jsonl`, one real entry per stopReason) through
  the watcher and the monitor, pinning the JSONL contract against real data.

## Environment rules

- Children inherit the parent env minus `PI_SESSION_FILE` (unchanged), plus
  `PI_SUBAGENTS_VFLO_DEPTH=<depth+1>` (nesting guard unchanged).
- In Herdr, depth is additionally injected with `--env` so the *pane shell*
  carries it; the pi process inherits it from the pane.
- Herdr detection lives in `src/herdr.ts` (`isHerdrEnvironment()`,
  `herdrContextFromEnv()`) and nowhere else.

## Herdr CLI facts (verified against herdr 0.8.2)

- `herdr pane split --current --direction right --ratio 0.5 --cwd <dir>
  --no-focus --env K=V` → `{result:{pane:{pane_id,...}}}`. `--no-focus` prevents
  focus steal. New pane gets its own `HERDR_PANE_ID`, so `--current` inside a
  child pane anchors correctly for recursive grandchild spawns.
- `herdr agent start <name> --kind pi --pane <id> -- <pi args...>` waits until
  the pi TUI is detected (`interactive_ready`). Name rules:
  `[a-z][a-z0-9_-]{0,31}`, unique among live agents. On `agent_not_ready` the
  name stays reserved.
- `herdr agent prompt <name|pane> <text>` types the text (bracketed paste) and
  presses Enter; fails with `agent_blocked` if the child sits at a dialog.
- `herdr pane get <id>` → `{result:{pane:...}}` or `{error:{code:"pane_not_found"}}`.
- `herdr pane close <id>` kills the process inside the pane.
- Server errors: JSON on stdout/stderr, exit 1; usage errors exit 2.

## Non-goals

- No workflow-specific concepts; the backend knows nothing about tasks beyond
  the spec/handle contract.
- No reimplementation of the inspector; `/subagents` and Ctrl+Down keep working
  for RPC instances. Herdr instances appear in tracker state and therefore in
  the inspector list (abort and steering work through their control; the pane
  itself is the primary live view).
- No `subagent_done` protocol in this iteration: the JSONL watcher already
  implements automatic completion for the normal path (an interrupted turn
  followed by a later normal settle completes the task), and persistent or
  interactive children are terminated by pane death semantics. The
  `SubagentSpec.onEvent` channel is the natural seam if a child→parent
  completion signal is ever added.

## Known limitations

- **Inspector abort during startup.** Parent Escape (the tool signal) is
  honored mid-spawn — the backend checks it after every startup step and
  closes any half-created pane — but an abort from the inspector's `x` key
  during the multi-second Herdr startup window (split → start → prompt) can
  only mark the instance aborted; the spawn may still finish and later
  complete. The RPC backend has the same race with a much smaller window.
- **Agent prompt rides in argv.** `herdr agent prompt` passes the task text
  as a single argv; extremely large task texts are bounded by ARG_MAX.
- **Pane death is not classified as crash vs user-kill.** Both resolve as
  error (never success); an abort-before-death or an interrupted-last-turn
  resolves as aborted.
- **Unreachable Herdr server.** After 3 consecutive pane-poll failures the
  monitor settles the task as an error rather than wedge forever.
- The golden fixture `src/fixtures/real-pi-session.jsonl` (real entries,
  strings truncated) pins the JSONL contract; regenerate it from live sessions
  if pi's on-disk format changes.
