# Sidebar VFLO design

## Goal

Sidebar VFLO is a small Pi extension that provides a right-hand, width-reserving sidebar while leaving Pi's footer untouched. It uses the same split-pane strategy as `pi-atelier` (a non-capturing overlay plus renderer/layout adaptation), but does not install a footer, status rail, working indicator, or editor replacement.

The extension is intentionally independent of pi-atelier's runtime state. `pi-atelier` is the reference implementation for the dock mechanics; Sidebar VFLO owns its seven panels and its configuration.

## Blocks

The sidebar has seven independently toggleable panels, in this order:

1. **Model** — provider/model identifier and current thinking level.
2. **Context** — current context-window tokens, capacity, a fill bar, and percentage. Pi can report unknown tokens/percentage immediately after compaction, so the panel displays `?` rather than inventing a value.
3. **Limits** — subscription rate-limit buckets for the current provider (e.g. the 5-hour and weekly windows used by Anthropic and OpenAI Codex, or GitHub Copilot's monthly premium-request quota), each as a label, a remaining-percentage figure, and its own meter bar. Unlike the Context bar, which fills as usage grows, each Limits bar *empties* as the remaining allowance shrinks. The panel is hidden **only** when the provider has no subscription semantics (plain API-key billing). For a subscription provider the panel is always shown: when numbers are missing or stale it renders a short status note (`Waiting for usage data…`, `8m ago`, `refresh failed: …`) instead of disappearing, because a silently vanishing panel hides real failures.
4. **Session usage** — cumulative assistant usage reconstructed from the current session branch: input, output, cache-read, and cache-hit percentage. Cache hit is `cacheRead / (input + cacheRead + cacheWrite)`.
5. **Todos** — the latest valid `@juicesharp/rpiv-todo` tool snapshot. In-progress and pending tasks appear before recent completed tasks, so the collapsed 8-item list keeps current work visible. Completed tasks disappear from the sidebar after five *subsequent* completed agent turns; the source todo list stays intact. Click the panel (fullscreen TUI mode only) to expand the remaining visible list.
6. **Subagents** — tasks observed from `subagents-vflo`'s `subagent` tool events.
7. **Diff** — uncommitted changes in the session's git repository: a summary line (`N files  +A -R`, additions green, removals red) and one row per file with its own counts. Collapsed to 5 files by default; click the panel (fullscreen TUI mode only) to list all files. See "Diff panel" below.

Panels are width-safe and height-aware. Model and context are required when enabled; lower-priority panels (including Limits) may be omitted when the terminal is too short to render all enabled content. All rendered lines are truncated/padded to the overlay width.

## Lifecycle and rendering

- The extension factory only registers handlers and commands.
- `session_start` loads user configuration and, in TUI mode, starts one persistent `ctx.ui.custom()` overlay.
- The overlay is anchored at `top-right`, is non-capturing, and uses a copied/adapted `SplitPaneController` from pi-atelier to reserve the sidebar width in both regular and fullscreen Pi renderers.
- `session_shutdown` closes the overlay and restores the renderer/layout root. No footer API is called at any point.
- Events update in-memory state and request a TUI render. There are no filesystem watchers. The only subprocess is `git`, run for the Diff panel on specific events (see "Diff panel" below).
- One bounded, session-scoped timer polls subscription/limits data while the sidebar is visible (see "Subscription/limits refresh" below); it is the extension's only background timer and it is always cleared before the process could be kept alive by it.
- One passive terminal-input listener observes already-flowing mouse reports in fullscreen mode to support Todos-panel click-to-expand (see "Todos click-to-expand" below); it never enables terminal mouse tracking itself.

The default width is 44 columns, constrained to 28–72 by the split controller. The pane automatically disappears when the terminal cannot preserve the minimum main content width. The `alt+s` shortcut and `/sidebar [show|hide|toggle]` control visibility. There is deliberately no keyboard shortcut to expand panels; expansion is click-only.

## Refresh cadence

- **Context** — `ctx.getContextUsage()` is re-derived fresh on every render, so the panel is only as current as the last render pass. To keep it visibly live, the extension requests a render on every context-adjacent lifecycle event it can observe: `agent_start`, `turn_start`, `turn_end`, `before_provider_request`, `message_start`, `message_update`, `message_end`, `agent_end`, `agent_settled`, `tool_execution_start/update/end`, `tool_result`, `session_compact`, and `session_tree`. There is no dedicated "context changed" event in Pi's extension API, so this list is deliberately broad rather than exhaustively precise.
- **Limits (subscription usage)** — the sidebar performs **no** provider request. Provider usage endpoints are rate limited hard (Anthropic's `/api/oauth/usage` answers `429` to a second call made a few seconds after the first, and stays locked out for minutes), so a second poller does not get its own copy of the data — it makes both pollers fail at random. `pi-usage-vflo` is therefore the single owner of the network call: it publishes every success and every failure to `~/.pi/agent/usage-vflo-shared.json`, and the sidebar only reads that file, on `session_start`, on `model_select`, and on a 30-second timer while the sidebar is visible. Reading a small local file is cheap, so the cadence is about how fast the panel picks up data the usage extension already fetched (it refreshes every 5 minutes). The timer is `unref`'d (never keeps the process alive on its own), is cleared whenever the sidebar is hidden or the session ends, and is not restarted until the sidebar becomes visible again. It also stops for providers without subscription semantics, whose limits can never exist.

## Diff panel

The panel shows what `git diff HEAD` plus `git status` would show, for the whole repository that contains the session folder:

- **Tracked changes:** `git --no-optional-locks diff --numstat -z --no-renames HEAD`. This covers staged and unstaged changes. In a new repository without a commit, `HEAD` does not exist, so the command is repeated against git's empty tree. `--no-optional-locks` stops git from rewriting the index in the background, which could make the agent's own git commands fail with `index.lock exists`. `--no-renames` keeps one path per record (a rename shows as one deleted and one added file).
- **Untracked files:** `git ls-files --others --exclude-standard -z --full-name :/`. These are listed with the label `new`, but their lines are **not** counted: counting would mean reading every new file on every refresh, and an un-ignored build folder could make that slow. So the `+` total does not include lines in new files. Binary files show `bin` and also add no lines.
- **Not a repository / git missing / git timeout (5 s):** the panel is hidden. It never shows "No changes" when it cannot know.

Refresh happens on `session_start`, after each `edit`, `write`, or `bash` tool ends, on `agent_settled`, when the sidebar becomes visible, and when the panel is switched on in settings. There is no timer, so changes made outside pi appear at the next of these events. Only one git refresh runs at a time; a request made during a refresh runs once when it ends. No refresh runs while the sidebar is hidden or the panel is disabled.

## Click-to-expand (Todos and Diff)

The Todos panel caps its list at 8 items and the Diff panel at 5 files by default. Clicking anywhere on either rendered panel toggles it between the capped and full list. This works in fullscreen TUI mode only; there is no keyboard alternative, so in regular TUI mode both panels stay collapsed.

The click path only works in Pi's fullscreen (alt-screen) renderer, because that is the only mode where Pi already enables terminal mouse reporting for its own scrolling/selection handling. Sidebar VFLO never calls the terminal mouse-tracking escape sequences itself; it registers a passive `ctx.ui.onTerminalInput` listener that only inspects SGR mouse reports Pi's own renderer is already emitting, and it only ever consumes a report that both (a) is an unmodified primary-button press and (b) lands within the last-rendered bounds of the Todos or Diff panel — every other report (motion, release, wheel, modified clicks, clicks outside the panel, or any click while a real capturing dialog like the `/sidebar` settings menu is open) passes through completely untouched. In regular (non-fullscreen/scrollback) TUI mode, Pi does not enable mouse tracking, so native terminal text selection and copy/paste are unaffected there, and the click path is intentionally a no-op.

A private-field feature check (`prioritizeInputListener` in `src/input-priority.ts`, vendored from the sibling `tool-expansion` extension) re-orders Pi's internal fullscreen input-listener set each render so the sidebar's click handler observes the mouse report before Pi's own viewport listener does. If a future Pi version changes that private shape, the check fails closed (returns `false`) and the click path silently becomes a no-op and the panels stay collapsed.

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
    "context": true,
    "limits": true,
    "usage": true,
    "todos": true,
    "subagents": true,
    "diff": true
  }
}
```

The `/sidebar` settings menu changes panel visibility and color presets. The `monokai` preset uses the Sonokai Andromeda palette from the configured Neovim theme. `/sidebar-reset` restores defaults. Invalid or missing configuration falls back to defaults; values are clamped and unknown panel keys are ignored.

## TODO integration

The rpiv-todo persistence envelope is read from `tool_result` events and reconstructed from valid `todo` results on `session_tree`/`session_start`. Malformed, errored, or unknown-status results do not overwrite the last state; a valid empty task list clears it. The sidebar also replays assistant messages and valid todo snapshots on the current branch to restore each task's completion age after navigation or reopening. Successful live `turn_end` events advance the age; failed or aborted assistant responses do not count, and the completing turn itself is not counted. Repeated snapshots do not renew a completion's age. Reopening or removing a task clears its age; a later completion starts fresh. This filtering changes only the sidebar, never rpiv-todo's stored list or the tool's model-facing result. The sidebar's completion count describes the visible list, while the tool-result summary still describes the full source list.

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
