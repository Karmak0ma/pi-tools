# Sidebar VFLO design

## Goal

Sidebar VFLO is a small Pi extension that provides a right-hand, width-reserving sidebar while leaving Pi's footer untouched. It uses the same split-pane strategy as `pi-atelier` (a non-capturing overlay plus renderer/layout adaptation), but does not install a footer, status rail, working indicator, or editor replacement.

The extension is intentionally independent of pi-atelier's runtime state. `pi-atelier` is the reference implementation for the dock mechanics; Sidebar VFLO owns its six required blocks and its configuration.

## Blocks

The sidebar has six independently toggleable panels, in this order:

1. **Model** — provider/model identifier and current thinking level.
2. **Activity** — ready/working state, current activity label, and active tool names.
3. **Context** — current context-window tokens, capacity, a fill bar, and percentage. Pi can report unknown tokens/percentage immediately after compaction, so the panel displays `?` rather than inventing a value.
4. **Session usage** — cumulative assistant usage reconstructed from the current session branch: input, output, cache-read, and cache-hit percentage. Cache hit is `cacheRead / (input + cacheRead + cacheWrite)`.
5. **Todos** — the latest valid `@juicesharp/rpiv-todo` tool snapshot, including pending, in-progress, and completed tasks.
6. **Subagents** — tasks observed from `subagents-vflo`'s `subagent` tool events.

Panels are width-safe and height-aware. Model, activity, and context are required when enabled; lower-priority panels may be omitted when the terminal is too short to render all enabled content. All rendered lines are truncated/padded to the overlay width.

## Lifecycle and rendering

- The extension factory only registers handlers and commands.
- `session_start` loads user configuration and, in TUI mode, starts one persistent `ctx.ui.custom()` overlay.
- The overlay is anchored at `top-right`, is non-capturing, and uses a copied/adapted `SplitPaneController` from pi-atelier to reserve the sidebar width in both regular and fullscreen Pi renderers.
- `session_shutdown` closes the overlay and restores the renderer/layout root. No footer API is called at any point.
- Events update in-memory state and request a TUI render. There are no background timers, filesystem watchers, subprocesses, or network resources.

The default width is 44 columns, constrained to 28–72 by the split controller. The pane automatically disappears when the terminal cannot preserve the minimum main content width. The `alt+s` shortcut and `/sidebar [show|hide|toggle]` control visibility.

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
