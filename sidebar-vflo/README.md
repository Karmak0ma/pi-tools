# Sidebar VFLO

Configurable Pi right sidebar with model, activity, context, subscription limits, cumulative usage, TODOs, and subagent panels. It intentionally does **not** install a footer.

For supported consumer subscriptions, a dedicated Limits panel shows one meter bar per rate-limit window — for example the separate 5-hour and weekly windows used by Anthropic and OpenAI Codex. Each bar empties as the window's remaining allowance shrinks.

The sidebar never calls the provider usage endpoints itself; those endpoints rate limit hard, and a second caller only makes both callers fail. The `pi-usage-vflo` extension owns the request and publishes its results to `~/.pi/agent/usage-vflo-shared.json`; the sidebar reads that file every 30 seconds while it is visible. **`pi-usage-vflo` must be installed and enabled**, otherwise the panel stays empty and says so. When numbers are missing or stale the panel shows a short note (`Waiting for usage data…`, `8m ago`, `refresh failed: …`) instead of disappearing. Unsupported/free providers such as OpenCode show no Limits panel at all.

The Todos panel shows up to 8 items by default. Click the panel (fullscreen TUI mode) or press `Alt+T` (any TUI mode) to expand it to the full list.

## Install

From this repository:

```sh
pi install ./sidebar-vflo
```

After publishing, install the package with its npm name. The extension entrypoint is `src/index.ts`.

## Commands

- `/sidebar` opens the interactive settings menu for panel visibility and color preset
- `/sidebar [show|hide|toggle]` controls dock visibility
- Color presets: `monokai` (Sonokai Andromeda, matching the configured Neovim theme), `catppuccin`, and `dracula`
- Context usage is accent-colored through 40%, yellow from >40% through 60%, and red above 60%.

- `/sidebar-reset`
- `Alt+S` toggles the dock.
- `Alt+T` expands/collapses the Todos panel; the panel is also clickable in fullscreen TUI mode.

Configuration is saved in `~/.pi/agent/sidebar-vflo.json`. See [DESIGN.md](./DESIGN.md) for lifecycle, data contracts, TODO suppression, and subagent status mapping.
