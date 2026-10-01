# monokai-vflo

Pi package with Victor's Monokai theme and custom assistant layout, reconstructed
from the four images in `/mnt/c/Users/Victor/Desktop/monokai`.

## Install and select

```sh
pi install ~/repos/pi-tools/monokai-vflo
```

Start a new interactive Pi session, then use `/settings` to select
`monokai-vflo`. Installation makes the theme available; it does not select it
or change other Pi settings automatically.

For a one-session preview without changing package settings:

```sh
pi -e ~/repos/pi-tools/monokai-vflo
```

The package contains:

- `themes/monokai-vflo.json`: the variables, token mappings, and HTML-export
  backgrounds from `unnamed.jpg` and `unnamed2.jpg`, with the tool-background
  adjustments described below.
- `index.js`: the assistant layout shown in `unnamed3.jpg` and
  `1000065168.jpg`. Assistant text uses `customMessageBg`; thinking uses
  `toolPendingBg`, a bold `thinkingMedium` heading, and italic `thinkingText`.
  Both boxes have one column and one row of padding. A one-column `success`
  border (`│`) sits on the left. Abort/error notices and OSC zone markers
  retain the original handling.
- `package.json`: new packaging, since no package manifest was shown.

The JavaScript imports use `pathToFileURL` instead of concatenating `file://`
strings. This preserves the photographed behavior while supporting installation
paths with spaces and Windows drive letters. Added code comments explain the
original decisions. The photographed layout has not been redesigned.

## Windows Terminal palette

`windows-terminal-monokai.json` translates the foreground, background, cursor,
and all 16 ANSI colors from `kitty.jpg` into a Windows Terminal color-scheme
object. It does not change terminal settings automatically. Selection colors
are omitted because the screenshot does not specify them.

Open Windows Terminal Settings, then **Open JSON file**. Add this object to the
existing top-level `schemes` array without replacing other schemes. Select
**Monokai VFLO** under the Ubuntu profile's **Appearance → Color scheme** and
save. For the closest font match, install `JetBrainsMonoNL Nerd Font Mono` on
Windows and select it for the profile at size 10. Keep opacity at 100% and acrylic
off when comparing colors; transparent backgrounds depend on what is behind the
window and cannot reproduce a fixed palette.

The palette controls terminal-default and ANSI colors, not Pi's explicit RGB
panel colors. Matching it is a separate step from tuning the Pi theme. Identical
`TERM=tmux-256color` and `COLORTERM=truecolor` values also do not prove that tmux
passes RGB sequences unchanged.

## Tool-background contrast

Tool panels use lighter, state-specific backgrounds so they stand out from the
surrounding dark areas without changing user-message or assistant-text colors:

| State | Original | Current |
|---|---|---|
| Running | `#2b2d3a` | `#3c4052` (blue) |
| Success | `#313b42` | `#3c4c43` (green) |
| Error | `#3b383e` | `#523c45` (red) |

The colors remain separate variables even where the originals matched message
backgrounds. This keeps the change limited to tool states. Thinking boxes also
use `toolPendingBg` in the original layout, so they share the lighter running
background. Text colors and HTML page/card backgrounds remain unchanged.

## Compatibility and limits

This is a reconstruction of the original extension, not a new renderer design.
It replaces `AssistantMessageComponent.prototype.render` and `updateContent`.
The component's private fields and the installed CLI's directory layout are
required. Pi upgrades can break this extension even though the theme still
loads. Host packages are peers, not bundled runtime dependencies, because a
separate copy of the assistant class would not patch the running application.

The layout patches affect all assistant messages while this extension is loaded,
including when another theme is selected. The extension captures `ctx.ui.theme`
at session start, exactly as photographed. Theme changes depend on the host's
live theme behavior; restart Pi if existing colors do not update.

The photographed renderer replaces Pi's normal content-building logic. Current
host features not present in the screenshots, such as clickable per-run thinking
toggles, Markdown transformers, configurable assistant output padding, and the
length-stop warning, are not retained. Global thinking hiding still uses the
host's `hideThinkingBlock` and `hiddenThinkingLabel` fields.

The original render cache compares only width, line count, and the first,
second, middle, and last lines. An edit to an unsampled line can therefore reuse
stale decoration. At a terminal width of one column, the original minimum
content width plus the border also exceeds the available width. Both limits are
retained to avoid an unrequested change to the reconstructed logic.

Restart Pi after enabling, disabling, or updating this extension. Its prototype
patches have no unload hook, and `/reload` can stack a new border patch on the old
one. This is also how the photographed extension works.

The theme intentionally leaves newer optional color tokens unspecified. Pi
supplies its documented fallbacks rather than invented screenshot values.

## Validation

Checked against installed Pi 0.99.1: JavaScript syntax, theme loading through
Pi's own loader, host imports, manifest resource paths, text/thinking rendering,
hidden thinking, normal-width wrapping, OSC markers, repeated session start,
empty content, and abort/error ownership. An independent screenshot comparison
found no transcription mismatches. No live interactive visual comparison on the
other computer was possible.
