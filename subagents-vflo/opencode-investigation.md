# OpenCode Subagent Investigation

## 1. GitHub Copilot Premium Request Headers

**File:** `/buildstore/repos/opencode/packages/opencode/src/plugin/github-copilot/copilot.ts`

**Header:** `x-initiator` with values `"agent"` or `"user"`

### How it works:

In the custom `fetch` wrapper (lines ~100-160), opencode inspects the request body to determine if the last message is from a user or an agent-initiated continuation:

```typescript
const { isAgent } = iife(() => {
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body

  // Completions API
  if (body?.messages && url.includes("completions")) {
    const last = body.messages[body.messages.length - 1]
    return { isAgent: last?.role !== "user" || imgMsg(last) }
  }

  // Responses API
  if (body?.input) {
    const last = body.input[body.input.length - 1]
    return { isAgent: last?.role !== "user" || imgMsg(last) }
  }

  // Messages API (Anthropic)
  if (body?.messages) {
    const last = body.messages[body.messages.length - 1]
    const hasNonToolCalls = Array.isArray(last?.content) && last.content.some((part) => part?.type !== "tool_result")
    return { isAgent: !(last?.role === "user" && hasNonToolCalls) || imgMsg(last) }
  }
})

const headers = {
  "x-initiator": isAgent ? "agent" : "user",
  // ...
}
```

### Additionally, in the `chat.headers` hook (lines ~345-390):

```typescript
"chat.headers": async (incoming, output) => {
  if (!incoming.model.providerID.includes("github-copilot")) return

  // Compaction messages → agent
  if (parts?.data.parts?.some((part) => part.type === "compaction" || ...)) {
    output.headers["x-initiator"] = "agent"
    return
  }

  const session = await sdk.session.get(...)
  if (!session || !session.data.parentID) return
  // mark subagent sessions as agent initiated
  output.headers["x-initiator"] = "agent"
}
```

**Key insight:** Any session with a `parentID` (i.e., a child/subagent session) automatically gets `x-initiator: agent`. This prevents subagent requests from consuming premium request quotas.

---

## 2. Subagent TUI Observability

### Navigation Shortcut
**File:** `/buildstore/repos/opencode/packages/opencode/src/cli/cmd/run/footer.view.tsx` (line 93)

The shortcut is **Ctrl+[1-9]** (not Ctrl+down):

```typescript
function subagentShortcut(event) {
  if (!event.ctrl || event.meta || event.super) return undefined
  if (!/^[0-9]$/.test(event.name)) return undefined
  const slot = Number(event.name)
  return slot === 0 ? 9 : slot - 1
}
```

### Tab Navigation
Within the subagent inspector view, **Tab** cycles forward, **Escape** closes:

```typescript
useKeyboard((event) => {
  if (event.name === "escape") { props.onClose(); return }
  if (event.name === "tab" && !event.shift) { props.onCycle(1); return }
  if (event.name === "up" || event.name === "k") { scroll?.scrollBy(-1); return }
  if (event.name === "down" || event.name === "j") { scroll?.scrollBy(1) }
})
```

### Data Structures

**File:** `/buildstore/repos/opencode/packages/opencode/src/cli/cmd/run/types.ts`

```typescript
type FooterPromptRoute =
  | { type: "composer" }
  | { type: "subagent"; sessionID: string }
  | { type: "command" }
  | { type: "model" }
  | { type: "variant" }

type FooterSubagentTab = {
  sessionID: string
  partID: string
  callID: string
  label: string       // Agent type (e.g., "Explore", "General")
  description: string // Task description
  status: "running" | "completed" | "error"
  title?: string
  toolCalls?: number
  lastUpdatedAt: number
}

type FooterSubagentDetail = {
  sessionID: string
  commits: StreamCommit[]  // Stream of rendered output
}

type FooterSubagentState = {
  tabs: FooterSubagentTab[]
  details: Record<string, FooterSubagentDetail>
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
}
```

### Rendering
**File:** `/buildstore/repos/opencode/packages/opencode/src/cli/cmd/run/footer.subagent.tsx`

- `SUBAGENT_TAB_ROWS = 2` — tab bar height
- `SUBAGENT_INSPECTOR_ROWS = 8` — inspector panel height
- Tabs show spinner for running, `●` for completed, `◍` for error
- Inspector body is a scrollbox that renders `StreamCommit` entries

---

## 3. Model Configuration for Subagents

**File:** `/buildstore/repos/opencode/packages/opencode/src/tool/task.ts`

Each agent's config has an optional `model` field. Resolution order:

```typescript
const model = next.model ?? {
  modelID: msg.info.modelID,
  providerID: msg.info.providerID,
}
```

If the agent definition specifies a model → that's used.
Otherwise → inherits the parent message's model.

Users can set per-agent models in `opencode.json`:
```json
{
  "agent": {
    "explore": {
      "model": "provider/model-id"
    }
  }
}
```

---

## 4. Agent Discovery and Definition

**File:** `/buildstore/repos/opencode/packages/opencode/src/config/agent.ts`

Discovery paths:
```typescript
Glob.scan("{agent,agents}/**/*.md", { cwd: dir, ... })
```

Agent file format (Markdown + YAML frontmatter):
```markdown
---
model: provider/model-id
description: "When to use this agent"
mode: subagent
permission:
  edit: deny
  bash: allow
---

System prompt content goes here.
```

Schema fields: `model`, `variant`, `temperature`, `top_p`, `prompt` (body), `description`, `mode` ("subagent"|"primary"|"all"), `hidden`, `color`, `steps`, `permission`, `disable`, `options`

---

## 5. Subagent Tool Definition

**File:** `/buildstore/repos/opencode/packages/opencode/src/tool/task.ts`

Tool ID: `"task"`

Parameters:
```typescript
{
  description: string,       // "A short (3-5 words) description"
  prompt: string,            // "The task for the agent to perform"
  subagent_type: string,     // "The type of specialized agent to use"
  task_id?: string,          // Resume a previous task session
  background?: boolean,      // Launch async (experimental)
}
```

Execution flow:
1. Permission check
2. Resolve target agent
3. Create child session with `sessions.create({ parentID: ctx.sessionID, ... })`
4. Run LLM loop in child session via `ops.prompt()`
5. Return last assistant text part wrapped in `<task_result>` tags

---

## 6. Lifecycle Management

### Starting
Creates a new session with `parentID` pointing to the main session, then runs the LLM loop in-process.

### Monitoring
- TUI tracks subagents by watching for tool parts with `tool === "task"`
- Events from child sessions are routed to the appropriate detail state
- Frame buffer capped at 80 entries

### Termination
- Foreground: runs to completion within parent's tool call; on abort, `ops.cancel(sessionId)` is called
- Background: managed by BackgroundJob.Service; result injected back as synthetic user message

### Parallel Execution
The LLM makes multiple `task` tool calls in one response → they execute in parallel naturally.

### Context/State Isolation
Each subagent has its own session (separate message history). The child session:
- Has its own permission ruleset derived from parent
- Cannot use recursive `task` unless explicitly allowed
- Gets a fresh context unless `task_id` is provided for resumption
