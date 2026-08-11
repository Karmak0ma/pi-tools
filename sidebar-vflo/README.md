# Sidebar VFLO

Configurable Pi right sidebar with model, activity, context, cumulative usage, TODOs, and subagent panels. It intentionally does **not** install a footer.

## Install

From this repository:

```sh
pi install ./sidebar-vflo
```

After publishing, install the package with its npm name. The extension entrypoint is `src/index.ts`.

## Commands

- `/sidebar [show|hide|toggle]`
- `/sidebar-panel <model|activity|context|usage|todos|subagents> [on|off|toggle]`
- `/sidebar-reset`
- `Alt+S` toggles the dock.

Configuration is saved in `~/.pi/agent/sidebar-vflo.json`. See [DESIGN.md](./DESIGN.md) for lifecycle, data contracts, TODO suppression, and subagent status mapping.
