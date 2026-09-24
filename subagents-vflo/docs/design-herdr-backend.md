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
   `--session-dir`. Session files land there either flat or below Pi's
   working-directory-derived folders. The watcher scans those ordinary folders
   recursively but prunes nested `pi-subagent-*` roots, which belong to
   descendants and are separate result channels. This keeps each watcher
   isolated while placing persistent child history below the same Pi session
   storage tree as the parent.
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
5. Startup failures are caught synchronously: `pane split` / `agent start` /
   the readiness gate (see "Initial-prompt readiness") / initial
   `agent prompt` reject → spawn rejects → task error. A startup command failure may leave an empty pane → parent
   closes it (`herdr pane close`), best effort.
6. After the initial prompt is accepted, the monitor waits for Herdr to report
   `working` or `blocked`. If neither that state nor an assistant session
   message appears within the startup-activity deadline (30s by default),
   the task fails with a specific startup-timeout message; no corrective key
   is sent. The failed startup closes the pane best effort so a child that
   never began is not left running after the parent gives up. The timeout
   applies after the CLI calls return; each Herdr command's own timeout remains
   the authority while that command is in flight.

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

## Herdr CLI facts (verified against herdr 0.9.0)

- `herdr pane split --current --direction right --ratio 0.5 --cwd <dir>
  --no-focus --env K=V` → `{result:{pane:{pane_id,...}}}`. `--no-focus` prevents
  focus steal. New pane gets its own `HERDR_PANE_ID`, so `--current` inside a
  child pane anchors correctly for recursive grandchild spawns.
- `herdr agent start <name> --kind pi --pane <id> -- <pi args...>` waits until
  the pi TUI is detected (`interactive_ready`). Name rules:
  `[a-z][a-z0-9_-]{0,31}`, unique among live agents. On `agent_not_ready` the
  name stays reserved. **"Ready" does not mean Pi takes input**: see
  "Initial-prompt readiness".
- `herdr agent wait <name|pane> --until <status> --timeout <ms>` waits for
  an observed agent state (`idle`, `working`, `blocked`, `done`, or
  `unknown`). It matches the status only, so it also accepts Herdr's fallback
  guess. The backend uses `--until idle` only as the fallback readiness gate
  for children without the managed lifecycle hook.
- `herdr agent get <name>` → `{result:{agent:{agent_status, ...}}}`. While Herdr
  guesses the state, `screen_detection_skipped` and `agent_session` are
  absent, and `herdr agent explain <name>` shows
  `fallback_reason: default_known_agent_idle_fallback`. When the lifecycle
  hook owns the state, `screen_detection_skipped: true` and `agent_session`
  are present, and `explain` shows
  `screen_detection_skip_reason: full_lifecycle_hook_authority`. These fields
  are not a documented Herdr contract; `docs/smoke-herdr-cli.mjs` checks them.
- `herdr agent prompt <name|pane> <text>` types the text (bracketed paste) and
  presses Enter; it is used in fire-and-forget mode and fails with
  `agent_blocked` if the child sits at a dialog. The backend does not use
  `agent prompt --wait`: its fixed 5s submission observation can race Pi's
  startup handshake.
- `herdr pane get <id>` → `{result:{pane:...}}` or `{error:{code:"pane_not_found"}}`.
- `herdr pane close <id>` kills the process inside the pane.
- Server errors: JSON envelope `{error:{code,message}}`, exit 1; usage errors
  exit 2 as plain text. **The stream is version-dependent**: 0.8.2 was
  documented as stdout, while 0.9.0 writes the envelope to stderr and leaves
  stdout empty (`herdr pane get bogus:pane` → empty stdout, envelope on
  stderr). `parseCliResult()` searches both streams line by line, so no
  caller depends on the stream. It must stay that way: parsing stdout only
  made every error lose its `herdrCode`, which silently disabled pane-death
  classification and turned a recoverable startup condition into a hard
  subagent spawn failure, while the unit tests stayed green because their
  fakes fed envelopes on stdout.

## Initial-prompt readiness and startup deadline

The first task prompt is typed into the child's terminal by
`herdr agent prompt` (bracketed paste, then Enter as a separate write about
300ms later). This only works if Pi's editor already takes input. The
backend must therefore know when Pi is ready, and Herdr's "ready" and
`idle` do not tell it that (see the investigation below).

The startup sequence in `src/herdr-backend.ts` is:

1. `agent start` waits for Herdr to detect an interactive Pi process. This is
   NOT proof that Pi takes input.
2. The readiness gate (`startHerdrAgent`):
   - **With the managed lifecycle hook** (the normal case): poll
     `herdr agent get <name>` every 250ms (`waitForLifecycleHookIdle`) until
     `screen_detection_skipped === true` (the hook owns the state) AND
     `agent_status === "idle"`. The hook sends its first report from Pi's
     `session_start` event. Pi emits `session_start` only after it replaces
     its startup submit handler with the real one, so a hook-owned `idle`
     proves that Enter submits.
   - **Without the hook** (the file is not installed): `agent wait <name>
     --until idle`. This is the old gate. It can still lose the first prompt
     on a slow start, because there is no reliable readiness signal without
     the hook.

   The `agentStartTimeoutMs` setting (60s by default) is one combined budget
   for `agent start` plus the gate. The gate gets only the time left. If the
   hook never reports idle in time, the spawn rejects with
   `Subagent readiness timed out for Herdr agent <name> in pane <pane>: Pi's
   lifecycle hook did not report idle within ...ms (last seen: hook authority
   <bool>, status <status>)` and the pane is closed.
3. `agent prompt <name> <task>` submits the task in fire-and-forget mode.
   The session JSONL remains the authority for the task's result.
4. `HerdrChildMonitor` starts a one-shot startup-activity deadline (30 seconds
   by default). The first observed `working` or `blocked` Herdr state, or any
   assistant session message, cancels that deadline. If neither appears, the
   child result fails with a specific message naming the Herdr agent and pane:
   `Subagent startup timed out for Herdr agent <name> in pane <pane>: did not
   observe working or blocked state after the initial prompt within ...ms`.
   The monitor stops and failed-startup cleanup closes the pane best effort.

The deadline is a notification/backstop, not a recovery attempt. It prevents
a prompt that never starts from leaving the parent request pending forever,
while keeping Herdr status separate from task completion: only a normal
`stop` message in the session JSONL completes the delegated task.

The backend deliberately does **not** use Herdr's confirmed
`agent prompt --wait` mode. Herdr has a fixed 5-second observation window for
that mode, and a stall response does not prove whether the text was
submitted. It also does not send a corrective Enter: the investigation below
shows the root cause is sending too early, and a blind Enter would only hide
that.

### Investigation: "did not observe working or blocked state" (2026-09)

**Symptom.** Sometimes a spawn failed after about 36s with the startup-timeout
message above. The child pane showed the task text in Pi's editor, not
submitted, as if Enter was never pressed. A retry of the same task a few
minutes later succeeded.

**Pattern in the session logs.** The failures came after a long idle period,
and the whole batch failed together (for example 0 of 4 `build` children).
Total time was about 6s of startup plus the 30s deadline.

**Earlier explanations that were wrong or incomplete.**

- "Pi's kitty-keyboard capability query swallows the Enter." This was the
  reason the idle gate was added. The gate did not stop the failures, because
  it passes on the same fallback guess (below).
- A blind corrective Enter, `agent prompt --wait`, the task as an argv
  positional, and the task as an `@file` positional were tried or rejected
  earlier (see this section and "Rejected alternative" below).

**Root cause (reproduced on demand).**

1. Before Pi's lifecycle hook reports anything, Herdr has no real state for
   the agent. For a known agent kind it then says `idle` from a guess:
   `herdr agent explain` shows
   `fallback_reason: default_known_agent_idle_fallback`. A Pi started with
   `--no-extensions` and no hook is still reported "ready" and `idle`
   after about 5s.
2. `herdr agent start` returns "ready" on that guess about 3.9s after
   launch, whether or not Pi has finished loading. `agent wait --until idle`
   then returns within milliseconds, also on the guess.
3. Pi loads all its extensions before it takes terminal input, and installs
   its real submit handler only after that. (While it starts, Pi's editor
   uses a startup submit handler that keeps the text and shows "Startup is
   still in progress".) On a warm start this is done before 3.9s. On a cold
   start (cold disk cache, several children each loading about a dozen
   extensions at the same time) it is not.
4. The prompt is typed while Pi is still loading. The text reaches the
   editor, but the Enter never submits it. The most likely mechanism: the
   terminal changes the carriage return to a line feed before Pi takes
   control of input, and Pi's editor inserts a line feed as a new line.
   The editor shows a blank line after the text, which agrees with this. The
   fix does not depend on this detail.
5. Pi then sits idle with the text in its editor, and the 30s startup
   deadline fails the task.

**Reproduction.** A child extension that blocks Pi's load for 6-8s
(`Atomics.wait` at module load), then the old sequence `agent start` →
`agent wait --until idle` → `agent prompt "/hotkeys"`: 3 of 3 runs left
`/hotkeys` in the editor. At send time `agent get` showed
`screen_detection_skipped: null` and no `agent_session`.

**Fix verification.**

- The same slow start with the hook-authority gate: 3 of 3 submitted. The gate
  opened at 6.6-8.6s instead of 3.9s.
- The real backend (`createHerdrBackend` with `HerdrCli`) against real Herdr
  with an 8s slow load: 2 of 2 tasks (multi-line text) were submitted at about
  8.85s and completed.
- Unit tests pin the gate: the fallback guess and a hook-owned non-idle state
  do not open it; a hook that never takes over fails the spawn and closes the
  pane; without the hook, the old `idle` wait is used.

**Alternatives considered for the fix.**

- *Chosen: gate on hook authority.* The smallest change that removes the
  cause. The risk is that `screen_detection_skipped` is not a documented
  Herdr contract. The check is strict (`=== true`), so if Herdr renames the
  field, every hooked spawn fails with a clear readiness timeout instead of
  losing its prompt without a sign. `docs/smoke-herdr-cli.mjs` checks the
  field against the real binary.
- *A child-side ready file.* A small child extension writes a file on
  `session_start` and the parent waits for it. This does not depend on
  Herdr fields, but it adds a second handshake. It is the fallback plan if
  Herdr changes the field.
- *Deliver the task inside Pi* (a child extension reads a task file and calls
  `pi.sendUserMessage`). No key presses at all; a prototype worked. It needs
  a parent→child file handshake after `agent start`, because `agent start`
  blocks until the agent is idle, and a child that starts its own turn at
  startup would hold `agent start` for the whole turn. This is the most
  robust option, but it is more code than the problem needs now.
- *State-checked Enter retry.* Rejected: it hides the cause, and the stray
  line feed stays in the task text.

### Rejected alternative: task text via argv

An earlier version of this work moved the task into pi's own CLI argv instead
of waiting for idle before using a normal prompt: pi's `[messages...]` positional
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
same task today. The readiness-gate plus startup-deadline approach was chosen
instead because it preserves that plain-message framing and every task shape
(including multi-line and arbitrary-content tasks) with no new argv-encoding
constraints.

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
- **The readiness gate depends on an undocumented Herdr field.** The
  hook-authority gate reads `screen_detection_skipped` from `agent get`
  (verified on 0.9.0). If Herdr renames or removes it, every spawn with the
  managed hook fails with `Subagent readiness timed out ... hook authority
  false`. Run `docs/smoke-herdr-cli.mjs` after a Herdr upgrade.
- **Without the managed hook, the first prompt can still be lost.** The
  fallback gate (`agent wait --until idle`) accepts Herdr's idle guess, so a
  slow Pi start can leave the task unsubmitted in the editor. The startup
  activity deadline then reports it. Install
  `~/.pi/agent/extensions/herdr-agent-state.ts` to avoid this.
- **Requires a Herdr version with `agent get` and `agent wait`.** Verified
  against 0.9.0. There is no runtime feature detection or version check; an
  older Herdr that lacks a command fails startup, and the backend closes the
  leftover pane.
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
