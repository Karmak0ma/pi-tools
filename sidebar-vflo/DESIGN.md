# Sidebar VFLO design

## Goal

Sidebar VFLO is a small Pi extension that provides a right-hand, width-reserving sidebar while leaving Pi's footer untouched. It uses the same split-pane strategy as `pi-atelier` (a non-capturing overlay plus renderer/layout adaptation), but does not install a footer, status rail, working indicator, or editor replacement.

The extension is intentionally independent of pi-atelier's runtime state. `pi-atelier` is the reference implementation for the dock mechanics; Sidebar VFLO owns its seven panels and its configuration.

## Blocks

The sidebar has seven independently toggleable panels, in this order:

1. **Model** — provider/model identifier and current thinking level.
2. **Activity** — ready/working state, current activity label, and active tool names.
3. **Context** — current context-window tokens, capacity, a fill bar, and percentage. Pi can report unknown tokens/percentage immediately after compaction, so the panel displays `?` rather than inventing a value.
4. **Limits** — subscription rate-limit buckets for the current provider (e.g. the 5-hour and weekly windows used by Anthropic and OpenAI Codex), each as a label, a remaining-percentage figure, and its own meter bar. Unlike the Context bar, which fills as usage grows, each Limits bar *empties* as the remaining allowance shrinks. The panel is hidden **only** when the provider has no subscription semantics (plain API-key billing). For a subscription provider the panel is always shown: when numbers are missing or stale it renders a short status note (`Waiting for usage data…`, `8m ago`, `refresh failed: …`) instead of disappearing, because a silently vanishing panel hides real failures.
5. **Session usage** — cumulative assistant usage reconstructed from the current session branch: input, output, cache-read, and cache-hit percentage. Cache hit is `cacheRead / (input + cacheRead + cacheWrite)`.
6. **Todos** — the latest valid `@juicesharp/rpiv-todo` tool snapshot, including pending, in-progress, and completed tasks. Collapsed to 8 items by default; click the panel (fullscreen TUI mode) or press `alt+t` (any TUI mode) to expand it to the full list.
7. **Subagents** — tasks observed from `subagents-vflo`'s `subagent` tool events.

Panels are width-safe and height-aware. Model, activity, and context are required when enabled; lower-priority panels (including Limits) may be omitted when the terminal is too short to render all enabled content. All rendered lines are truncated/padded to the overlay width.

## Lifecycle and rendering

- The extension factory only registers handlers and commands.
- `session_start` loads user configuration and, in TUI mode, starts one persistent `ctx.ui.custom()` overlay.
- The overlay is anchored at `top-right`, is non-capturing, and uses a copied/adapted `SplitPaneController` from pi-atelier to reserve the sidebar width in both regular and fullscreen Pi renderers.
- `session_shutdown` closes the overlay and restores the renderer/layout root. No footer API is called at any point.
- Events update in-memory state and request a TUI render. There are no filesystem watchers or subprocesses.
- One bounded, session-scoped timer polls subscription/limits data while the sidebar is visible (see "Subscription/limits refresh" below); it is the extension's only background timer and it is always cleared before the process could be kept alive by it.
- One passive terminal-input listener observes already-flowing mouse reports in fullscreen mode to support Todos-panel click-to-expand (see "Todos click-to-expand" below); it never enables terminal mouse tracking itself.

The default width is 44 columns, constrained to 28–72 by the split controller. The pane automatically disappears when the terminal cannot preserve the minimum main content width. The `alt+s` shortcut and `/sidebar [show|hide|toggle]` control visibility.

## Refresh cadence

- **Context** — `ctx.getContextUsage()` is re-derived fresh on every render, so the panel is only as current as the last render pass. To keep it visibly live, the extension requests a render on every context-adjacent lifecycle event it can observe: `agent_start`, `turn_start`, `turn_end`, `before_provider_request`, `message_start`, `message_update`, `message_end`, `agent_end`, `agent_settled`, `tool_execution_start/update/end`, `tool_result`, `session_compact`, and `session_tree`. There is no dedicated "context changed" event in Pi's extension API, so this list is deliberately broad rather than exhaustively precise.
- **Limits (subscription usage)** — the sidebar performs **no** provider request. Provider usage endpoints are rate limited hard (Anthropic's `/api/oauth/usage` answers `429` to a second call made a few seconds after the first, and stays locked out for minutes), so a second poller does not get its own copy of the data — it makes both pollers fail at random. `pi-usage-vflo` is therefore the single owner of the network call: it publishes every success and every failure to `~/.pi/agent/usage-vflo-shared.json`, and the sidebar only reads that file, on `session_start`, on `model_select`, and on a 30-second timer while the sidebar is visible. Reading a small local file is cheap, so the cadence is about how fast the panel picks up data the usage extension already fetched (it refreshes every 5 minutes). The timer is `unref`'d (never keeps the process alive on its own), is cleared whenever the sidebar is hidden or the session ends, and is not restarted until the sidebar becomes visible again. It also stops for providers without subscription semantics, whose limits can never exist.

## Todos click-to-expand

The Todos panel caps its list at 8 items by default. Clicking anywhere on the rendered panel — fullscreen TUI mode only — or pressing `alt+t` (both TUI modes) toggles between the capped and full list.

The click path only works in Pi's fullscreen (alt-screen) renderer, because that is the only mode where Pi already enables terminal mouse reporting for its own scrolling/selection handling. Sidebar VFLO never calls the terminal mouse-tracking escape sequences itself; it registers a passive `ctx.ui.onTerminalInput` listener that only inspects SGR mouse reports Pi's own renderer is already emitting, and it only ever consumes a report that both (a) is an unmodified primary-button press and (b) lands within the last-rendered Todos panel's bounds — every other report (motion, release, wheel, modified clicks, clicks outside the panel, or any click while a real capturing dialog like the `/sidebar` settings menu is open) passes through completely untouched. In regular (non-fullscreen/scrollback) TUI mode, Pi does not enable mouse tracking, so native terminal text selection and copy/paste are unaffected there, and the click path is intentionally a no-op — `alt+t` is the only way to expand Todos in that mode.

A private-field feature check (`prioritizeInputListener` in `src/input-priority.ts`, vendored from the sibling `tool-expansion` extension) re-orders Pi's internal fullscreen input-listener set each render so the sidebar's click handler observes the mouse report before Pi's own viewport listener does. If a future Pi version changes that private shape, the check fails closed (returns `false`) and the click path silently becomes a no-op — `alt+t` still works as the universal fallback in both modes.

## Configuration

User configuration is stored at:

```text
~/.pi/agent/sidebar-vflo.json
```

Example:

```json
{
  "showSidebarOnStartup": true,
  "width": 44,
  "panels": {
    "model": true,
    "activity": true,
    "context": true,
    "limits": true,
    "usage": true,
    "todos": true,
    "subagents": true
  }
}
```

The `/sidebar` settings menu changes panel visibility and color presets. The `monokai` preset uses the Sonokai Andromeda palette from the configured Neovim theme. `/sidebar-reset` restores defaults. Invalid or missing configuration falls back to defaults; values are clamped and unknown panel keys are ignored.

## TODO integration

The rpiv-todo persistence envelope is read from `tool_result` events and reconstructed from the latest valid `todo` result on `session_tree`/`session_start`. Malformed, errored, or unknown-status results do not overwrite the last state; a valid empty task list clears it.

When the sidebar is visible and the Todos panel is enabled, the extension clears rpiv-todo's known `rpiv-todos` above-editor widget and replaces successful todo tool output with `done/total done · see sidebar`. This avoids duplicating the list above the chat. If the panel/sidebar is later hidden, rpiv-todo owns restoration on its next successful tool update; rpiv-todo exposes no public restore API, so this limitation is documented rather than importing private state.

## Subagent integration

Sidebar VFLO does not import the private `SubagentTracker`. It observes public Pi tool lifecycle events:

- `tool_execution_start` initializes rows from `args.tasks`.
- `tool_execution_update` consumes live `details.summaries` when available.
- `tool_result` consumes final summaries and marks the run complete.

The source extension currently reports `queued`, `running`, `completed`, `error`, and `aborted`, but does not report `blocked`. Sidebar display maps queued/running to **idle** (not blocked), completed to **done**, and error/aborted to **blocked**. The source status is retained internally for future event-channel integration. A future `subagents-vflo:state` event can be added without changing the sidebar's presentation contract.

## Compatibility and non-goals

- Do not load Sidebar VFLO and pi-atelier's full extension at the same time: both adapt Pi's renderer and create a right dock. Sidebar VFLO does not depend on pi-atelier at runtime; its split-pane source is vendored to avoid relying on pi-atelier private import paths.
- The extension does not replace or restore the footer, customize Pi's working indicator, own model selection, or persist sidebar state into session entries.
- TUI-only rendering is guarded by `ctx.mode === "tui"`; RPC/JSON/print sessions still receive state tracking and TODO result handling without attempting terminal operations.
