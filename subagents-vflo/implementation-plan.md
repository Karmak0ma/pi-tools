# Subagents Extension — Implementation Plan v2.1

## Summary of Decisions

| Aspect | Decision |
|--------|----------|
| Base approach | Adapt the official pi subagent example as foundation |
| Execution model | Subprocess (`pi --mode json -p --no-session`) |
| Recursion control | Every child invocation passes an explicit **built-in-only** tool list resolved per agent; extension tools, including `subagent`, are never forwarded to children |
| TUI strategy | Phase 3: full TUI mode via render patch. Phase 1 uses tool-row rendering only |
| Tool schema | `tasks` array only (single task = array of 1) |
| Default agents | Built-in fallbacks, overridable by markdown agents with same name |
| Agent file format | YAML frontmatter + Markdown |
| Agent discovery | User (`~/.pi/agent/agents/`) + nearest ancestor project (`.pi/agents/`) — always include both |
| Model resolution | Deterministic 3-level resolution with explicit validation and warn-on-fallback |
| Inheritance model | Field-by-field matrix: model, tools, cwd, prompt, and metadata resolved explicitly |
| Context return | Final text to parent; structured summaries kept in persisted tool details |
| Concurrency | Hard caps (max total tasks + max concurrent) |
| Event retention | Full child JSON events retained only in runtime memory; persisted tool details store summarized task data only |
| Abort behavior | Context-aware |
| Security posture | Always include project agents; document security tradeoff |

---

## Foundation and Scope of Divergence

This extension **adapts the official pi subagent example** (`examples/extensions/subagent/`) rather than building from scratch.

### Reused from official example (unchanged)
- Subprocess execution model (`pi --mode json -p --no-session`)
- JSON event streaming from child stdout
- Agent markdown discovery with `parseFrontmatter()`
- Usage tracking accumulation pattern
- Bounded concurrency with `mapWithConcurrencyLimit()`
- Result rendering via `renderCall` / `renderResult`
- Abort propagation via SIGTERM/SIGKILL
- Temp file cleanup for system prompts
- `getPiInvocation()` for resolving the pi binary path

### Modified from official example
- Tool schema: flat `{ agent, task }` → `tasks` array only
- Removal of chain mode and aggregator
- Default agents: hardcoded fallbacks (`explore`, `build`) overridable by `.md` files
- Project agents always included (no `agentScope` parameter)
- Remove `confirmProjectAgents` interactive gate
- Model override via tool parameter (`model` field on each task)
- Deterministic model validation and warn-on-fallback behavior
- Explicit field-by-field inheritance matrix
- Runtime full-event tracker separated from persisted tool-result details
- Tool description and prompt guidelines expanded per requirements

### Deferred to later phases
- Full TUI mode with render patching (Phase 3)
- In-process `createAgentSession()` experimentation (optional future)

---

## Phase 1 — Stable Subprocess Execution Core

### 1.1 Import/Adapt Official Subagent Baseline

**Goal:** Copy and adapt the official example's structure as the starting point.

**Source files:**
- `examples/extensions/subagent/index.ts` → adapt into `src/index.ts`
- `examples/extensions/subagent/agents.ts` → adapt into `src/agents.ts`

**Key adaptations:**
- Remove `chain` and `aggregator` modes
- Remove `agentScope` and `confirmProjectAgents` parameters
- Simplify to `tasks` array schema only
- Add `model` field per task item
- Split runtime tracking from persisted result details

**File structure:**
```
subagents-vflo/
├── package.json
├── src/
│   ├── index.ts          # Extension entry: tool registration + events
│   ├── agents.ts         # Agent discovery + fallback built-ins
│   ├── runner.ts         # Subprocess spawning + event collection
│   ├── resolver.ts       # Model/tool/cwd resolution helpers
│   ├── render.ts         # renderCall / renderResult
│   ├── tracker.ts        # Runtime-only full event tracker for live TUI phase
│   └── types.ts          # Shared types
```

### 1.2 Agent Discovery and Precedence

**Discovery locations (both always scanned):**
1. `~/.pi/agent/agents/*.md` — user agents
2. Nearest ancestor `.pi/agents/*.md` — project agents

**Precedence (highest wins):**
1. Project agents (override user agents with same name)
2. User agents (override built-in fallbacks with same name)
3. Built-in fallback agents (`explore`, `build`)

**Built-in fallback agents (hardcoded, active only if no `.md` override exists):**

```typescript
const BUILTIN_AGENTS: AgentConfig[] = [
  {
    name: "explore",
    description: "Fast read-only codebase recon using a fast model",
    tools: ["read", "grep", "find", "ls", "bash"],
    model: "anthropic/claude-haiku-4-5",
    systemPrompt: `You are an exploration agent...`,
    source: "builtin",
  },
  {
    name: "build",
    description: "General-purpose agent with coding capabilities",
    tools: ["read", "bash", "edit", "write"],
    model: undefined, // resolved via the inheritance matrix
    systemPrompt: `You are a build agent...`,
    source: "builtin",
  },
];
```

**Agent `.md` format:**
```markdown
---
name: my-agent
description: When to use this agent
tools: read, grep, find, ls, bash
model: anthropic/claude-haiku-4-5
---

System prompt body goes here.
```

**Frontmatter rules:**
- `name` and `description` are required
- `tools` is optional; when present it must be a comma-separated subset of the allowed child built-in tools
- `model` is optional; when present it is validated with the same rules as the task-level `model` parameter
- Unknown frontmatter keys are ignored unless a later phase adds support for them explicitly

### 1.3 Subprocess Runner Contract

**Child invocation:**
```typescript
const args: string[] = ["--mode", "json", "-p", "--no-session"];
if (resolvedModel) args.push("--model", resolvedModel);
args.push("--tools", resolvedTools.join(","));
if (systemPromptFile) args.push("--append-system-prompt", systemPromptFile);
args.push(`Task: ${task}`);

const invocation = getPiInvocation(args);
const proc = spawn(invocation.command, invocation.args, {
  cwd: resolvedCwd,
  shell: false,
  stdio: ["ignore", "pipe", "pipe"],
});
```

**Important runner rules:**
- Every child invocation always passes an explicit `--tools` list
- The explicit tool list is always built-in only
- Extension tools are never forwarded to children
- `subagent` is never forwarded to children
- Even if the same extension is loaded in the child runtime, `subagent` cannot become active because it is not included in the explicit `--tools` list

**Allowed child built-in tool universe:**
```typescript
const ALLOWED_CHILD_BUILTINS = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;
```

**Event collection from stdout:**
- Parse JSON lines as they arrive
- Track all child JSON events in the runtime tracker for live inspection
- Update a normalized task summary as events stream in
- Track `message_end` events for assistant messages (usage, model, stopReason)
- Track `tool_result_end` events for tool results
- Capture stderr separately for diagnostics

**Abort propagation:**
- On signal abort: send SIGTERM to child
- After 5s timeout: send SIGKILL
- Clean up temp prompt files in `finally`
- Remove the running-process handle from the tracker when the child exits or is aborted

### 1.4 Inheritance and Override Matrix

The child does **not** inherit the parent conversation, the parent session tree, previous tool results, queued steering/follow-up messages, extension UI state, or any parent render state.

The child **does** inherit selected execution settings through the following deterministic matrix.

| Field | Task param | Agent definition (`.md` or builtin) | Parent session | Final rule |
|------|------------|--------------------------------------|----------------|------------|
| Model | `task.model` | `agent.model` | current parent model | Resolve in priority order: task → agent → parent |
| Tools | none | `agent.tools` | current parent active tools | Resolve to an explicit built-in-only tool list for every child spawn |
| Cwd | `task.cwd` | none | current parent cwd | Resolve in priority order: task → parent |
| Agent system prompt | none | markdown body / builtin prompt | none | Always use agent-defined prompt only |
| Task text | `task.task` | none | none | Always use the task text from the tool call |
| Metadata / source | none | project > user > builtin precedence | none | Used for rendering, warnings, and provenance only |

#### 1.4.1 Model resolution

**Accepted input forms for task-level and agent-level model strings:**
1. Exact `provider/model-id`
2. Exact bare `model-id` **only if uniquely resolvable** in the current parent `modelRegistry`

**Rejected input forms:**
- fuzzy aliases like `haiku`, `sonnet`, `opus`
- partial substrings
- ambiguous bare model ids that resolve to more than one provider

**Resolution algorithm:**
1. Try `task.model`
2. Else try `agent.model`
3. Else use the parent session's current model

**Validation behavior:**
- If `task.model` is invalid or ambiguous: emit a warning and continue to the next source (`agent.model`, then parent model)
- If `agent.model` is invalid or ambiguous: emit a warning and continue to the parent model
- If the parent session has no current model: return an error before spawning any child

**Warning surfaces:**
- streaming `onUpdate` details
- final tool-result details
- collapsed/expanded render output

**Implementation note:**
The parent runtime resolves the chosen model against `ctx.modelRegistry` and passes the final concrete string to the child via `--model`.

#### 1.4.2 Tool resolution

Every child spawn receives an explicit built-in-only tool list.

**Constants:**
```typescript
const DEFAULT_BUILD_TOOLS = ["read", "bash", "edit", "write"] as const;
```

**Resolution algorithm:**
1. If `agent.tools` is present:
   - parse it as a list
   - validate every entry against `ALLOWED_CHILD_BUILTINS`
   - if any entry is invalid, return an error for that task before spawn
   - use the validated list as-is
2. Else:
   - inspect the parent session's currently active tools
   - keep only entries that are in `ALLOWED_CHILD_BUILTINS`
   - drop all extension tools, including `subagent`
3. If the inherited built-in subset from step 2 is empty:
   - fallback to `DEFAULT_BUILD_TOOLS`
   - emit a warning

**Result:**
- the child always receives `--tools <explicit-list>`
- the built-in `build` agent always has coding-capable tools because it declares `DEFAULT_BUILD_TOOLS` explicitly
- agents that omit `tools` inherit only the parent's active built-in subset
- `subagent` is never available in the child
- custom extension tools are never available in the child in v2.1

#### 1.4.3 Cwd resolution

**Accepted forms:**
- absolute path
- relative path resolved against the parent session cwd

**Resolution algorithm:**
1. If `task.cwd` is provided, resolve and validate it
2. Else use the parent session cwd

**Validation behavior:**
- resolved path must exist
- resolved path must be a directory
- invalid `cwd` returns an error before spawn

#### 1.4.4 System prompt resolution

The child always starts with a fresh pi subprocess context.

**System prompt behavior:**
- child receives pi's normal default system prompt for that subprocess
- agent prompt body from markdown or builtin definition is appended via `--append-system-prompt`
- parent conversation history is not inherited
- parent custom system prompt modifications are not inherited in v2.1

This keeps subagents isolated and makes prompt behavior deterministic.

### 1.5 Bounded Concurrency

**Hard limits (constants, configurable later):**
```typescript
const MAX_TOTAL_TASKS = 8;    // Maximum tasks accepted in one tool call
const MAX_CONCURRENT = 4;     // Maximum subprocesses running at once
```

**Behavior:**
- If `tasks.length > MAX_TOTAL_TASKS`: return error asking to reduce batch size
- If more than `MAX_CONCURRENT` tasks: queue excess, run when a slot opens
- Use the official example's `mapWithConcurrencyLimit()` pattern

### 1.6 Rendering, Runtime Tracking, and Persisted Details

Phase 1 observability uses standard tool-row rendering only.

#### Runtime-only full event tracker
The runtime tracker stores full child JSON events in memory for the current session lifetime only.

```typescript
interface RuntimeSubagentInstance {
  id: string;
  agent: string;
  source: "builtin" | "user" | "project";
  task: string;
  cwd: string;
  model?: string;
  warnings: string[];
  events: JsonModeEvent[];        // full runtime-only child event stream
  stderr: string;
  status: "queued" | "running" | "completed" | "error" | "aborted";
  summary: LiveTaskSummary;       // normalized rolling summary for rendering
  process?: ChildProcess;
}

interface LiveTaskSummary {
  id: string;
  agent: string;
  source: "builtin" | "user" | "project";
  task: string;
  cwd: string;
  model?: string;
  warnings: string[];
  status: "queued" | "running" | "completed" | "error" | "aborted";
  isPartial: boolean;
  stopReason?: string;
  errorMessage?: string;
  stderrPreview?: string;
  toolCalls: Array<{ name: string; argsPreview: string }>;
  latestOutput: string;
  usage: TaskUsage;
}
```

**Runtime tracker rules:**
- full child events are kept only in memory
- full child events are never persisted in tool-result `details`
- there is **no explicit runtime event-count or byte cap in v2.1**; this is an accepted tradeoff for the current session only, bounded operationally by `MAX_TOTAL_TASKS`, subprocess lifetime, and session shutdown cleanup
- tracker contents are cleared on session shutdown/reload
- tracker contents are also removed when pi exits
- completed task entries may stay in memory for the current session so Phase 3 can inspect them, but they are not serialized into session history

#### Persisted tool-result details
The final tool result stores bounded structured summaries only.

```typescript
interface PersistedTaskSummary {
  agent: string;
  source: "builtin" | "user" | "project";
  task: string;
  cwd: string;
  model?: string;
  warnings: string[];
  stopReason?: string;
  errorMessage?: string;
  stderrPreview?: string;
  toolCalls: Array<{ name: string; argsPreview: string }>;
  finalOutput: string;
  usage: TaskUsage;
}

interface LiveSubagentToolDetails {
  mode: "tasks";
  live: true;
  taskCount: number;
  summaries: LiveTaskSummary[];
}

interface PersistedSubagentToolDetails {
  mode: "tasks";
  live?: false;
  taskCount: number;
  summaries: PersistedTaskSummary[];
}
```

**Persisted details rules:**
- enough data is stored to render completed results after resume
- raw child event streams are not stored in persisted details
- streaming `onUpdate` details use `LiveSubagentToolDetails`
- final tool results and resumed sessions use `PersistedSubagentToolDetails`
- expanded rendering after resume uses `PersistedTaskSummary.finalOutput` + `toolCalls`
- live streaming TUI in Phase 3 uses the runtime tracker, full events, and `LiveTaskSummary.latestOutput`, not persisted details

#### Tool-row rendering (Phase 1 observability)

`renderCall`:
```
subagent tasks (3)
  explore "Find auth-related code..."
  explore "Find auth tests..."
  build   "Implement caching layer..."
```

`renderResult` (collapsed):
```
✓ tasks 3/3
─── explore ✓
  → grep /auth/ in ~/src
  → read ~/src/auth.ts:1-50
  (final output preview...)
─── build ✓
  → edit ~/src/cache.ts
  (final output preview...)
Warnings: Model "foo" not found, fell back to anthropic/claude-sonnet-4-5
Total: 5 turns ↑12k ↓8k $0.02
```

`renderResult` (expanded): full markdown rendering of each task summary's final output + all summarized tool calls + warnings.

### 1.7 Tool Registration

**Tool parameters:**
```typescript
const TaskItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Detailed task for the agent" }),
  model: Type.Optional(Type.String({
    description: 'Model override. Accepted forms: exact "provider/model-id" or exact unique bare model-id. Fuzzy aliases are not allowed.',
  })),
  cwd: Type.Optional(Type.String({ description: "Working directory override" })),
});

const SubagentParams = Type.Object({
  tasks: Type.Array(TaskItem, {
    description: "Array of tasks to delegate. Each runs as a separate subagent process.",
    minItems: 1,
    maxItems: MAX_TOTAL_TASKS,
  }),
});
```

**Tool description and prompt guidelines:**
```typescript
pi.registerTool({
  name: "subagent",
  label: "Subagent",
  description: "Delegate tasks to specialized subagents with isolated context windows. Each task runs in a separate process.",
  promptSnippet: "Delegate tasks to specialized subagents (explore, build, or custom) with isolated context",
  promptGuidelines: [
    `Use subagent proactively for: independent read-only research, broad codebase reconnaissance, high-volume command output that would clutter the main context, parallel multi-domain investigation where each branch can return a concise summary, and independent review or verification after implementation with the read-only explore agent.`,
    `Do not use subagent for: simple answers, quick targeted edits, latency-sensitive one-step work, tasks needing frequent user back-and-forth, or parallel implementation editing the same files (serialize write-heavy work instead). Do not spawn a build agent just to rename one symbol in a known file; edit it directly.`,
    `When using subagent, provide highly detailed task descriptions so the agent can work autonomously. Specify what to return. Example: { "tasks": [{ "agent": "explore", "task": "Research auth-related source files. Report paths and open questions. Do not edit files." }, { "agent": "explore", "task": "Research auth-related tests. Report coverage gaps. Do not edit files." }] }`,
  ],
  parameters: SubagentParams,
  // ...
});
```

---

## Phase 2 — Validation and Polish

### 2.1 Error Handling

- **Agent not found:** return error with list of available agents
- **Invalid task model:** warn and fallback to agent model, then parent model
- **Invalid agent model:** warn and fallback to parent model
- **Invalid agent tools:** return error for that task before spawn
- **Invalid cwd:** return error for that task before spawn
- **Child exit code != 0:** mark that task failed with stderr content
- **Child stopReason `error`:** mark that task failed and surface the error message
- **Child stopReason `aborted`:** report abort cleanly for that task
- **Mixed batch outcomes:** sibling tasks continue running; the overall tool result is successful if at least one task succeeds, and error only if zero tasks succeed or the whole batch is aborted before any success
- **Too many tasks:** return error asking to reduce batch size
- **Signal abort:** kill child processes, report abort

### 2.2 Abort Behavior (Context-Aware)

Since Phase 1 uses tool-row rendering only, abort is straightforward:
- User presses Escape → pi's built-in abort propagates via `signal` to the tool execute function
- The execute function sends SIGTERM to all running child processes
- Each child gets 5s grace period before SIGKILL
- The runtime tracker updates task state to `aborted`

### 2.3 Acceptance Criteria — Phase 1+2

- [ ] Child subprocesses run reliably with correct resolved model/tools/cwd
- [ ] Every child receives an explicit built-in-only `--tools` list
- [ ] `subagent` is never available in the child
- [ ] Invalid task-level model strings warn and fallback deterministically
- [ ] Invalid agent-level model strings warn and fallback deterministically
- [ ] Fallback built-ins (`explore`, `build`) work when no `.md` agents exist
- [ ] User `.md` agents override built-in fallbacks by name
- [ ] Project `.md` agents are discovered from the nearest ancestor `.pi/agents/`
- [ ] Hard concurrency caps enforced (`MAX_TOTAL_TASKS`, `MAX_CONCURRENT`)
- [ ] Usage stats appear correctly in tool result rendering
- [ ] Runtime tracker retains full events only in memory
- [ ] Persisted tool-result details remain summary-only and bounded
- [ ] Parallel tasks stream progressive updates via `onUpdate`
- [ ] Abort kills child work cleanly (no zombies)

---

## Appendix A — Gap Resolutions

This section explicitly resolves implementation ambiguities identified during plan review.

### Gap 1: Built-in agent model unavailability

**Question:** What happens when the `explore` agent's default model (`anthropic/claude-haiku-4-5`) is not available in the user's pi instance (e.g., they only have `github-copilot` configured)?

**Resolution:** Treat it identically to any other invalid agent-level model string. The model resolution algorithm (Section 1.4.1) handles this:
1. `task.model` is not set → skip
2. `agent.model` is `"anthropic/claude-haiku-4-5"` → validate against parent `modelRegistry`
3. If not found → emit warning: `Built-in explore agent model "anthropic/claude-haiku-4-5" not available, falling back to parent model`
4. Fall back to the parent session's current model

This means the `explore` agent still works — it just uses a potentially slower/more expensive model than intended. The warning makes this visible.

### Gap 2: System prompt temp file content and task delivery

**Question:** What goes in the `--append-system-prompt` temp file? How is the task delivered?

**Resolution:**
- **Temp file content:** Contains ONLY the raw agent system prompt body (from .md body or builtin `systemPrompt` field). No preamble, no metadata, no task text. Exact content that would appear after the `---` frontmatter separator in the .md file.
- **Task delivery:** The task is passed as a CLI positional argument to pi. Format: `Task: ${task.task}`. This becomes the user prompt that pi processes.
- **No temp file created** if the agent's system prompt body is empty/whitespace. In that case, `--append-system-prompt` is omitted and the child uses pi's default system prompt only.

```typescript
// Pseudocode:
const args = ["--mode", "json", "-p", "--no-session"];
if (resolvedModel) args.push("--model", resolvedModel);
args.push("--tools", resolvedTools.join(","));

if (agentPrompt.trim()) {
  const tmpFile = writeTempFile(agentPrompt);
  args.push("--append-system-prompt", tmpFile);
}

// Task is the positional prompt argument
args.push(`Task: ${task.task}`);
```

### Gap 3: `onUpdate` streaming payload shape

**Question:** What does `onUpdate` deliver during parallel task streaming?

**Resolution:** The `onUpdate` payload shows a status summary of ALL tasks plus live task details:

```typescript
// While tasks are running:
onUpdate?.({
  content: [{
    type: "text",
    text: `Tasks: ${doneCount}/${totalCount} done, ${runningCount} running...`,
  }],
  details: makeLiveDetails(allLiveSummaries),
});
```

**What triggers an `onUpdate` call:**
- A child emits a `message_end` event (task made progress)
- A child transitions status (queued → running → completed/error/aborted)

**What the `details` field contains at update time:**
- `LiveSubagentToolDetails`
- each running task carries `status`, `isPartial`, and `latestOutput`
- each completed/failed task carries its terminal `status`, `stopReason`, and final `latestOutput`
- these live details are for rendering only and are never persisted into session history

This keeps the LLM-visible `content[0].text` simple (just a status line) while the live `details` drives rich rendering via `renderResult`.

### Gap 4: Final result text shape and mixed batch semantics

**Question:** When multiple tasks complete, what's the shape of the `content` returned to the main agent, and when is the overall tool result considered an error?

**Resolution:** A structured text summary that the main agent can parse, with partial success allowed:

```typescript
const successCount = results.filter(r => r.status === "completed").length;
const summaries = results.map(r => {
  const status = r.status === "completed" ? "completed" : "failed";
  const output = r.finalOutput.slice(0, 200) + (r.finalOutput.length > 200 ? "..." : "");
  return `[${r.agent}] ${status}: ${output || "(no output)"}`;
});

return {
  content: [{
    type: "text",
    text: `Tasks: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
  }],
  details: {
    mode: "tasks",
    taskCount: results.length,
    summaries: persistedTaskSummaries,
  },
  isError: successCount === 0,
};
```

**Batch semantics:**
- sibling tasks continue running even if another task fails
- the overall tool result is successful if at least one task succeeds
- the overall tool result is an error only if zero tasks succeed, or the full batch is aborted before any success
- failed tasks are still listed explicitly in both `content` and persisted summaries

**For single-task batches (tasks array of length 1):**
```typescript
return {
  content: [{ type: "text", text: singleResult.finalOutput || "(no output)" }],
  details: { mode: "tasks", taskCount: 1, summaries: [persistedTaskSummary] },
  isError: singleResult.status !== "completed",
};
```

**Rationale:** Single-task returns just the output directly (lean context). Multi-task returns a structured summary so the main agent knows which agent produced what.

### Gap 5: Tool inheritance when an agent omits `tools`

**Question:** If an agent does not declare `tools`, what does it inherit?

**Resolution:** The built-in `build` agent no longer depends on inherited tools; it always declares `DEFAULT_BUILD_TOOLS`. Any other agent that omits `tools` inherits only the parent's active built-in subset.

```typescript
// Built-in build agent:
const buildAgent = {
  name: "build",
  tools: [...DEFAULT_BUILD_TOOLS],
};

// For agents that omit tools:
const parentActiveTools = pi.getActiveTools().map(t => t.name);
const inheritedBuiltins = parentActiveTools.filter(name => ALLOWED_CHILD_BUILTINS.includes(name));
const resolvedTools = inheritedBuiltins.length > 0
  ? inheritedBuiltins
  : [...DEFAULT_BUILD_TOOLS];
```

This means:
- the built-in `build` agent always gets coding tools
- custom agents without `tools` inherit only active built-in tools from the parent
- extension tools (including `subagent`) never pass through
- if the inherited built-in subset is empty, fallback to `DEFAULT_BUILD_TOOLS` with a warning

### Gap 6: `--model` flag format passed to child

**Question:** What exact string format is passed to the child's `--model` flag?

**Resolution:** Always pass the full `provider/model-id` format. Pi's `--model` flag accepts this format directly (confirmed from `--help`: "supports `provider/id`").

```typescript
// After resolution:
const resolvedModel = "anthropic/claude-haiku-4-5";  // always provider/id
args.push("--model", resolvedModel);
```

**How the parent obtains this format:**
- From task parameter: already in `provider/model-id` form (validated)
- From agent definition: stored in `provider/model-id` form
- From parent model inheritance: `ctx.model` → format as `${model.provider}/${model.id}`

**Assumption:** Both parent and child share the same pi installation and global config (same `~/.pi/agent/` directory, same auth, same providers). This is inherently true for subprocess spawning since the child loads the same pi binary and config files.

### Gap 7: Session shutdown cleanup

**Question:** How is the runtime tracker cleared on session end?

**Resolution:** Register explicit cleanup handlers:

```typescript
pi.on("session_shutdown", async (_event, _ctx) => {
  // Kill any still-running subagent processes
  for (const instance of tracker.instances.values()) {
    if (instance.status === "running" && instance.process) {
      instance.process.kill("SIGTERM");
    }
  }
  // Clear all runtime state
  tracker.instances.clear();
});

pi.on("session_before_switch", async (_event, _ctx) => {
  // Also clear when switching sessions
  for (const instance of tracker.instances.values()) {
    if (instance.status === "running" && instance.process) {
      instance.process.kill("SIGTERM");
    }
  }
  tracker.instances.clear();
});
```

**Process cleanup guarantee:** The `finally` block in the runner already handles per-task cleanup (temp files, process handles). The session-level handlers are a safety net for the runtime tracker's Map.

### Gap 8: Child model registry mismatch

**Question:** What if the parent validates a model that the child process can't resolve?

**Resolution:** This cannot happen under normal operation because:
1. Parent and child share the same pi binary
2. Parent and child share the same `~/.pi/agent/` config directory
3. Parent and child share the same environment variables (API keys)
4. The `--model` flag is passed as an exact `provider/model-id` that was confirmed to exist in the parent's registry

**Edge case:** If a dynamically-registered provider (from an extension via `pi.registerProvider()`) provides the model, the child may not have that provider because extensions can differ between parent and child contexts.

**Handling:** This is an inherent limitation of the subprocess model. If the parent's chosen model comes from a dynamically-registered extension provider:
- The child will fail with a model-not-found error
- This surfaces as a child exit code != 0 with stderr explaining the model issue
- The parent reports this as a task error

**Mitigation (not for v2.1):** A future in-process path would share the model registry and avoid this entirely. For v2.1, document this as a known limitation: models from extension-registered providers may not be available to subagents.

---

## Appendix B — Package Configuration

**`package.json`:**
```json
{
  "name": "subagents-vflo",
  "description": "Pi extension for delegating tasks to specialized subagents with isolated context",
  "private": true,
  "type": "module",
  "keywords": ["pi-package", "pi-extension", "subagents"],
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*"
  },
  "pi": {
    "extensions": ["./src"]
  }
}
```

**Registered commands:** None in v2.1. The extension provides only the `subagent` tool and lifecycle event handlers. A `/subagents` command to list running agents is out of scope for v2.1.

---

## Phase 3 — Full TUI Mode

Phase 3 is a committed later phase, built on top of the already-working subprocess core from Phases 1–2.

### 3.1 State Management

```typescript
interface SubagentTracker {
  instances: Map<string, RuntimeSubagentInstance>;
  mode: "main" | "subagent";
  selectedIndex: number;

  add(instance: RuntimeSubagentInstance): void;
  getOrdered(): RuntimeSubagentInstance[];
  cycleView(direction: -1 | 1): void;
  enterSubagentMode(): void;
  exitSubagentMode(): void;
}
```

### 3.2 Keyboard Shortcuts

```typescript
pi.registerShortcut("ctrl+down", {
  description: "Switch to subagent view",
  handler: async (_ctx) => {
    if (tracker.instances.size === 0) return;
    tracker.enterSubagentMode();
  },
});

pi.registerShortcut("ctrl+up", {
  description: "Return to main view",
  handler: async (_ctx) => {
    tracker.exitSubagentMode();
  },
});
```

### 3.3 Render-Patch View

**Approach:** use the same class of render-patch technique as the sidebar pattern, but only after the stable core is complete.

**When in subagent mode, render:**
1. **Tab bar**: all runtime subagent instances with status icons
2. **Conversation body**: selected subagent's live or completed conversation, reconstructed from runtime tracker state
3. **Footer hint**: navigation + abort hints

### 3.4 Context-Aware Abort in TUI Mode

When in subagent mode:
- Escape aborts the currently selected subagent if it is still running
- If the selected subagent is already completed, Escape returns to main view
- Ctrl+up always returns to main view without aborting

When in main mode:
- standard pi Escape behavior applies
- aborting the main agent aborts all running child subprocesses through the same signal path used in Phase 1

### 3.5 Acceptance Criteria — Phase 3

- [ ] Ctrl+down enters subagent mode showing the most recent live or completed task
- [ ] Left/right arrows cycle between subagent tabs
- [ ] Ctrl+up returns to main view
- [ ] Running subagents show real-time streaming content
- [ ] Completed subagents show full live-session conversation reconstructed from the runtime tracker
- [ ] Escape in subagent mode aborts only the selected running subagent
- [ ] Tab bar updates dynamically as subagents start/complete
- [ ] If the render patch cannot be applied safely, Phase 1/2 tool-row behavior remains fully functional

---

## Phase 3 Technical Appendix — Render Patch Mechanics

This appendix exists so Phase 3 is implementation-ready rather than hand-wavy.

### A. Hook points

Phase 3 may patch the same class of internal TUI surfaces used by the sidebar pattern.

**Required hook capabilities:**
- replace or wrap the main conversation render path while `tracker.mode === "subagent"`
- request rerender when runtime tracker state changes
- intercept selected keys while subagent mode is active
- restore original behavior when subagent mode exits

**Feasibility gate:**
Before implementing Phase 3, verify that the current pi version still exposes the required render and input hook surfaces. If not, stop Phase 3 and keep the working Phase 1/2 tool-row UX until a new supported technique is chosen.

### B. Key handling rules

**Handled only while `tracker.mode === "subagent"`:**
- left/right: cycle selected instance
- escape: abort selected running subagent, or exit mode if already completed

**Handled via normal registered shortcuts in all modes:**
- Ctrl+down: enter subagent mode
- Ctrl+up: return to main view

**Fallthrough rule:**
If a key is not handled by subagent mode, pass it through to the original TUI/input handler.

### C. Render invalidation rules

A rerender must be requested when:
- a child JSON event arrives
- stderr changes for a running child
- a child transitions queued → running → completed/error/aborted
- the selected tab changes
- the user enters or exits subagent mode
- a running child is aborted

### D. Data source split

**Live subagent TUI uses:**
- `SubagentTracker.instances`
- runtime-only full child events
- normalized rolling summaries

**Persisted history rendering after resume uses:**
- summary-only tool result details from Phase 1

Therefore Phase 3 live inspection is a current-session feature. After a restart or resume, completed tasks still render through persisted summaries, but raw live-session event streams are not reconstructed.

### E. Conversation reconstruction rules

Phase 3 must reconstruct each task conversation deterministically from the runtime tracker.

**Transcript source of truth:**
- child JSON events stored in `RuntimeSubagentInstance.events`
- normalized live state from `RuntimeSubagentInstance.summary`
- stderr from `RuntimeSubagentInstance.stderr`

**Reconstruction rules:**
1. **Assistant text:**
   - accumulate assistant text from child message lifecycle events in arrival order
   - while a task is still running, show the latest partial assistant text using `LiveTaskSummary.latestOutput`
   - once the task completes, freeze the final assistant markdown from the terminal message state
2. **Tool activity:**
   - group tool activity by `toolCallId`
   - show each tool call in source order with its latest partial/final result beneath it
   - when only finalized tool result events are available, render from the finalized call/result pair rather than inventing intermediate states
3. **stderr:**
   - never merge stderr into assistant markdown
   - render stderr in a dedicated stderr block/section for that task
   - collapse or omit the section when stderr is empty
4. **Usage:**
   - attach usage totals from finalized assistant messages to the task header/footer area
   - keep per-task aggregate usage visible even when the body is focused on transcript content
5. **Running vs completed tasks:**
   - running tasks render live text, in-progress tool activity, and current status badges
   - completed/error/aborted tasks render a frozen transcript plus final status metadata
6. **Resume behavior:**
   - after session restart/resume, do not attempt to rebuild raw live transcripts
   - render from persisted summary-only details instead

These rules are required so Phase 3 does not depend on ad hoc interpretation during implementation.

### F. Fallback behavior

If any of the following occurs:
- required TUI hook surfaces are missing
- render patching is unstable on the current pi version
- another render-patching extension causes incompatible behavior

then the extension must:
1. refuse to enter subagent mode
2. notify the user that advanced subagent TUI is unavailable
3. keep the Phase 1/2 tool-row rendering fully functional

This is a failure-safe fallback, not a replacement for Phase 3.

### G. Compatibility stance

The plan does **not** guarantee transparent coexistence with every other render-patching extension.

Instead, Phase 3 guarantees:
- normal operation when the patch surfaces are available and compatible
- graceful fallback to tool-row rendering when they are not

This is stricter and more realistic than promising full compatibility with every sidebar-style extension.

---

## Security / Trust Model

**Project-local agents (`.pi/agents/*.md`) are always loaded.**

This is a deliberate convenience choice with the following implications:
- these files are repo-controlled prompt inputs
- they can influence LLM behavior, tool usage, and file access
- a malicious `.pi/agents/build.md` could instruct the agent to exfiltrate data or modify files
- users should only use this extension in repositories they trust

This matches the trust model of other repo-controlled config (`AGENTS.md`, `.pi/extensions/`, etc.) — pi already loads project-local extensions and context files from the repo.

If a stronger security boundary is needed in the future, add a `trustMode` setting:
- `"user-only"` — ignore project agents
- `"both"` — load both (current default)
- `"both-confirm"` — load both but confirm before executing project agents

---

## Implementation Order

### Phase 1 — Stable subprocess core
1. Create extension skeleton (`package.json`, `src/index.ts`)
2. Implement agent discovery with fallback built-ins and precedence rules
3. Implement model resolution helper with exact validation + warn-on-fallback
4. Implement tool resolution helper with explicit built-in-only child tool lists
5. Implement cwd resolution helper
6. Implement subprocess runner (spawn, collect events, cleanup)
7. Implement runtime tracker (full in-memory events only)
8. Implement summary-only persisted tool-result details
9. Register tool with `tasks[]` schema and prompt guidelines
10. Implement tool execution (spawn queued/parallel tasks, stream updates, return results)
11. Implement `renderCall` / `renderResult`
12. Implement usage tracking
13. Validate abort/cleanup behavior

### Phase 2 — Validation and polish
14. Error handling for all edge cases
15. Test with `explore` + `build` defaults
16. Test with custom `.md` agents
17. Test project-agent discovery from nearest ancestor `.pi/agents/`
18. Test parallel execution with concurrency limits
19. Verify model override and fallback warnings
20. Verify child tool exposure policy (`subagent` never active in child)
21. Verify runtime/persisted state split

### Phase 3 — Full TUI mode
22. Run the feasibility gate from the technical appendix
23. Implement `SubagentTracker` view state
24. Register Ctrl+down/up shortcuts
25. Implement render patch for subagent mode
26. Implement tab bar rendering
27. Implement conversation body rendering from runtime tracker state
28. Implement left/right cycling + context-aware abort
29. Implement graceful fallback when render patching is unavailable or incompatible
30. Validate stability with live streaming subagents

### Optional future work
- In-process `createAgentSession()` path for reduced latency
- Configurable concurrency limits via settings
- `trustMode` setting for project-agent security
- Chain mode re-introduction if needed
- Inheriting selected parent system-prompt customizations if a real use case emerges

---

## Dependencies

- `@earendil-works/pi-coding-agent` (peer dep) — `parseFrontmatter`, `getAgentDir`, `getMarkdownTheme`, types
- `@earendil-works/pi-tui` (peer dep) — `Text`, `Container`, `Markdown`, `Spacer`
- `typebox` — tool parameter schemas
- `@earendil-works/pi-ai` — `StringEnum`

---

## Remaining Risks

1. **TUI render patch stability** — Phase 3 depends on internal TUI hook surfaces. Mitigated by a feasibility gate and graceful fallback to Phase 1/2 tool-row rendering.

2. **Runtime memory from full event retention** — Raw child events are retained in memory for the current session only, with no hard runtime cap in v2.1. This is an accepted tradeoff, mitigated only by bounded task concurrency, session-lifetime scope, and keeping raw events out of persisted tool-result details.

3. **Ctrl+down/Ctrl+up shortcut conflicts** — May conflict with terminal emulators. Need to verify availability during Phase 3. Can be remapped if needed.

4. **Project-agent trust** — Always including project agents means untrusted repos can inject prompts. Documented prominently. Future mitigation via `trustMode`.

5. **Subprocess startup latency** — ~1–2s per agent spawn. Acceptable for v2.1. Future mitigation via in-process path or process pooling.

6. **Extension-registered provider models** — Models from dynamically-registered providers (via `pi.registerProvider()` in other extensions) may not be resolvable in child subprocesses. Documented in Gap 8. No mitigation in v2.1; future in-process path resolves this.
