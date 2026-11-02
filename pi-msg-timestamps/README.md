# pi-msg-timestamps

A small Pi extension that displays local timestamps on transcript items:

- User messages get a subdued faint/italic timestamp at the bottom-right of the rendered message.
- Assistant messages get the same footer. Assistant thinking blocks are not timestamped.
- Tool calls and results keep their existing renderer and get one subdued timestamp at the bottom-right of the tool box. The time is the tool start time, with a blank line before the timestamp.
- The default display is local time only: `HH:mm:ss`.
- No icon is added before the timestamp.

## What Pi supports directly

Pi does **not** currently expose a setting or a general component renderer for ordinary user and assistant messages. Its public extension API has two relevant hooks:

- `registerMarkdownTransformer()` can change the Markdown that Pi renders for user and assistant messages, but it cannot add a separate footer component or control the exact box layout.
- `registerToolRenderer()` can wrap tool call and result renderers, including built-in tools, while delegating to the original renderer.

Therefore this extension uses the closest supported implementation:

- Ordinary message timestamps are appended as display-only Markdown. The extension uses Pi's width-aware transformer context and non-breaking-space padding to place the final line at the right edge of the message. This is not a native message-footer slot. The footer is a plain paragraph, not a blockquote, so Pi does not draw a `│` border beside it.
- Tool timestamps are added as a right-aligned child of the existing renderer. With Pi's normal tool shell, this places them at the bottom-right inside the existing colored box, after an explicit blank line.

This is intentionally implemented with public Pi APIs. It does not monkey-patch Pi internals or replace the transcript renderer.

## Try it

From this repository:

```bash
pi --extension ./pi-msg-timestamps/src/index.ts
```

For a permanent install, install this directory as a local Pi package:

```bash
pi install ./pi-msg-timestamps
```

Pi will discover the extension declared by the `pi.extensions` field in [`package.json`](package.json).

## Configure timestamps

Run this command in interactive Pi:

```text
/timestamp-settings
```

The command lets you choose:

- Date: `off` or `on`.
- Date format when enabled: `YYYY-MM-DD`, `MM/DD/YYYY`, `DD/MM/YYYY`, or a custom pattern.
- Time format: `HH:mm:ss`, `HH:mm`, `h:mm:ss A`, `h:mm A`, or a custom pattern.

Supported custom tokens are:

- Date: `YYYY`, `YY`, `MM`, `M`, `DD`, and `D`.
- Time: `HH`, `H`, `hh`, `h`, `mm`, `m`, `ss`, `s`, `A`, and `a`.

Punctuation and spaces are allowed. For example, turning the date on and choosing `DD.MM.YYYY` plus `HH:mm` produces `02.01.2025 15:04`.

Settings are saved outside the session at `<agent-dir>/pi-msg-timestamps.json`. `<agent-dir>` is `~/.pi/agent` by default and follows Pi's `PI_CODING_AGENT_DIR` override. A missing or invalid settings file falls back to the defaults.

## Timestamp behavior and limitations

- Persisted session entries provide the timestamp for resumed messages and historical tool calls.
- Lifecycle events provide a stable timestamp for new messages while they stream.
- Message matching uses the message role and rendered text because the Markdown transformer does not receive the original message or session-entry ID. If identical messages occur more than once, the newest matching timestamp wins.
- Tool timestamps use Pi's `thinkingText` theme color, faint styling, and italic styling, which matches the subdued visual weight of thinking text. Ordinary messages use ANSI faint/italic styling because `registerMarkdownTransformer()` does not receive the active theme. Terminal extensions cannot change the terminal font size; faint styling only makes the text appear less prominent.
- Ordinary user and assistant messages are changed through `registerMarkdownTransformer()`. Pi does provide the available content width, which allows right alignment through Markdown padding, but it does not provide a native footer component or the active theme to the transformer. Their timestamp therefore cannot use the exact `thinkingText` color function, and unusual Markdown/layout changes in future Pi versions could affect alignment.
- A tool extension that does not provide a renderer cannot be wrapped without recreating Pi's private fallback renderer. Built-in Pi tools and tools with public renderers are covered.
- This extension affects the interactive transcript rendering. It does not add timestamps to model context, JSON output, print output, or exported data.

## Development

```bash
npm install
npm run check
```
