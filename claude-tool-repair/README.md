# claude-tool-repair

Pi extension that repairs a specific Claude failure mode: Claude emits
Claude Code-style `<invoke>` pseudo-XML as text while reporting
`stopReason: "toolUse"`, instead of returning structured tool calls. Without
repair, pi stops the turn with `Provider reported tool use without any tool
calls`.

It also guards against a second, more expensive shape seen on
`claude-*-5-5` models: the model leaks the same pseudo-XML but does not stop.
It writes more and more fake calls until it reaches the 128k output-token
limit (`stopReason: "length"`, about 15 minutes and $1–2.60 per turn). The
guard:

1. Adds the stop sequence `<invoke name="` to Claude requests on the
   `anthropic-messages` API, so Anthropic stops the stream when the leak
   starts. Real tool calls and tool arguments that contain this text are not
   affected (verified live).
2. When a turn ends on that stop sequence, adds a visible nudge message and
   continues automatically, at most 2 times in a row. After that, it shows a
   warning and gives control back to you.

Known cost: a reply that quotes this markup in prose is also cut. The nudge
tells the model to quote it without the leading `<`.

The repair part is intentionally narrow and fail-safe. It only considers
Anthropic/Claude assistant messages that pi would already reject, resolves
invoke names against the live tool registry, and leaves malformed or unsafe
messages unchanged.

## Local configuration

Add this package to both user-level package lists when child subagents must
also receive the repair:

- `~/.pi/agent/settings.json`
- `~/.pi/agent/subagents-vflo_settings.json`

Use this absolute path:

```json
"/home/vflores/repos/pi-tools/claude-tool-repair"
```

The second file is a local `subagents-vflo` allowlist. It is separate from
pi's main package list because child processes start with `--no-extensions`
and receive only explicitly allowed extension entry points.

## Environment controls

The package was renamed from `claude-tool-call-repair` to
`claude-tool-repair`. The environment-variable names below intentionally keep
`TOOL_CALL` so existing settings and forensic scripts continue to work:

- `PI_CLAUDE_TOOL_CALL_REPAIR_DISABLE=1` disables everything (repair and guard).
- `PI_CLAUDE_TOOL_CALL_REPAIR_STOP_DISABLE=1` disables only the stop-sequence
  guard and its automatic retry.
- `PI_CLAUDE_TOOL_CALL_REPAIR_LOG=/path/to/file` enables full forensic logs.

Successful repairs and leaked-text cleanup are silent. An aborted repair may
emit a bounded diagnostic because no repair was applied. Full leaked content is
written only when the opt-in forensic log variable is set.

## Runtime and development dependencies

The extension has no runtime package dependencies. It uses Node built-ins and
pi's injected `ExtensionAPI`; the `devDependencies` in `package.json` are only
for local typechecking and tests. A clean checkout needs `npm install` before
running the development check, but pi does not need this package's ignored
`node_modules/` directory to load the extension.

## Development

```sh
npm install
npm run check
```

This runs the TypeScript check and the regression tests (captured Claude
failure transcripts plus the stop-sequence guard). The dev dependency must be
pi `^1.0.0`: `turn_end` continuation does not exist in the 0.85 types.
