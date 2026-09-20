# Herdr execution backend for subagents-vflo

## Goal

When the parent pi session runs inside a [Herdr](https://herdr) workspace, spawned
subagents should open as real pi sessions in new Herdr panes instead of the
extension's RPC-runner + inspector flow. Result delivery, lifecycle semantics,
and cleanup stay equivalent across both backends. The explicit lifecycle and
final-output rules below also prevent a turn-level abort from being treated as
a task failure outside Herdr.

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
own `idle`/`done` status is not authoritative for delegated-task completion (it
is a UI-seen state, not task semantics). The Herdr agents view can still show
accurate per-pane symbols when the managed lifecycle integration is loaded:

- The child argv keeps `--no-extensions` so unrelated parent extensions do not
  leak into an isolated child session.
- The Herdr backend resolves
  `PI_CODING_AGENT_DIR/extensions/herdr-agent-state.ts` (including Pi's
  `~/...` expansion), or the default `~/.pi/agent/extensions/herdr-agent-state.ts`,
  and adds that one file with `-e` when it is a regular file. Relative override
  paths are resolved against the child cwd, matching the Pi process in the new
  pane. A configured symlink to the same file is detected by canonical path and
  is not loaded twice.
- The integration reports Pi lifecycle events to Herdr's `pane.report_agent`
  endpoint. Herdr then uses lifecycle-hook authority for `working`, `idle`, and
  `blocked` symbols instead of screen-text fallback. If the optional file is
  absent, the child still starts and Herdr falls back to its screen detection;
  that fallback may misclassify a working Pi TUI as idle.

The authoritative observation surface for task completion remains the child's
**session JSONL**, which pi appends to on every `message_end`:

1. Parent passes its project-specific `ctx.sessionManager.getSessionDir()` to
   the backend. The backend creates a fresh child directory (`mkdtemp
   <parent-session-dir>/pi-subagent-*`) and passes it to the child via
   `--session-dir`. Session files land there (flat or nested — watcher globs
   recursively). This keeps each watcher isolated while placing persistent
   child history below the same Pi session storage tree as the parent.
   In-memory or unavailable parent session directories fall back to
   `/tmp/pi-subagent-*`. Child histories are intentionally retained for
   inspection; cleanup is manual rather than automatic.
2. A `SessionWatcher` (fs.watch on the dir + read-from-offset with torn-line
   buffering) parses assistant messages:
   - `stopReason: "toolUse"` → turn continues (working)
   - `stopReason: "stop"` + non-empty text → **task completed** → result text =
     the text from this final normal stop message. Text from earlier turns is
     not concatenated into the result.
   - `stopReason: "aborted"` → turn interrupted: the task enters the
     non-terminal `interrupted` lifecycle; pane/session/watchers stay alive for
     manual steering and the parent request remains pending.
   - `stopReason: "error"` → child turn enters `waiting` while the error grace
     period allows Pi to retry; an unrecovered error becomes `failed`.
3. Pane death (via `herdr pane get` polling — JSON `pane_not_found` error) is
   a task-level terminal event, not another turn interruption:
   - last was `stop`/completed → completed (the session watcher wins the exit race)
   - last was `aborted` → `closed` (interrupted, then pane closed)
   - last was `error` → `failed`
   - nothing/mid-turn → `closed` ("pane closed before completing")
   - parent-requested close (`control.abort()`) → `closed`, never success
4. An errored child turn (`stopReason: "error"`) that sits idle past a 30s
   grace fails the task, mirroring the RPC runner; every new session message
   resets the grace so pi's automatic in-turn retries are tolerated.
5. Startup failures are caught synchronously: `pane split` / `agent start`
   reject → spawn rejects → task error. `agent start` failure may leave an
   empty pane → parent closes it (`herdr pane close`), best effort.

This keeps Herdr's status as a *hint* (never a completion signal) and the
JSONL plus the monitor's explicit lifecycle as the source of truth. A
turn-generation guard rejects a delayed pane observation from an older turn
when new guidance has already started a newer one.

## Turn lifecycle vs task lifecycle

- **Turn** = one assistant pass; observed per assistant message in JSONL.
- **Task** = the whole child session. Its explicit lifecycle is
  `starting | running | waiting | interrupted | completed | failed | closed`.
  Only `completed`, `failed`, and `closed` are terminal.

An interrupted (`stopReason: "aborted"`) turn changes only the current-turn
state. The child stays alive; the user can type into the same pane; a later
normal turn changes the task back to `running` and can still complete it. The
parent receives no result while the task is `interrupted`. Manual intervention
never disables automatic completion — the final result is selected from the
later normal `stop` message, not from the interrupted assistant text.

The existing `TaskStatus` values remain the inspector/UI compatibility layer:
an alive interrupted task is still displayed as `running` so steering remains
available. The lifecycle field carries the finer distinction used by result
classification.

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
  `PI_SUBAGENTS_VFLO_DEPTH=<depth+1>` (nesting guard unchanged). The session
  directory is passed explicitly from the parent session manager; it is not
  inferred from inherited session metadata.
- In Herdr, depth is additionally injected with `--env` so the *pane shell*
  carries it; the pi process inherits it from the pane.
- Herdr child startup retains `--no-extensions` and explicitly adds the
  optional managed lifecycle extension described above. Missing integration
  files are ignored so Herdr support cannot turn a valid child spawn into a
  startup error.
- Herdr detection lives in `src/herdr.ts` (`isHerdrEnvironment()`,
  `herdrContextFromEnv()`) and nowhere else.

## Herdr CLI facts (verified against herdr 0.8.2; `--wait`/`agent send-keys` argv shapes verified against 0.9.0)

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
  With `--wait --until <state> --timeout <ms>` it additionally confirms the
  pane left `idle`; see "Initial-prompt submission race" below.
- `herdr agent send-keys <name> <key>...` sends raw logical keys (e.g.
  `enter`, `esc`) into the agent's terminal, bypassing bracketed-paste typing.
- `herdr pane get <id>` → `{result:{pane:...}}` or `{error:{code:"pane_not_found"}}`.
- `herdr pane close <id>` kills the process inside the pane.
- Server errors: JSON on stdout/stderr, exit 1; usage errors exit 2.

## Initial-prompt submission race

Right after `agent start` reports the pane ready, pi's TUI is still finishing
its own one-time terminal handshake (a kitty-keyboard-protocol capability
query it sends at startup). A prompt typed into that short window can
visibly land in the input box while the trailing Enter keystroke is
swallowed by that handshake: the pane looks ready, the task text sits there,
but no turn ever starts. This surfaced as a sporadic real-world symptom — a
fresh subagent pane showing an unsent prompt until someone manually pressed
Enter. This only threatens the child's very *first* prompt: by the time any
later steering message is sent (`control.sendMessage`, mapped to `agent
prompt` in the table above), the child has already finished that one-time
handshake, so those calls stay the original fire-and-forget `agent prompt`
with no confirmation.

Herdr documents this exact failure mode: a confirmed `agent prompt --wait`
reports `agent_prompt_stalled` when it does not observe the pane leave idle
within its own 5-second window.

`submitInitialPrompt()` in `src/herdr-backend.ts` guards only that first
prompt:

1. Submit with `agentPrompt(name, text, { confirmWithinMs: 8000 })` — 8s
   gives slack over Herdr's fixed 5s stall check so a real stall surfaces as
   `agent_prompt_stalled` rather than our own generic CLI timeout.
2. On `agent_prompt_stalled` (`isHerdrPromptStalled()`), send a corrective
   `agentSendKeys(name, ["enter"])`: the pane was idle when the stall fired,
   so the terminating Enter is the most likely thing that was lost. There is
   no re-check of pane state right before the keystroke and no confirmation
   afterward — deliberately kept minimal; see "Known limitations" for what
   that trades away.

Only the child's very first prompt goes through this ladder. Later steering
messages (`control.sendMessage`, mapped to `agent prompt` with no confirm
mode) stay exactly as fire-and-forget as before: the race is specific to
pi's one-time startup handshake, which has already finished by the time any
steering message can be sent.

### Rejected alternative: task text via argv

An earlier version of this fix moved the task into pi's own CLI argv instead
of recovering from the typed-prompt race: pi's `[messages...]` positional
(`pi [options] [--] [messages...]`, documented in pi's `usage.md`) is
submitted automatically once the TUI is ready, entirely inside pi's own
process, so no typed keystrokes would ever cross the pty for the first
prompt — removing the race by construction rather than recovering from it.

This was rejected after live testing against the real binary: Herdr rejects
any `agent start` argv value containing a newline with
`invalid_agent_argument: agent arguments cannot be encoded safely for the
target shell`, before the child ever starts. (Shell metacharacters —
backtics, `$(...)`, quotes, pipes, semicolons — are all safely escaped;
only embedded newlines are rejected outright.) Real subagent task
descriptions are routinely multi-line, so this would have traded a rare
"prompt sits unsent" bug for a much more common "subagent refuses to start"
bug. A `@file`-based variant (writing the task to a temp file, passing
`@path` as the positional, reusing the same mechanism as
`--append-system-prompt`) was also verified live to handle arbitrary content
including newlines, but it changes what the model sees: pi wraps file
content as `<file name="...">...</file>` in the first message instead of
delivering it as a plain instruction, a real framing change from how the RPC
backend (`src/runner.ts`, `sendCommand(taskText, "prompt")`) delivers the
same task today. Recovering from the typed-prompt race, as implemented
above, was chosen instead because it preserves that plain-message framing
and every task shape (including multi-line and arbitrary-content tasks)
with no new argv-encoding constraints.

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
  honored mid-spawn — the backend checks it after every top-level startup
  step (split, start) and closes any half-created pane — but an abort from
  the inspector's `x` key during the multi-second Herdr startup window
  (split → start → prompt) can only mark the instance aborted; the spawn may
  still finish and later complete. The RPC backend has the same race with a
  much smaller window.
- **The Enter-nudge recovery is unverified against a real stall, and sent
  blind.** A genuine `agent_prompt_stalled` was never observed in dozens of
  live spawn attempts during development of this fix, so the nudge path
  itself is exercised only against a fake `HerdrClient` in
  `herdr-backend.test.ts`, not a captured live trace. The original root
  cause (pi's kitty-keyboard-protocol startup handshake racing a typed
  Enter) is likewise inference from reading pi's and Herdr's code/docs.
  There is also no re-check of pane state between the stall verdict and the
  keystroke: on a fast turn that both started and finished inside Herdr's
  5-second sampling window, a false stall could still be reported, and the
  nudge would then land as a stray Enter on whatever the pane shows a
  moment later (normally harmless against an idle/empty composer, but not
  verified against every possible state, e.g. an unrelated dialog).
- **Requires a Herdr version with `agent prompt --wait` and `agent
  send-keys`.** Verified against 0.9.0. `agent prompt --wait` was verified
  absent on 0.8.2 (this backend's earlier baseline, before `--wait` existed
  on `agent prompt`); confirm mode there would fail because the plain-text
  usage error Herdr emits for an unrecognized flag is not the `{error:...}`
  JSON envelope this backend expects, surfacing to the operator as an
  opaque parse/CLI failure on every single spawn rather than a clear
  version message. There is no runtime feature detection or version check
  for this.
- **Managed hook load is part of startup.** The resolver skips an absent hook,
  but Pi treats an explicit `-e` path that disappears or fails to load as a
  startup error. The backend surfaces that error and closes the pane instead
  of silently launching a child with inaccurate status; this protects against
  hiding a broken or version-incompatible Pi installation.
- **Agent prompt rides in argv.** `herdr agent prompt` passes the task text
  as a single argv; extremely large task texts are bounded by ARG_MAX.
- **Pane death is not classified as crash vs user-kill.** Both resolve as a
  terminal `closed`/`failed` result (never success); an interrupted-last-turn
  resolves as `closed` rather than as a successful result.
- **Unreachable Herdr server.** After 3 consecutive pane-poll failures the
  monitor settles the task as an error rather than wedge forever.
- The golden fixture `src/fixtures/real-pi-session.jsonl` (real entries,
  strings truncated) pins the JSONL contract; regenerate it from live sessions
  if pi's on-disk format changes.
