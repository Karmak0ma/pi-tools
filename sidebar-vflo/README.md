# Sidebar VFLO

Configurable Pi right sidebar with model, activity, context, cumulative usage, TODOs, subagent panels, and optional subscription allowance. It intentionally does **not** install a footer.

For supported consumer subscriptions, the model panel can show the minimum remaining percentage reported by `@narumitw/pi-usage` (currently OpenAI Codex and GitHub Copilot). Unsupported/free providers such as OpenCode show no subscription row.

## Install

From this repository:

```sh
pi install ./sidebar-vflo
```

After publishing, install the package with its npm name. The extension entrypoint is `src/index.ts`.

## Commands

- `/sidebar` opens the interactive settings menu for panel visibility and color preset
- `/sidebar [show|hide|toggle]` controls dock visibility
- Color presets: `monokai`, `catppuccin`, and `dracula`
- Context usage is accent-colored through 40%, yellow from >40% through 60%, and red above 60%.

- `/sidebar-panel <model|activity|context|usage|todos|subagents> [on|off|toggle]`
- `/sidebar-reset`
- `Alt+S` toggles the dock.

Configuration is saved in `~/.pi/agent/sidebar-vflo.json`. See [DESIGN.md](./DESIGN.md) for lifecycle, data contracts, TODO suppression, and subagent status mapping.
