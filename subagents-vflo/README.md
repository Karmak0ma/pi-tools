# subagents-vflo

A pi extension that enables delegating tasks to specialized subagents running in isolated subprocess contexts.

## Features

- **Multi-task execution** — Run up to 8 tasks in parallel (4 concurrent max)
- **Agent specialization** — Define custom agents with specific tools, models, and system prompts
- **Full isolation** — Each subagent runs in its own `pi` subprocess with no shared state
- **TUI Inspector** — Visual inspector mode to monitor subagent progress in real-time
- **Live streaming** — See subagent output as it's generated
- **Context-aware abort** — Graceful SIGTERM → SIGKILL escalation with timer cleanup
- **Agent discovery** — Built-in, user, and project agents with clear override precedence

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

Child subagents can only use built-in tools:
- `read` — Read files
- `bash` — Execute shell commands
- `edit` — Edit files with precise replacements
- `write` — Write/create files
- `grep` — Search file contents
- `find` — Find files
- `ls` — List directory contents

Extension tools (including `subagent` itself) are **never** forwarded to children.

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
| `←` / `→` | Cycle between subagent tabs (wraps around) |
| `↑` / `↓` | Scroll conversation body |
| `Escape` | Abort running subagent / Exit if completed |

The inspector shows:
- **Tab bar** — All subagent instances with status icons (○ queued, ⏳ running, ✓ completed, ✗ error, ⊘ aborted)
- **Conversation body** — Reconstructed transcript with assistant text, tool calls, tool results, and stderr
- **Footer** — Navigation hints and current status
- **Live updates** — Streaming text as it arrives

## Model Resolution

Models are resolved against the models that are actually available in the current pi session. Provider extensions needed by child processes can be listed in `~/.pi/agent/subagents-vflo_settings.json`; for example, add `npm:opencode-pi` when using the `opencode-cli` models.

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
- **Invalid tools** — Tools not in the allowed list are rejected pre-spawn
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

- **185 tests** across 10 test files
- Unit tests per module (types, resolver, tracker, agents, runner, render)
- Integration tests for the full execution flow
- Validation matrix for all error scenarios
- TUI component tests with mock theme/tracker

## Architecture

```
src/
├── index.ts      — Tool registration, execution orchestration, lifecycle hooks
├── types.ts      — Constants, interfaces, type definitions
├── agents.ts     — Agent discovery (builtin, user, project) with precedence
├── resolver.ts   — Model, tool, and CWD resolution with validation
├── runner.ts     — Subprocess spawning, process management, event streaming
├── tracker.ts    — SubagentTracker class, runtime instance management
├── render.ts     — Tool-row rendering (renderCall/renderResult, formatUsage)
└── tui.ts        — TUI inspector mode (component, manager, keyboard handling)
```

## License

Private — not published to npm.
