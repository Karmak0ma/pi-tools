# Parent-Mediated RPC Extension UI for Subagents

**Status:** Proposed  
**Target:** `subagents-vflo`  
**Primary use case:** Let a user approve or deny dangerous commands detected by `pi-guardrails` inside an RPC-mode child agent.  
**Broader use case:** Correctly bridge every blocking Pi RPC extension dialog from a child agent to the parent TUI.

## 1. Summary

Subagents run as child Pi processes in RPC mode. Pi RPC supports extension dialogs by emitting an `extension_ui_request` event and waiting for the RPC client to send a matching `extension_ui_response`. The current subagent runner forwards the request as an ordinary event but never presents it or answers it. A child extension such as `pi-guardrails` therefore waits indefinitely when it asks the user to approve a dangerous command.

Add a session-scoped extension UI broker to `subagents-vflo`. The broker will:

1. Receive dialog requests from every live child process.
2. Capture enough child context to let the user make an informed decision.
3. Queue simultaneous requests globally in FIFO order.
4. Present one immediate parent-side modal at a time, even when the inspector is closed.
5. Send an exactly-once response to the child that owns the request.
6. Cancel safely when the child exits, the task is aborted, the session shuts down, or the request times out.

The bridge must support all blocking RPC dialog methods:

- `select`
- `confirm`
- `input`
- `editor`

The bridge must never infer approval, automatically select an affirmative option, or lose the exact option string selected by the user.

## 2. Confirmed product decisions

The following decisions were confirmed with the user:

| Question | Decision |
|---|---|
| Protocol scope | Bridge all blocking RPC extension dialogs, not only guardrails prompts. |
| Presentation | Open an immediate parent modal whether or not the subagent inspector is visible. |
| Concurrent requests | Serialize all requests in a global FIFO queue. |
| Context shown | Show full available context: agent, task, cwd, request text, and active tool arguments such as the exact shell command. |

## 3. Current behavior and root cause

### 3.1 Child launch

`src/runner.ts` launches each child with:

```text
--mode rpc --no-session --no-extensions
```

Extensions explicitly listed in `~/.pi/agent/subagents-vflo_settings.json` are then re-added with `-e`.

### 3.2 Pi RPC UI behavior

In RPC mode:

- `ctx.mode === "rpc"`
- `ctx.hasUI === true`
- `ctx.ui.custom()` returns `undefined`
- `ctx.ui.select()`, `confirm()`, `input()`, and `editor()` emit `extension_ui_request`
- the child waits until stdin receives a matching `extension_ui_response`

### 3.3 Guardrails behavior

`pi-guardrails` first attempts its custom dangerous-command component. Because custom components are unavailable in RPC mode, it falls back to `ctx.ui.select()` with these exact choices:

- `Allow once`
- `Allow for session`
- `Deny`
- `Decline and stop`

The child emits a `select` request and waits.

### 3.4 Missing client responsibility

`src/runner.ts` parses the request and passes it to `onEvent`. `src/index.ts` stores it in `instance.events`, but neither the runner nor the inspector sends a response. The guardrails hook remains suspended, so:

- the shell command does not execute;
- the tool call does not finish;
- the child does not emit `agent_settled`;
- the subagent appears to run forever;
- no approval menu is visible.

This is a missing RPC client feature, not a guardrails detection failure.

## 4. Goals

1. Make blocking child extension dialogs usable from the parent Pi TUI.
2. Preserve guardrails' fail-closed behavior.
3. Display the exact dangerous command whenever it is available in child tool events.
4. Work whether the inspector is open or closed.
5. Handle several children requesting input concurrently without overlapping dialogs.
6. Ensure every request has a clear owner and an exactly-once terminal outcome.
7. Avoid persisting prompt contents, tool arguments, or user-entered secrets in subagent tool-result details.
8. Keep protocol handling independent from guardrails so other child extensions work too.
9. Make the queue and response mapping testable without launching a model.

## 5. Non-goals

1. Reimplement `pi-guardrails` rules or configuration.
2. Add an out-of-band web, Telegram, or filesystem approval channel.
3. Allow approval by steering the language model with a text message.
4. Automatically approve known commands in `subagents-vflo`.
5. Persist approval decisions. `Allow for session` remains guardrails-owned child-process state.
6. Proxy child UI state mutations such as `setTitle`, `setWidget`, or `setEditorText` into the parent UI.
7. Guarantee a one-to-one protocol correlation between a UI request and a tool call. Pi's `extension_ui_request` currently has no `toolCallId`.

## 6. Security invariants

These are implementation requirements, not suggestions.

1. **Fail closed for known dialogs:** malformed, orphaned, or unpresentable requests whose method is known to be blocking must be cancelled or denied; they must never be approved. Unknown future methods remain unhandled because the current protocol does not say whether they are blocking or fire-and-forget; this limitation must produce a visible diagnostic rather than a guessed response.
2. **No default affirmative choice:** Enter may confirm only the visibly selected choice. Initial selection should prefer a non-destructive option when the component supports explicit initial selection. For guardrails, initialize to `Deny`, not `Allow once`.
3. **Exact values:** a `select` response must contain exactly one string supplied in the child request's `options` array.
4. **Visible ownership:** every modal must identify the child agent and task that requested it.
5. **Visible command:** when an active `bash` tool call is available, render its full command without semantic truncation. A viewport may scroll, but the underlying text must remain available.
6. **Terminal-safe display:** task text, request strings, paths, tool arguments, and commands are untrusted display data. Escape ANSI, OSC, APC, C0 control characters other than intended newline/tab layout, and other terminal control sequences before rendering. Preserve the original unsanitized option/value only for protocol responses.
7. **No false attribution:** because the RPC request lacks `toolCallId`, label tool information as `Active child tool calls`, not `Command that caused this prompt`, unless Pi later adds explicit correlation.
8. **Exactly-once settlement:** user input, timeout, abort, and child exit may race, but at most one response may be written for a request. The child-bound channel is the sole authority for wire writes; the broker is the sole authority for modal/queue settlement.
9. **Ephemeral sensitive data:** queued requests, active tool arguments, and input/editor values stay in memory only and are cleared after settlement.
9. **No model-mediated approval:** the child model cannot answer its own extension dialog through steering or another tool call.
10. **No response rerouting:** request IDs are scoped by child. Always key ownership by both `instance.id` and request `id`.

## 7. Proposed architecture

Add four separable responsibilities.

### 7.1 RPC protocol types and validation

Create `src/rpc-extension-ui.ts` with narrow local types for the Pi protocol used here.

```ts
export type ChildExtensionUIDialogRequest =
  | {
      type: "extension_ui_request";
      id: string;
      method: "select";
      title: string;
      options: string[];
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "confirm";
      title: string;
      message?: string;
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "input";
      title: string;
      placeholder?: string;
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "editor";
      title: string;
      prefill?: string;
      timeout?: number;
    };

export type ChildExtensionUIResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };
```

Do not cast every `extension_ui_request` to this union. Add a runtime parser that validates:

- object shape;
- non-empty string ID;
- known blocking method;
- method-specific fields;
- finite, positive timeout when present;
- non-empty `select.options` containing only strings.

The parser should return a discriminated result:

```ts
type ParseResult =
  | { kind: "dialog"; request: ChildExtensionUIDialogRequest }
  | { kind: "fire-and-forget" }
  | { kind: "invalid"; reason: string };
```

Known fire-and-forget methods (`notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`) remain ordinary observable child events. They do not enter the blocking queue and are not mirrored into parent-global UI state in this change.

### 7.2 Runner transport

Extend `RunChildOptions` in `src/runner.ts`:

```ts
onExtensionUIRequest?: (
  request: ChildExtensionUIDialogRequest,
  channel: ChildExtensionUIChannel,
) => void;
```

The channel is bound to one child process:

```ts
export interface ChildExtensionUIChannel {
  respond(response: ChildExtensionUIResponse): boolean;
  forget(requestId: string): void;
  isOpen(): boolean;
}
```

`respond()` must:

1. Verify the process is still alive and stdin is writable.
2. Verify `response.id` matches a request observed from this child.
3. Reject the write if the request has reached its conservative local deadline.
4. Atomically mark that request answered before writing.
5. Write one JSONL record directly to child stdin.
6. Return `false` instead of throwing if the process is already closed, forgotten, or locally expired.

The extension UI response is not a normal Pi RPC command and should not be added to `pendingResponses`, which tracks command acknowledgements for `prompt` and `steer`. Add `channel.forget(id)` so the broker can discard local pending state after Pi's child-owned timeout without writing a response.

Runner event order for a valid dialog request:

1. Parse the child JSON event.
2. Register the request ID as pending on the child channel **before exposing the request to callbacks**.
3. Call the existing `onEvent(event)` so the inspector and diagnostics retain an in-memory observation.
4. Invoke `onExtensionUIRequest(request, channel)`.

The relevant `tool_execution_start` events will already have passed through `onEvent`, so `src/index.ts` can snapshot active tool context in step 4. Add a test that locks down this ordering.

Do not await the parent UI inside the stdout `data` callback. The callback must hand the request to the broker and return so stdout processing continues.

On process close/error:

- mark the channel closed;
- clear its pending request IDs;
- notify the broker through the instance lifecycle described below.

Malformed blocking requests should be reported through `onStderr` or a dedicated diagnostic callback and safely cancelled when their ID is usable. They must not crash the JSONL reader.

### 7.3 Session-scoped broker

Create `src/extension-ui-broker.ts` containing a `ChildExtensionUIBroker`.

There must be one broker per parent extension runtime/session, shared by every subagent invocation and batch. A broker local to a single `subagent` tool execution is insufficient because Pi may execute sibling tool calls concurrently.

Each enqueued item also carries a presenter created from the originating tool execution's `ctx.ui`. That context remains live because the subagent tool call cannot finish while its child is waiting for a dialog. Do not retain or reuse that presenter after its owning tool call settles. On reload/session replacement, the old broker is permanently closed and a new extension instance creates a new broker; stale callbacks close over only the old, closed broker and must be rejected.

Suggested interfaces:

```ts
export interface ChildUIRequestOwner {
  instanceId: string;
  agent: string;
  task: string;
  cwd: string;
}

export interface ActiveChildToolCall {
  toolCallId: string;
  toolName: string;
  args: unknown;
  startedAt: number;
}

export interface QueuedChildUIRequest {
  key: string; // `${instanceId}:${request.id}`
  owner: ChildUIRequestOwner;
  request: ChildExtensionUIDialogRequest;
  activeToolCalls: ActiveChildToolCall[];
  channel: ChildExtensionUIChannel;
  receivedAt: number;
  deadline?: number;
  presenter: ChildUIDialogPresenter;
}

export interface ChildUIDialogPresenter {
  present(
    item: QueuedChildUIRequest,
    signal: AbortSignal,
    queueDepth: number,
  ): Promise<ChildUIDialogDecision>;
}
```

The broker owns:

- a FIFO queue;
- one active item at most;
- one `AbortController` for the active parent modal;
- a set of settled request keys to suppress duplicates and races;
- owner-to-request indexes for efficient child cancellation;
- the asynchronous drain loop.

#### Broker state machine

Each request follows:

```text
received -> queued -> presenting -> responded
                    \-> cancelled
received/queued/presenting -> expired
received/queued/presenting -> orphaned
```

The broker owns these UI/queue states. The child-bound channel independently owns the wire state `pending -> answered|closed|forgotten`. `channel.respond()` performs its pending check and state transition synchronously, with no `await` between them, before writing to stdin. JavaScript's single event loop makes that check-and-set the authoritative exactly-once gate even when presenter completion, abort, and child exit race. Broker settlement calls `respond()` at most once but must still tolerate `false` because the channel may already be closed.

Every terminal state must remove sensitive references from the queue and owner indexes.

#### FIFO semantics

- Order by broker receipt time.
- Do not prioritize the selected inspector tab.
- A request timeout begins when the broker receives it, not when its modal becomes visible.
- Before presenting the next item, discard any expired or orphaned item.
- Show the number of additional queued requests in the modal.

#### Duplicate semantics

If the same `(instanceId, request.id)` is received twice:

- keep the first request;
- record a diagnostic;
- do not open a second modal;
- do not send a second response.

#### Owner cancellation

Expose:

```ts
cancelOwner(instanceId: string, reason: "exit" | "abort" | "shutdown"): void;
```

- Queued items for that child are removed immediately.
- If that child's item is active, abort its modal.
- If the child is alive and cancellation originated in the parent, send `{ cancelled: true }` before or alongside process abort when possible.
- If the child has already exited, do not attempt a write.
- Continue draining requests from other children.

#### Session shutdown

Expose async `dispose()` and use this strict `session_shutdown` ordering:

1. Mark the broker closed so stale child callbacks cannot enqueue.
2. Abort the active modal and send cancellation responses to queued/active requests while child channels are still open.
3. Await modal closure and broker drain cleanup.
4. Exit the inspector.
5. Call and await `tracker.killAll()`.
6. Clear the tracker as the existing lifecycle requires.

`dispose()` must be idempotent. It must not wait for child agents to settle; process termination remains `tracker.killAll()`'s responsibility. Create a fresh broker when the extension runtime is recreated after reload or session replacement, and never assign stale callbacks to that new broker.

### 7.4 Parent dialog presenter

Create `src/extension-ui-presenter.ts` for the production TUI presenter.

Use a parent `ctx.ui.custom()` component rather than trying to render the child component factory. Child `custom()` components cannot cross the RPC boundary, and the parent must add ownership and tool context.

Present the dialog immediately. It must not depend on the inspector being active. If the inspector overlay is active, open the approval component as temporary non-overlay custom UI. Before opening, verify the inspector's overlay handle is focused and visible; this is the condition under which Pi documents that it will reclaim input after temporary custom UI closes. The presenter does not manipulate or replace the inspector's overlay handle. Add an integration-style TUI test that opens the inspector, opens and closes a temporary approval component, and verifies inspector input works afterward.

The component should have these regions:

1. **Risk/interaction header**
   - `Subagent requires input`
   - agent name and instance ID
   - cwd
   - queue count
2. **Task context**
   - full task text in a vertically scrollable viewport
3. **Child request**
   - title
   - optional confirm message or input placeholder
4. **Active child tool calls**
   - tool name and tool-call ID
   - full formatted arguments
   - for `bash`, prominently show the exact `command`
5. **Method-specific control**
   - select list, yes/no confirmation, input, or editor
6. **Key hints**
   - navigation, submit, cancel, and context scrolling

The context area must be scrollable and height-bounded so a large task or multiline command cannot push the decision control off-screen. Width handling must use `wrapTextWithAnsi`, `truncateToWidth`, and `visibleWidth` as appropriate. Visual truncation is acceptable only when the user can scroll to the omitted content.

#### Safe initial focus

- `select`: if an option exactly matches `Deny`, initially select it. Otherwise, select the first option because the protocol provides no safety metadata; do not synthesize or reorder options.
- `confirm`: initialize to `No`.
- `input`: empty unless Pi supplies a protocol value in a future version.
- `editor`: use the supplied `prefill` exactly.

For `select`, preserve the original option order in the displayed list. Moving initial selection to `Deny` must not reorder it.

#### Cancellation

- Escape returns a cancelled decision.
- An aborted presenter signal closes the component without responding affirmatively.
- Closing or hiding the inspector must not cancel the approval modal.
- Parent process/session shutdown cancels it.

#### Timeouts

Pi is authoritative for RPC dialog timeouts: the child auto-resolves the extension call when its own timeout expires. The parent mirrors the deadline only to prevent a stale modal from remaining visible; it must not try to replace Pi's timeout semantics.

When the request has `timeout`:

- record receipt time as soon as the runner parses the event;
- calculate a **conservative local deadline** using less than the full advertised duration, reserving a small transport margin (for example `min(timeout, max(50 ms, timeout * 0.1))`); centralize this calculation so the runner channel and broker use the same deadline;
- if the remaining local duration is already zero, do not present the request;
- show a countdown in the modal;
- use only the remaining duration when an item reaches the front of the queue;
- on local expiry, dismiss the modal, settle the broker item as expired, and call `channel.forget(request.id)` without writing a response;
- never send `cancelled: true` merely because the mirrored parent timer expired;
- ignore presenter completion at or after the local deadline;
- make `channel.respond()` reject writes at or after that same deadline.

The RPC event contains a duration but no child-side start timestamp or timeout-settled event. Therefore perfect synchronization is impossible if stdout or the parent event loop stalls longer than the transport margin. Stale-modal prevention is best-effort under that protocol limitation; safety is preserved because Pi remains authoritative and auto-resolves the child request. A late parent response is locally suppressed whenever detectable and, if a transport stall exceeds the margin, cannot cause Pi to revive an already settled request. A late user keypress after local expiry must have no effect.

## 8. Capturing full child context

### 8.1 Runtime instance changes

Add ephemeral fields to `RuntimeSubagentInstance` in `src/tracker.ts`:

```ts
activeToolCalls: Map<string, ActiveChildToolCall>;
pendingUIRequestCount: number;
```

These fields are runtime-only. Do not add them to `PersistedSubagentToolDetails` or final summaries.

### 8.2 Event tracking

In the common child event handler in `src/index.ts`:

- on `tool_execution_start`, add/update `activeToolCalls`;
- on `tool_execution_end`, remove that ID;
- if a final tool-result event is used as a fallback today, remove it there only when still present;
- on an extension dialog request, snapshot all active calls into the queued item.

Snapshot rather than retaining the mutable map. The tool call may finish, abort, or be replaced while its modal waits in the FIFO queue.

### 8.3 Correlation limitation

Pi's RPC request does not include `toolCallId`. Therefore:

- include all active tool calls for that child at request time;
- sort by `startedAt`, newest first;
- do not claim a specific call caused the request;
- if there are no active calls, display `No active tool context was reported` and still allow the extension dialog to function.

This is intentionally conservative and prevents presenting the wrong command as authoritative.

### 8.4 Display formatting

Tool arguments may be strings, objects, arrays, `null`, or malformed values. Add a safe formatter that:

- extracts a `bash.command` string separately without changing its semantic content;
- escapes terminal control sequences in every displayed string, including the command, while preserving intended newlines and tabs;
- uses guarded `JSON.stringify(args, null, 2)` for other values before terminal sanitization;
- falls back to `String(args)` if serialization throws;
- never writes formatted arguments to disk;
- does not include them in thrown error messages or persisted summaries.

The original unsanitized command remains only in the existing in-memory child event log and the broker snapshot until settlement. `instance.events` is already an in-memory transcript and may retain the raw child events until tracker/session cleanup; this is allowed, but no new persistence or diagnostic serialization of those events is permitted.

## 9. Response mapping

Map presenter decisions to the Pi RPC protocol exactly.

| Request | User action | Response |
|---|---|---|
| `select` | chooses option | `{ type: "extension_ui_response", id, value: option }` |
| `select` | Escape/abort | `{ type: "extension_ui_response", id, cancelled: true }` |
| `confirm` | Yes | `{ type: "extension_ui_response", id, confirmed: true }` |
| `confirm` | No | `{ type: "extension_ui_response", id, confirmed: false }` |
| `confirm` | external cancellation | `{ type: "extension_ui_response", id, cancelled: true }` |
| `input` | submits | `{ type: "extension_ui_response", id, value }` |
| `input` | Escape/abort | `{ type: "extension_ui_response", id, cancelled: true }` |
| `editor` | submits | `{ type: "extension_ui_response", id, value }` |
| `editor` | Escape/abort | `{ type: "extension_ui_response", id, cancelled: true }` |

Do not trim input or editor values. The child extension owns interpretation, and whitespace may be meaningful.

For guardrails, selecting `Allow once` must return that exact string. The bridge must not translate it to a boolean.

## 10. Integration with existing inspector

The approval bridge is independent of inspector visibility, but the inspector should expose waiting state.

Recommended minimal inspector changes:

- Add a `waiting for input` status marker to a tab whose `pendingUIRequestCount > 0`.
- Include the queue count in the task header or status footer.
- Request a render when the count changes.
- Keep existing tab selection, scrolling, steering, and abort behavior unchanged.

The inspector must not become a second place where the request can be answered in this implementation. Having two active controls would violate exactly-once behavior and complicate focus ownership. A future change may add an inspector-native decision UI by replacing the presenter behind the same broker interface.

## 11. Failure handling

### Parent has no usable UI

Although the parent extension normally runs in TUI mode, check `ctx.hasUI` and `ctx.ui.custom` before presenting. If unavailable:

1. send `cancelled: true` when possible;
2. record a concise diagnostic on the runtime instance;
3. continue or abort according to the child extension's response to cancellation;
4. never approve.

### Child exits while queued

Remove its requests. Do not show a stale modal and do not write to closed stdin.

### Child exits while modal is open

Abort and close the modal immediately, then show the next queued request.

### Parent aborts the subagent

Route every per-instance abort through one helper owned by `src/index.ts` (for example, `abortInstance(instance)`) that first calls `broker.cancelOwner(instance.id, "abort")` and then `instance.control.abort()`. Pass this helper into `SubagentTuiManager` rather than letting the manager terminate the process directly.

For the subagent tool execution's shared abort signal, register one listener that calls `cancelOwner` for every instance created by that invocation before `runChild` observes the same signal and terminates processes. Removing that signal listener belongs in the invocation's `finally` block.

This distinction preserves individual inspector aborts while correctly handling one execution-level signal covering a concurrent task batch.

### Response write fails

Mark the request orphaned, close its modal, clear sensitive state, and continue the queue. Do not retry onto a new process or another child.

### Presenter throws

Treat the request as cancelled, notify the user once through the parent UI if possible, and continue draining. A broken modal must not permanently stop the global queue.

### Unknown method

Do not queue it and do not respond. The current protocol does not provide a reliable way to distinguish a future fire-and-forget method from a future blocking method. Keep the raw event in memory for diagnostics, emit a concise method-name warning, and do not persist the event. Only known blocking methods with malformed method-specific fields may be safely answered with `cancelled: true`.

### Malformed `select` options

Cancel. Never invent options.

## 12. Expected file changes

| File | Change |
|---|---|
| `src/rpc-extension-ui.ts` | Protocol types, runtime parser, response builders, type guards. |
| `src/runner.ts` | Detect dialog events and expose a child-bound response channel. |
| `src/extension-ui-broker.ts` | Session-scoped FIFO queue, lifecycle, cancellation, timeout, exactly-once settlement. |
| `src/extension-ui-presenter.ts` | Parent custom modal and method-specific controls. |
| `src/tracker.ts` | Runtime-only active tool calls and pending request count. |
| `src/index.ts` | Create/dispose broker, track tool context, enqueue requests, update inspector state. |
| `src/tui.ts` and/or inspector components | Render `waiting for input` state only; no second response path. |
| `src/rpc-extension-ui.test.ts` | Parser and response mapping tests. |
| `src/extension-ui-broker.test.ts` | Queue, races, timeout, cancellation, and owner isolation tests. |
| `src/runner.test.ts` | JSONL request/response transport tests using an injected/fake child process or fixture. |
| `src/extension-ui-presenter.test.ts` | Safe defaults, exact values, rendering bounds, and cancellation tests. |
| `README.md` | Document child extension UI bridging and guardrails behavior. |

The implementer may split component files further if that improves clarity, but protocol, broker, and presentation responsibilities should remain separate.

## 13. Test plan

### 13.1 Protocol parser tests

1. Accept valid `select`, `confirm`, `input`, and `editor` requests.
2. Distinguish known fire-and-forget requests.
3. Reject missing/empty IDs for known blocking methods.
4. Leave unknown methods unhandled without sending a response.
5. Reject empty or non-string select options.
6. Reject invalid timeouts.
7. Preserve multiline titles, commands, prefill text, and option strings exactly in protocol data.
8. Escape ANSI, OSC, APC, and unsafe C0 controls in display formatting without changing response values.

### 13.2 Broker unit tests

Use a fake presenter and fake child channels.

1. One request is presented immediately.
2. Multiple requests are presented in global FIFO order across different owners.
3. Only one presenter call is active at a time.
4. Selecting an option writes exactly one response to the correct channel.
5. Duplicate request IDs from the same owner do not open duplicate dialogs.
6. Identical request IDs from different owners remain independent.
7. Child exit removes queued requests for only that child.
8. Child exit aborts that child's active modal and advances the queue.
9. Aborting one owner does not cancel another owner's requests.
10. Session disposal cancels everything and is idempotent.
11. Request timeout while queued removes it without presenting, forgets local channel state, and writes no response.
12. Request timeout while active aborts the modal, forgets local channel state, and writes no response.
13. The conservative transport margin can expire a request before the full advertised duration.
14. User response racing timeout produces at most one write and never writes at/after the conservative local deadline.
14. Response write failure does not stall later requests.
15. Presenter failure cancels safely and continues.
16. Sensitive request references are removed after settlement.

Use fake clocks for timeout tests.

### 13.3 Runner transport tests

Prefer extracting the JSONL parsing/transport boundary or injecting `spawn` rather than launching a real model.

1. A child `extension_ui_request` reaches both `onEvent` and `onExtensionUIRequest`.
2. `channel.respond()` emits exactly one newline-terminated JSON object.
3. Extension UI responses do not enter normal `pendingResponses` command tracking.
4. A second response for the same child request is rejected.
5. A response after child close returns `false` and does not throw.
6. A request from child A cannot be answered through child B's channel.
7. `channel.forget()` clears local ownership without writing to stdin.
8. Fire-and-forget UI requests do not enter the broker callback.
9. Malformed JSON does not crash the runner.

### 13.4 Presenter/component tests

1. Guardrails options preserve order and initialize selection to `Deny`.
2. A generic select without `Deny` preserves order and selects the first item.
3. Confirm initializes to `No`.
4. Escape produces cancellation for every method.
5. Input/editor values preserve whitespace.
6. Agent, task, cwd, title, and active tool arguments are rendered.
7. A multiline bash command remains reachable through scrolling.
8. Every rendered line respects the supplied width.
9. Queue count is shown.
10. AbortSignal closes the component.
11. Countdown expiry disables late input.
12. ANSI, OSC, APC, and unsafe control characters are rendered as inert escaped text.
13. Inspector focus returns after a temporary approval dialog closes.

### 13.5 Integration fixture tests

Create a deterministic child extension fixture that requests each dialog method from a tool hook. No LLM or guardrails dependency is needed for protocol correctness.

For each method:

1. fixture emits request;
2. fake parent presenter decides;
3. runner sends response;
4. fixture resumes and records the received value;
5. child reaches `agent_settled` or exits cleanly.

Also run two fixture children concurrently and verify FIFO presentation with owner-correct responses.

### 13.6 Manual guardrails acceptance test

With `npm:@aliou/pi-guardrails` listed in `~/.pi/agent/subagents-vflo_settings.json`:

1. Start a subagent tasked with proposing and executing a harmless command that still matches a dangerous pattern. Use an isolated temporary directory and avoid any command that can affect user data.
2. Verify an immediate parent modal appears.
3. Verify the modal identifies the agent, task, cwd, and exact command.
4. Choose `Deny`; verify the bridge returns the exact `Deny` string to the owning child, then separately verify guardrails interprets it as denial and the command does not execute.
5. Repeat and choose `Allow once`; verify only that request proceeds.
6. Repeat with two children; verify requests appear FIFO and each response reaches the correct child.
7. Abort a child while its request is queued and while it is active; verify no stale modal remains.
8. Open the inspector before the request; verify the modal takes focus and the inspector regains focus afterward.
9. Keep the inspector closed; verify the same modal still appears.

The test command should operate only on disposable fixture paths. Do not use a real broad `rm -rf` target merely to test the UI.

## 14. Acceptance criteria

Implementation is complete when all of the following are true:

1. A guardrails prompt in a child no longer causes an invisible indefinite wait.
2. The user can choose every guardrails option from a visible parent modal.
3. The selected option is returned exactly to the correct child.
4. All four blocking Pi RPC dialog methods work.
5. Dialogs appear with the inspector open or closed.
6. Concurrent requests are serialized globally in FIFO order.
7. The modal displays full available child and active-tool context.
8. Abort, exit, reload, session shutdown, and locally observed timeout leave no stale modal or stuck queue; child timeout synchronization respects the documented best-effort limitation caused by the absence of a child timestamp or settlement event.
9. Malformed known blocking requests fail closed; unknown future methods are diagnosed and left untouched rather than guessed to be blocking.
10. No request content or user-entered value is added to persisted tool details.
11. Unit and integration tests cover owner isolation and exactly-once response races.
12. Existing subagent streaming, inspector navigation, steering, and abort tests continue to pass.

## 15. Implementation sequence

1. Add protocol types, parser, and response builders with unit tests.
2. Add the child-bound response channel in `runner.ts` with transport tests.
3. Add runtime active-tool tracking to the tracker and index event flow.
4. Implement the broker against a fake presenter; complete queue and race tests.
5. Implement the parent dialog presenter and component tests.
6. Wire the broker into `src/index.ts` and session shutdown.
7. Add the inspector waiting-state marker.
8. Add integration fixtures for all four dialog methods and concurrent owners.
9. Update `README.md`.
10. Run the full test suite and the manual guardrails acceptance test.

## 16. Future-compatible considerations

If Pi later adds `toolCallId` or structured origin metadata to `extension_ui_request`, consume it and replace the conservative `all active tool calls` display with exact correlation. Keep the broker API owner-scoped so this can be added without changing queue semantics.

If a future inspector-native approval UI is desired, implement it as another `ChildUIDialogPresenter`. Do not duplicate queue or response ownership logic in the inspector.
