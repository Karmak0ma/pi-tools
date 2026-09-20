# subagents-vflo

A pi extension that enables delegating tasks to specialized subagents running in isolated subprocess contexts.

## Features

- **Multi-task execution** — Run up to 8 tasks in parallel (4 concurrent max)
- **Agent specialization** — Define custom agents with specific tools, models, and system prompts
- **Full isolation** — Each subagent runs in its own `pi` subprocess with no shared state
- **TUI Inspector** — Visual inspector mode to monitor subagent progress in real-time
- **Live streaming** — See subagent output as it's generated
- **Live usage header** — Track input, output, cached tokens, and context-window utilization while each subagent works
- **Persistent child history** — Store each child session as an isolated JSONL file below the parent Pi session directory
- **Context-aware abort** — Graceful SIGTERM → SIGKILL escalation with timer cleanup
- **Agent discovery** — Built-in, user, and project agents with clear override precedence
- **Child extension UI bridge** — Blocking RPC dialogs are presented as parent-side modals with FIFO ownership and fail-closed cancellation

## Installation

Add this extension to your pi configuration:

```json
{
  "extensions": ["./path/to/subagents-vflo/src"]
}
```

Or symlink/copy the directory into your pi extensions path.

## Usage

The extension registers a `subagent` tool that accepts a `tasks` array:

```json
{
  "tasks": [
    {
      "agent": "explore",
      "task": "Find all TypeScript files that import the database module",
      "model": "claude-sonnet-4-20250514",
      "cwd": "/path/to/project"
    },
    {
      "agent": "build",
      "task": "Add error handling to the auth middleware"
    }
  ]
}
```

### Task Fields

| Field | Required | Description |
|-------|----------|-------------|
| `agent` | Yes | Name of the agent to use (`explore`, `build`, or custom) |
| `task` | Yes | The prompt/instruction for the subagent |
| `model` | No | Override the model for this task |
| `cwd` | No | Working directory for the subagent |

### Allowed Tools

What a child subagent can actually use is decided by two independent keys, both of which must match:

1. **Extension pool** — packages listed in `~/.pi/agent/subagents-vflo_settings.json` are loaded into every child process (`--no-extensions` plus one `-e` per package). A tool that no loaded package registers does not exist in the child at all.
2. **Agent declaration** — the agent's `tools:` frontmatter becomes the child's `--tools` allowlist. pi core applies this allowlist to extension tools as well as built-ins.

Built-in tools a child may declare:
- `read` — Read files
- `bash` — Execute shell commands
- `edit` — Edit files with precise replacements
- `write` — Write/create files
- `grep` — Search file contents
- `find` — Find files
- `ls` — List directory contents

Extension tools (including `subagent` itself, for recursive dispatch) are usable when the providing package is listed in `subagents-vflo_settings.json` **and** the agent declares the tool in `tools:`. For example, an orchestrator agent declares `tools: read, bash, edit, write, subagent` and the settings file lists this extension — the child then gets a working `subagent` tool.

Two failure modes are distinguished at spawn time:

- Declaring a tool that is neither a built-in nor active in the parent session is a hard error; the child is not spawned.
- Declaring an extension tool whose providing package is missing from the settings file spawns the child **with a warning**: the tool is silently absent there, and calling it fails with an unknown-tool error.

Agents that declare no `tools:` inherit built-in tools only. Extension tools stay off unless an agent explicitly declares them, so default and specialist agents keep least-privilege toolsets and their prompts stay free of unrelated extension tool guidelines.

**Recursion is bounded.** An agent that declares `subagent` (like an orchestrator) can dispatch subagents of its own — including one named like itself, because every child discovers the same user/project agent files. runChild stamps each child with a generation counter (`PI_SUBAGENTS_VFLO_DEPTH` environment variable) and refuses to spawn at nesting level `MAX_NESTING_DEPTH` (2): one orchestrator layer with its specialists works, deeper self-dispatch chains return a child error instead of forking pi processes without bound.

## Child extension dialogs

Children run in Pi RPC mode. When a configured child extension requests `select`,
`confirm`, `input`, or `editor`, the request is bridged to an immediate parent
modal. Requests from concurrent children are serialized globally in FIFO order;
the modal identifies the agent, task, working directory, and active child tool
calls (including the full `bash` command when available). Herdr-hosted children
are interactive sessions instead — their dialogs render directly in the child
pane, where the user answers them.

Responses stay bound to the originating child and are sent exactly once. Escape,
abort, child exit, session shutdown, malformed known requests, and conservative
local timeout handling all fail closed; the bridge never infers approval or
reorders select options. Pi remains authoritative for the child RPC timeout.

The bridge is independent of the subagent inspector, so dialogs appear whether
the inspector is open or closed. A waiting child is marked `waiting for input`
in the inspector, but the inspector is not a second response path.

## Child session storage

Each child runs with pi session persistence enabled. When the parent session is
persistent, the extension creates a unique child directory below the exact
project session directory returned by the parent Pi session manager. With the
default Pi configuration, that parent directory is below
`~/.pi/agent/sessions/--path-to-project--/`, so child history appears for
example at:

```text
~/.pi/agent/sessions/--path-to-project--/pi-subagent-AbCd12/20260101_120000_uuid.jsonl
```

The unique child directory is intentional: the inspector's watcher can scan
it without also consuming the parent or a sibling child's messages. Pi's
session list remains limited to direct `.jsonl` files, so nested child history
does not pollute `/resume`. The child session directory and JSONL history
remain after the child exits so they can be inspected; there is no automatic
history cleanup, so remove stale `pi-subagent-*` directories manually when
needed. If the parent is running with `--no-session` or its session directory
is unavailable, the extension falls back to a unique `/tmp/pi-subagent-*`
directory.

## Herdr execution backend

When the parent Pi session runs inside a [Herdr](https://herdr.dev/)
workspace (`HERDR_ENV=1` plus `HERDR_PANE_ID`), spawned subagents become real,
interactive Pi sessions instead of headless RPC children:

- Each subagent gets its **own pane** in the current Herdr workspace, created
  with `herdr pane split --current --no-focus` so it never steals keyboard
  focus. The first task of a batch splits right; later tasks split down (and a
  narrow parent always splits down).
- The child is launched with `herdr agent start <name> --kind pi` and receives
  the task as its first prompt. Model, tools, thinking level, cwd, agent
  system prompt, and configured child extensions are preserved from RPC mode;
  the nesting-depth marker is injected into the pane env. Herdr also loads its
  managed `herdr-agent-state.ts` lifecycle extension when it is installed, even
  though unrelated extensions remain disabled by `--no-extensions`, so the
  Herdr agents view can show working, idle, and blocked states accurately.
- The extension's subagent inspector does **not** auto-open (it never did);
  the pane itself is the live view. `/subagents` still lists Herdr instances
  for status, abort, and steering.

The parent observes the child through its **session JSONL** — never through
Herdr's `idle`/`done` pane status, which is a UI-seen state, not task semantics:

- A turn that settles normally (`stop`) completes the task and delivers the
  result to the parent, exactly like the RPC path.
- An **interrupted turn** (Escape inside the child pane) does not complete or
  fail the task. Its lifecycle becomes `interrupted`; the pane, session,
  watcher, and parent request stay alive for manual/corrective input. A later
  normal turn returns the same task to `running` and still completes it
  automatically. Only the final normal `stop` message supplies the parent
  result; partial text from the aborted turn is discarded.
- Pane death is a terminal task event, distinct from a turn interruption. An
  interrupted task becomes `closed`, an errored task becomes `failed`, and an
  otherwise active task becomes `closed`; a dead pane is never reported as a
  successful completion.
- Parent cancellation (or the inspector's `x`) closes the pane and resolves
  the task as `closed` (shown as aborted by the compatibility UI status).
  Escape pressed inside the child pane is different: it interrupts only the
  current child turn and is non-terminal.
- Session shutdown closes every Herdr child pane, so no child process
  outlives its parent session.

The RPC runner stays the fallback outside Herdr and keeps its existing
process/turn protocol. Both backends now expose the same explicit delegated
lifecycle and final-output classification. Backend selection lives in
`src/herdr.ts`; the two implementations share one contract in
`src/backends.ts`.

## Built-in Agents

### `explore`
Fast read-only codebase reconnaissance. Uses openai-codex/gpt-5.6-luna with low thinking effort by default.

**Tools:** `read`, `bash`, `find`, `ls`, `grep`

### `build`
General-purpose agent with full coding capabilities. Inherits the parent session model by default.

**Tools:** `read`, `bash`, `edit`, `write`

## Custom Agents

Define custom agents as Markdown files with YAML frontmatter:

### User Agents (global)
Place `.md` files in `~/.pi/agent/agents/`:

```markdown
---
name: reviewer
description: Code review specialist
model: claude-sonnet-4.5
tools:
  - read
  - bash
  - grep
---

You are a code review specialist. Analyze code for:
- Bug risks
- Performance issues
- Security vulnerabilities
- Style inconsistencies
```

### Project Agents (per-project)
Place `.md` files in `.pi/agents/` in your project root (or any ancestor directory):

> **Security warning:** Project-local agents are always auto-loaded by this extension. They are repo-controlled prompt files and can influence tool usage and file access. Only use this extension in repositories you trust.

```markdown
---
name: test-writer
description: Writes comprehensive test suites
tools:
  - read
  - bash
  - edit
  - write
---

You are a test-writing specialist for this project.
Follow the existing test patterns and use vitest.
```

### Precedence

1. **Project agents** (highest) — `.pi/agents/*.md`
2. **User agents** — `~/.pi/agent/agents/*.md`
3. **Built-in agents** (lowest) — `explore`, `build`

A custom agent with the same name as a built-in overrides it.

## TUI Inspector Mode

When subagents are present in the current session, open the visual inspector with either:

- `/subagents` — recommended, reliable across terminals
- `Ctrl+↓` — keyboard shortcut, if your terminal sends that chord correctly

Inside the inspector:

| Shortcut | Action |
|----------|--------|
| `Ctrl+↑` | Exit inspector mode |
| `Ctrl+O` | Expand/collapse tool output |
| `←` / `→` | Cycle between subagent tabs (wraps around) |
| `↑` / `↓` | Scroll conversation body |
| `PgUp` / `PgDn` | Scroll by page |
| `t` | Enter message mode for the selected subagent |
| `Enter` | Steer the selected running subagent (in message mode) |
| `x` | Abort running subagent / Exit if completed |
| `Escape` | Cancel message entry only |

The inspector shows:
- **Tab bar** — All subagent instances with status icons (○ queued, ⏳ running, ✓ completed, ✗ error, ⊘ aborted)
- **Task header** — Model, thinking effort, allowed tools, live input/output/cached token totals, and context usage as `X / Y (N%)`
- **Conversation body** — Reconstructed transcript with assistant text, tool calls, tool results, and stderr
- **Footer** — Navigation hints and current status
- **Live updates** — Streaming text as it arrives

## Model Resolution

Models are resolved against the models that are actually available in the current pi session. Provider extensions needed by child processes can be listed in `~/.pi/agent/subagents-vflo_settings.json`; for example, add `npm:opencode-pi` when using the `opencode-cli` models. The same file is also the extension pool that decides which extension tools children can use — see [Allowed Tools](#allowed-tools).

Resolution order is:

1. **Task-level override** — `model` field on the task item, if provided and available
2. **Agent default** — agent `model` from YAML frontmatter, if defined and available
3. **Parent fallback** — the model currently used by the parent pi session

Bare model ids prefer the parent provider when that provider offers the requested model.

In practice this means:

- `build` inherits the parent session model by default
- built-in `explore` uses `openai-codex/gpt-5.6-luna` with low thinking effort
- custom `.md` agents may specify their own default model in frontmatter

Warnings are emitted whenever resolution falls back from an unavailable task or agent model to the next level.

## Concurrency & Limits

| Parameter | Value | Description |
|-----------|-------|-------------|
| `MAX_TOTAL_TASKS` | 8 | Maximum tasks per invocation |
| `MAX_CONCURRENT` | 4 | Maximum simultaneously running subprocesses |

Tasks beyond the concurrent limit are queued and spawned as earlier tasks complete.

## Error Handling

- **Invalid agent name** — Task fails immediately with clear error message
- **Invalid tools** — Declared tools must be built-ins or parent-active extension tools; unknown names are rejected pre-spawn. Declared extension tools without a backing package in `subagents-vflo_settings.json` spawn with a warning and are absent in the child
- **Invalid CWD** — Non-existent or non-directory paths rejected pre-spawn
- **Non-zero exit** — Task marked as failed, stderr preview included
- **Abort** — SIGTERM sent, SIGKILL after 5 seconds if not exited
- **Signal aborted before spawn** — Queued tasks are skipped

## Output Format

### Single Task
Returns the subagent's final output as text content directly.

### Multiple Tasks
Returns a summary showing:
- Success/failure counts
- Per-task results with status icons
- Error messages for failed tasks
- Aggregate token usage

### Persisted Details
Structured summaries are stored in the tool call's `details` field for later reference, including:
- Agent name, task, model used
- Stop reason and duration
- Token usage (input/output)
- Tool calls made
- Error messages and stderr previews

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Type check
npx tsc --noEmit
```

### Test Coverage

- **91 tests** across 14 test files
- Unit tests per module (types, resolver, tracker, agents, runner, render)
- Integration tests for the full execution flow
- Validation matrix for all error scenarios
- TUI component tests with mock theme/tracker
- Backend tests: Herdr detection, CLI parsing, session watching, pane
  lifecycle (completion, interruption, death, startup failures), and the
  non-Herdr fallback path

## Architecture

```
src/
├── index.ts           — Tool registration, execution orchestration, lifecycle hooks
├── types.ts           — Constants, interfaces, type definitions
├── agents.ts          — Agent discovery (builtin, user, project) with precedence
├── resolver.ts        — Model, tool, and CWD resolution with validation
├── backends.ts        — SubagentBackend contract, default (RPC) backend, selection
├── runner.ts          — RPC subprocess spawning, process management, event streaming
├── herdr.ts           — Herdr detection + CLI client
├── path-utils.ts      — Shared filesystem-path canonicalization helpers
├── herdr-backend.ts   — Herdr pane backend (spawn, JSONL observation, lifecycle)
├── session-watcher.ts — Incremental session-JSONL scanner used by the Herdr backend
├── tracker.ts         — SubagentTracker class, runtime instance management
├── render.ts          — Tool-row rendering (renderCall/renderResult, formatUsage)
└── tui.ts             — TUI inspector mode (component, manager, keyboard handling)
```

## License

Private — not published to npm.
