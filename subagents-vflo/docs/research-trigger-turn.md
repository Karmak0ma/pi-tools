# Pi `before_agent_start` and extension-triggered runs

## Pi 1.2.0 behavior

The installed Pi version is 1.2.0 (`pi --version`). In this release, `before_agent_start` also runs when `pi.sendMessage(..., { triggerTurn: true })` starts a run while Pi is idle.

The event is a discriminated union:

- `messageType: "user"` covers submitted prompts and `pi.sendUserMessage()`. It carries `prompt` and optional `images`.
- `messageType: "custom"` covers an idle `pi.sendMessage(..., { triggerTurn: true })` run. It carries the starting `message`; it has no `prompt`.
- A handler may return a message for either kind of run. Handlers that only process user prompts must check `event.messageType === "user"`.

Pi also counts a run as busy during startup, including the compaction check and `before_agent_start`. `ctx.isIdle()` is false during this window. `pi.sendMessage()` called then queues into the starting run instead of trying to start a competing run. An abort requested during startup takes effect once the run starts.

Sources: [Pi Extensions docs, “Events and concurrency”](https://pi.dev/docs/latest/extensions#events); installed package `@earendil-works/pi-coding-agent` 1.2.0, `CHANGELOG.md` (“Breaking Changes”) and `dist/core/extensions/types.d.ts` (`BeforeAgentStartEvent`).

## Relevance to subagents-vflo

- The extension already sends asynchronous child results from `src/index.ts::pushBackgroundResults` using `pi.sendMessage` with `{ triggerTurn: true, deliverAs: "followUp" }`. Therefore, when the parent is idle, the result-triggered parent run now goes through `before_agent_start`. Any loaded hooks that modify prompt sections, tools, or guidelines can apply to that run too.
- This repository does not register a `before_agent_start` handler. No new handler or code change is needed for the extension's current behavior. A future result-specific hook could inspect the custom message, but it must not assume `event.prompt` exists.
- Startup concurrency changes delivery timing: a second result message arriving while a trigger run is still starting joins that run, rather than waiting for a later turn. This does not change `BackgroundDeliveries`' exactly-once bookkeeping, but the comment above `pushBackgroundResults` should describe this startup case as well as ordinary busy-turn follow-up.
- `asyncAvailable()` in `src/index.ts` requires `ctx.mode === "tui"` and nesting depth zero. A Herdr child has positive nesting depth, so it cannot use this extension's async push path.

## Relevance to the Herdr backend

The Herdr backend starts a separate Pi TUI with `herdr agent start`, then submits the task through `herdr agent prompt` (`src/herdr-backend.ts::startHerdrAgent` and `submitInitialPrompt`; `src/herdr.ts::HerdrCli.agentPrompt`). That is a normal prompt path, not an extension-triggered `pi.sendMessage` run. This changelog item does not change child startup or require a Herdr-backend change.

The installed managed Herdr Pi extension, `/home/vflores/.pi/agent/extensions/herdr-agent-state.ts`, subscribes to `session_start`, `agent_start`, and `agent_settled`; it does not subscribe to `before_agent_start`. The new hook behavior therefore does not directly change its status reporting.

## Practical guidance

No code change is recommended for this feature alone. Existing user extensions with `before_agent_start` should handle both event variants. For subagents-vflo, clarify the `pushBackgroundResults` timing comment when making a related edit; keep the current `triggerTurn` and `deliverAs: "followUp"` behavior unless a separate delivery-policy change is intended.
