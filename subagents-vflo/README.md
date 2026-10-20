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
- **Context-preserving follow-ups** — Continue completed subagent conversations with blocking or async requests
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

### Continue a completed subagent

Both blocking and async calls return task IDs. Once a task completes successfully,
the parent can send another request to its saved conversation:

```json
{
  "taskId": "task-1",
  "task": "Check whether the same issue exists in the other backend.",
  "async": true
}
```

Send this to **`subagent_continue`**, not `subagent`. `taskId` and `task` are
required; `async` defaults to false. The result contains a **new task ID**.
Use that new ID for status, waiting, cancellation, and the next follow-up.
Blocking results include IDs in their text and `details.taskIds`; async results
and completion notifications also include them.

Rules and limits:

- Wait for successful completion first. A queued or running child cannot be
  continued, and only one request in a conversation can be active at a time.
- Use the latest successfully completed ID in the conversation. Older ancestors
  cannot create competing branches. A failed or cancelled follow-up does not
  replace the latest successful ID, so you can retry from that ID.
- The child keeps its conversation messages, tool results and Pi context
  changes, including compaction. There are no per-request configuration
  overrides; use a new `subagent` call for those.
- **Herdr:** if the original pane is open and its original child is idle,
  the request runs in that same pane and Pi process. Manual conversation and
  settings changes made there remain part of the live session. Only new
  output and usage belong to the follow-up result; old replies are not replayed.
  Safe reuse requires Pi's managed lifecycle hook to report idle/done. Busy,
  blocked, unknown, replaced or untracked children return an error, as do
  connection failures; these never silently open a duplicate pane. Do not type
  into the child while the parent submits a follow-up: Herdr cannot reserve
  terminal input against simultaneous human input.
- **Closed Herdr pane or default RPC backend:** the request forks the frozen
  completed history into a private session and starts a replacement child,
  with the original resolved agent settings. A closed Herdr pane gets a new
  pane; later manual input after the saved completion is not restored. This
  fallback restores conversation context, not process memory. Project files
  are not rolled back or isolated.
- Async follows the same rules as the initial call: top-level interactive TUI
  sessions receive a completion notification; nested or non-TUI calls fall back
  to blocking. Existing status, wait, cancel and inspector controls also work
  for follow-up IDs.
- Task IDs and conversation ownership belong to the current extension runtime.
  Session switches, shutdown and extension reload discard them. The session
  files remain for inspection, but old IDs cannot be resumed after a restart.
- Continuation requires readable completed child history. If saving it fails,
  the task still returns its original result with a warning, but cannot be
  continued. Frozen snapshots (`task-N.continuation`) live beside child JSONL
  files and follow the same manual cleanup policy.

A nested agent must declare `subagent_continue` in its `tools:` allowlist if it
needs to issue follow-ups; declaring `subagent` alone does not grant that tool.

## How subagents get their tools

A subagent runs in its own pi process (the **child**). The session that starts
it is the **parent**. Two settings decide what the child can do. Each setting
has one job:

| Setting | Job |
| --- | --- |
| `packages` in `~/.pi/agent/subagents-vflo_settings.json` | Which extensions the child loads. This is the complete list. |
| The agent's tool list | Which tools the child may use. |

### Which extensions the child loads

The child starts with `--no-extensions`. It always loads pi's built-in
`builtin:codemode` and `builtin:mcp`. It also loads the packages in `packages`
and nothing else. Your normal `settings.json` packages are **not** loaded.

```json
{
  "packages": [
    "/path/to/pi-dcp",
    "npm:pi-web-access"
  ]
}
```

- `--no-extensions` also turns off pi's other built-in extensions. To load
  one, add it as `builtin:<name>`, for example `builtin:tool-search`.
- `builtin:mcp` connects each child to every *enabled* server in
  `~/.pi/agent/mcp.json`, in the background. Servers with `"enabled": false`
  do not start.
- Loading `builtin:codemode` does not give the agent the `codemode` tool. The
  agent must have `codemode` in its tool list, or inherit it from the parent.
- The extension reads this list once. After you change it, run `/reload` or
  restart pi.

### Which tools the agent may use

The extension finds the tool list in this order and uses the first one it
finds:

1. **Custom agent:** `tools:` in the agent file.
2. **Built-in `explore` or `build`:** `default_agents.<name>.tools` in the
   settings file. If that is not set, the bundled list:
   `explore` = `read, grep, find, ls, bash`, `build` = `read, bash, edit, write`.
3. **No list (custom agent without `tools:`):** the tools that are active in
   the parent, except tools whose extension the child does not load.

The list goes to the child's `--tools` option without changes. The extension
adds nothing to it. `compress`, MCP tools, and `codemode` are normal tools:
list them if the agent needs them.

A list can contain:

- pi core tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`,
  `powershell`;
- any tool that an extension in the parent registered, if that extension is
  also in `packages`. The tool does not have to be active in the parent;
- patterns with `*`, for example `mcp__docs__*` for all tools of one MCP
  server. The extension does not check patterns.

### Tools that turn on other tools

Some extensions keep their tools off until the model asks for them. For
example, pi-web-access keeps `web_search` and `fetch_content` off until the
model calls `web_enable`. A tool that is not in the child's list does not
exist in the child, so `web_enable` can only turn on tools that are also in
the list. List all of them:

```json
"tools": ["read", "bash", "web_enable", "web_search", "source_check", "fetch_content", "get_search_content"]
```

An agent without a list inherits only what is active in the parent **now**.
If the parent has not called `web_enable`, such an agent gets `web_enable`
but not `web_search`, and its call to `web_enable` fails.

### MCP tools and codemode

pi keeps MCP tools available to `codemode` scripts when the agent's list has
no `mcp__` entry. So an agent with `codemode` in its list can call **every**
MCP tool from a script. To limit this, add
at least one `mcp__...` name or pattern to the list. Then pi keeps only the MCP
tools that the list names.

### Checks before the child starts

Every name in an agent's list (except patterns) must be a pi core tool or a
tool that the child will have. If not, the child does not start, and the
error tells you what to fix:

| Error | Cause | Fix |
| --- | --- | --- |
| `"X": no extension in the parent session registers this tool` | Nothing in the parent registers `X`. | Check the spelling. Install the extension in the parent too, or remove `X` from the list. |
| `"X": its extension ... is not in "packages"` | The child does not load the extension that registers `X`. | Add the package to `packages`, then run `/reload`. Or remove `X` from the list. |

### Nested subagents

An agent can start its own subagents when its tool list has `subagent` and
`packages` lists this extension. For example, an orchestrator agent declares
`tools: read, bash, edit, write, subagent`.

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

- Each subagent gets its **own pane** in the current Herdr workspace. The
  backend creates it with `herdr pane split --current --no-focus`, then runs
  `herdr pane zoom <pane> --on` to show the child full-screen. Zoom focuses
  the new child. The first task of a batch splits right; later tasks split down
  (and a narrow parent always splits down).
- The child is launched with `herdr agent start <name> --kind pi`. Herdr says
  "ready" and `idle` from a guess before Pi can take input, so the backend
  sends the first task prompt only when Pi's lifecycle hook reports `idle`
  (`herdr agent get` shows `screen_detection_skipped: true`). Without this
  gate, a slow (cold) start left the task unsubmitted in the child's editor.
  See "Initial-prompt readiness" in `docs/design-herdr-backend.md`. Model,
  tools, thinking level, cwd, agent system prompt, and configured child
  extensions are preserved from RPC mode; the nesting-depth marker is injected
  into the pane env. Herdr also loads its managed `herdr-agent-state.ts`
  lifecycle extension when it is installed, even though unrelated extensions
  remain disabled by `--no-extensions`, so the Herdr agents view can show
  working, idle, and blocked states accurately.
- The extension's subagent inspector does **not** auto-open (it never did);
  the pane itself is the live view. `/subagents` still lists Herdr instances
  for status, abort, and steering.

The parent decides task completion through the child's **session JSONL**.
Herdr's `idle`/`done` pane status remains a UI-seen state, not task semantics;
a hook-reported `idle` gates the first prompt, and a later `working`/`blocked` state
cancels a 30-second startup-activity deadline:

- A turn that settles normally (`stop`) completes the task and delivers the
  result to the parent, exactly like the RPC path. If no `working`/`blocked`
  state or assistant session message appears after the initial prompt within
  the startup deadline, the task fails with a specific startup-timeout message
  instead of remaining pending forever.
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

### Renaming the agent in the focused Herdr pane

`herdr-plugin/` is a small **Herdr plugin** (not loaded by Pi). It adds one
action, `vflo.subagents.rename-current-agent`, that renames the agent in the
Herdr pane that has focus. It works for any agent Herdr recognizes, not only
subagents spawned by this extension.

Register it once, then bind a key in `~/.config/herdr/config.toml`:

```bash
herdr plugin link /path/to/subagents-vflo/herdr-plugin
```

```toml
[[keys.command]]
key = "prefix+shift+a"          # free in Herdr's defaults; change as you like
type = "plugin_action"
command = "vflo.subagents.rename-current-agent"
description = "rename agent"
```

Reload with `herdr server reload-config` (or `prefix+shift+r`). You can also
run it without a key: `herdr plugin action invoke vflo.subagents.rename-current-agent`.

Behavior:

- The action reads `focused_pane_id` from Herdr's action context and checks it
  with `herdr agent get`. A pane without an agent shows the Herdr notification
  "No agent in focused pane" and nothing else happens.
- Otherwise a small popup opens, prefilled with the current name. **Enter**
  confirms, **Esc** (or Ctrl+C) cancels, Ctrl+U clears the line.
- Confirming runs `herdr agent rename <pane-id> <name>`. Herdr validates the
  name (`[a-z][a-z0-9_-]{0,31}`, unique among live agents); an error stays in
  the popup so you can fix it. **Empty input clears the name**
  (`herdr agent rename <pane-id> --clear`), which is Herdr's own "no name" state.
- The name lives only in Herdr. Any view that shows Herdr agent names (the
  sidebar, pane borders, other plugins) updates through Herdr's normal state.

## Built-in Agents

### `explore`
Fast read-only codebase reconnaissance. Its bundled model is `openai-codex/gpt-5.6-luna`; its bundled thinking level is `medium`.

**Bundled tools:** `read`, `bash`, `find`, `ls`, `grep`. See [How subagents get their tools](#how-subagents-get-their-tools).

### `build`
General-purpose agent with full coding capabilities. Its bundled model is `openai-codex/gpt-5.6-luna`; its bundled thinking level is `xhigh`.

**Bundled tools:** `read`, `bash`, `edit`, `write`. See [How subagents get their tools](#how-subagents-get-their-tools).

You can override the built-in agents' model, thinking level and tools in
`~/.pi/agent/subagents-vflo_settings.json`, one block per agent under
`default_agents`:

```json
{
  "default_agents": {
    "explore": { "model": "openai-codex/gpt-5.6-luna", "thinking": "medium" },
    "build": {
      "model": "openai-codex/gpt-5.6-luna",
      "thinking": "max",
      "tools": ["read", "bash", "edit", "write", "compress", "ask_advisor"]
    }
  }
}
```

Every field is optional; an omitted field keeps the bundled value.

- `model`: an exact model ID available in the parent pi session.
- `thinking`: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.
  `max` is model-specific; Pi clamps an unsupported level to one the selected
  model supports.
- `tools`: replaces the bundled tool list. It is checked like an agent
  file's `tools:` list. See
  [How subagents get their tools](#how-subagents-get-their-tools).

Invalid or blank values are ignored one field at a time. These settings change
only built-in defaults; a user or project agent named `explore` or `build`
still overrides the matching built-in agent.

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

Models are resolved against the models that are actually available in the current pi session. Set built-in Explore and Build defaults with the `default_agents` object in `~/.pi/agent/subagents-vflo_settings.json`; this can be in the same file as `packages`, which lists provider or tool extensions loaded by child processes. For example, add `npm:opencode-pi` to `packages` when using the `opencode-cli` models. The `packages` list also decides which extension tools children can use — see [How subagents get their tools](#how-subagents-get-their-tools).

Resolution order is:

1. **Task-level override** — `model` field on the task item, if provided and available
2. **Agent default** — agent `model` from YAML frontmatter, if defined and available
3. **Parent fallback** — the model currently used by the parent pi session

Bare model ids prefer the parent provider when that provider offers the requested model.

In practice this means:

- Built-in `explore` and `build` use their configured model defaults; if a setting is omitted, both use the bundled default `openai-codex/gpt-5.6-luna`.
- The built-in thinking defaults are `medium` for `explore` and `xhigh` for `build`.
- Custom `.md` agents may specify their own default model in frontmatter. A custom agent named `explore` or `build` overrides that built-in and its settings-file model default.

Warnings are emitted whenever resolution falls back from an unavailable task or agent model to the next level.

## Concurrency & Limits

| Parameter | Value | Description |
|-----------|-------|-------------|
| `MAX_TOTAL_TASKS` | 8 | Maximum tasks per invocation |
| `MAX_CONCURRENT` | 4 | Maximum simultaneously running subprocesses |

Tasks beyond the concurrent limit are queued and spawned as earlier tasks complete.

## Error Handling

- **Invalid agent name** — Task fails immediately with clear error message
- **Invalid tools** — See [Checks before the child starts](#checks-before-the-child-starts)
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

Each task's text preview is capped at 12,000 characters. If it is longer and
the parent session has a persistent log, the result includes a `jq` command that
extracts the complete text from that session JSONL file. The complete text is
retained in the tool result's `details.summaries[index].finalOutput` field.
Single-task results still return their full text without this batch preview cap.

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
