# Tool Expansion VFLO

A Pi extension for toggling one tool output at a time with an unmodified primary-button click on its header in fullscreen TUI mode.

Pi continues to own terminal mouse tracking; the extension only observes complete SGR reports and consumes a click after it matches a visible tool header.

## Installation

Install the package by its local path so Pi adds it to `~/.pi/agent/settings.json`:

```bash
pi install /absolute/path/to/tool-expansion
```

Then run `/reload` in an existing Pi session, or restart Pi. Merely opening this repository does not load the extension. For a one-off test without installing it, start Pi with:

```bash
pi -e ./src/index.ts --tui-mode fullscreen
```

## Usage

Click the first visible content row (the header) of a tool box to toggle only that tool. `Ctrl+o` remains Pi's global expand/collapse action and clears per-tool click overrides.

## Compatibility

This extension targets Pi `0.84.x` and uses feature-detected private fullscreen TUI fields for input-listener ordering and layout hit-testing. If those fields change, the extension fails closed and leaves normal Pi input intact.

Regular TUI mode, output-body clicks, persisted expansion state, and direct mouse-mode management are intentionally unsupported. `Ctrl+o` remains Pi's global expand/collapse action and clears per-tool click overrides.
