# claude-tool-repair

Pi extension that repairs a specific Claude failure mode: Claude emits
Claude Code-style `<invoke>` pseudo-XML as text while reporting
`stopReason: "toolUse"`, instead of returning structured tool calls. Without
repair, pi stops the turn with `Provider reported tool use without any tool
calls`.

The extension is intentionally narrow and fail-safe. It only considers
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

- `PI_CLAUDE_TOOL_CALL_REPAIR_DISABLE=1` disables repair.
- `PI_CLAUDE_TOOL_CALL_REPAIR_LOG=/path/to/file` enables full forensic logs.

Console messages are bounded. Full leaked content is written only when the
opt-in forensic log variable is set.

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

This runs the TypeScript check and the 22 regression tests based on captured
Claude failure transcripts.
