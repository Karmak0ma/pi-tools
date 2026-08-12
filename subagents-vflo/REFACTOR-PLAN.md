# Subagent Inspector — Complete Architectural Refactor Plan

**Date:** 2026-05-28  
**Status:** Final v3 (two rounds of review incorporated, user decisions applied)

---

## Table of Contents
1. [Problem Statement & Root Causes](#1-problem-statement--root-causes)
2. [Solution: Why Component Tree Architecture Fixes Everything](#2-solution-why-component-tree-architecture-fixes-everything)
3. [Architectural Decisions (All Verified)](#3-architectural-decisions-all-verified)
4. [Event-to-Component Mapping Specification](#4-event-to-component-mapping-specification)
5. [Implementation Phases](#5-implementation-phases)
6. [Risk Mitigations](#6-risk-mitigations)
7. [Testing Strategy](#7-testing-strategy)

---

## 1. Problem Statement & Root Causes

### User-Visible Symptoms
- Ghosting / stale lines during scrolling and tab switching
- Overlapping text after PgUp/PgDn
- Visual contamination when switching between tabs
- Syntax highlighting instability (especially C/C++)
- Inspector looks different from the main agent UI
- Header line intermittently missing
- Flicker during tool-heavy subagent activity

### Root Causes (from RENDERING-DEEP-ANALYSIS.md)

| # | Root Cause | Impact |
|---|-----------|--------|
| 1 | **`frameMarker` forces full-screen diff every frame** | Every render rewrites all rows → flicker on imperfect sync |
| 2 | **Manual line assembly produces unstable string output** | Diff algorithm can't identify unchanged lines → excessive repaints |
| 3 | **`Markdown` instances recreated every render frame** | Different ANSI output for same content → diff sees changes where there are none |
| 4 | **`clearOnShrink` disabled during overlay** | If content height ever shrinks between frames → ghost rows persist |
| 5 | **No built-in component caching** | Every render re-computes everything from scratch → O(n) per frame |
| 6 | **Custom highlighting code differs from main UI** | Different visual appearance, highlighting bugs unique to the inspector |
| 7 | **process.stdout.rows race condition** | Component returns wrong line count → viewport mismatch |

### Why Previous Fixes Didn't Work

The investigation log shows 22+ attempted fixes. Most failed because they addressed **symptoms** not **root causes**:
- Padding to full width/height → fights issue #4 but can't prevent all cases
- Render cache removal → removed one stale-frame source but lost stability (issue #5)
- `frameMarker` → intended to force repaints for issue #4 but created issue #1
- Custom highlighting improvements → can never achieve parity (issue #6)
- Throttling adjustments → reduce frequency but don't fix underlying instability (issue #2)

**The fundamental problem:** The inspector uses a custom rendering path (manual string assembly) that is structurally incompatible with pi-tui's differential rendering algorithm, which requires stable output for unchanged content.

---

## 2. Solution: Why Component Tree Architecture Fixes Everything

### The Fix in One Sentence

Replace all manual string assembly with pi-tui's `Container`/child component tree and use pi-coding-agent's exported `AssistantMessageComponent` and `ToolExecutionComponent` — the same components the main UI uses.

### How This Solves Each Root Cause

| Root Cause | How the refactor fixes it |
|-----------|--------------------------|
| **1. frameMarker** | **Removed entirely.** Components with unchanged state produce identical string output → diff works correctly → no need to force repaints |
| **2. Unstable string output** | **Eliminated.** Components cache their rendered lines internally. Same state = same strings = same bytes. The diff algorithm correctly identifies unchanged rows and skips them. |
| **3. Markdown re-instantiation** | **Eliminated.** `AssistantMessageComponent` internally manages its own `Markdown` instance and caches output. Only invalidates when `updateContent()` is called with new data. |
| **4. clearOnShrink disabled (contributing factor, not proven root cause)** | **Mitigated.** Tab switches use `tui.requestRender(true)` which forces a full clear+render. Normal scrolling pads to fill viewport height. If scroll-time artifacts remain, fallback to force-redraw on page navigation (see Fallback Strategy). |
| **5. No caching** | **Built-in.** Each component caches its render output until invalidated. A 50-component transcript only re-renders the one component that changed. |
| **6. Different highlighting** | **Eliminated for content rendering.** We use the exact same `AssistantMessageComponent` → same `Markdown` → same `highlightCode()` → identical output for transcript content. |
| **7. process.stdout.rows race** | **Mitigated.** The top-level inspector shell reads `process.stdout.rows` once per render and passes height down to the viewport utility. Consistent height within a single frame. |

### Why This is The Best Solution

1. **Strong content rendering parity** — Same components for assistant messages and tools = same rendering for transcript content. Shell/chrome (tab bar, footer, header) remains custom but simple.
2. **Differential rendering works correctly** — Stable output is guaranteed by component caching.
3. **Streaming is efficient** — Only the last component updates; O(1) per delta instead of O(n).
4. **Future-proof** — When the main UI improves (new themes, better highlighting), the inspector inherits changes automatically.
5. **Less code** — We delete ~500 lines of custom rendering logic and replace with ~200 lines of component wiring.

### Parity Scope (Important Clarification)

This refactor achieves **strong parity for content rendering:**
- Assistant messages (markdown, code, thinking blocks)
- Built-in tool execution rendering (bash, read, edit, write, etc.)
- Code highlighting and themes

It does **not** guarantee parity for:
- Inspector shell/chrome (tab bar, footer, task header) — these are custom and unique to the inspector
- Arbitrary extensions that modify the main UI layout
- Features that depend on the main transcript view structure rather than leaf message/tool components

### Fallback Strategy for Remaining Ghosting

If scroll-time or streaming artifacts persist after the refactor (because some ghosting may stem from overlay compositing rather than content instability):

1. **First expansion:** Force redraw on page navigation (`PgUp`/`PgDn`) in addition to tab switch
2. **Second expansion:** Force redraw on any scroll when transcript is actively streaming
3. **Last resort:** Force redraw on every render (equivalent to current `frameMarker` but using the correct API)

These fallbacks progressively trade differential rendering efficiency for correctness. Only enable as needed based on observed behavior.

---

## 3. Architectural Decisions (All Verified)

### Decision 1: Component Tree Architecture

**Choice:** Build the inspector as a `Container` with child components from pi-coding-agent.

**Verification:** ✅
- `AssistantMessageComponent extends Container` — nestable ✅
- `ToolExecutionComponent extends Container` — nestable ✅
- Both export `render(width): string[]` per the `Component` interface ✅
- Both cache output internally ✅

---

### Decision 2: Virtual Scroll with Slice

**Choice:** Render all transcript components into a virtual document, slice to viewport.

**Rationale:**
- Overlays are constrained to `maxHeight` — component must manage its own scroll
- Components have variable height dependent on width — must render to know height
- Slice-after-render is O(render all) but with caching becomes O(render changed)
- On subsequent frames, cached components return instantly → only the slice operation costs anything

**Implementation detail:**

`TranscriptViewport` is a **utility/service**, not a `Component`. It does not implement the pi-tui `Component` interface because `Component.render()` only takes `width` — there is no height parameter. Instead, the top-level `InspectorComponent` calls it directly with both width and height.

```typescript
class TranscriptViewport {
  private cachedLines: string[] = [];  // full virtual document
  private dirty: boolean = true;       // set true when any child invalidates
  private children: Component[] = [];
  private scrollOffset: number = 0;
  private _viewportHeight: number = 20;
  
  getVisibleLines(width: number, viewportHeight: number): string[] {
    this._viewportHeight = viewportHeight;
    if (this.dirty || this.lastWidth !== width) {
      this.cachedLines = [];
      for (const child of this.children) {
        this.cachedLines.push(...child.render(width));
      }
      this.dirty = false;
      this.lastWidth = width;
    }
    // Clamp scroll
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, this.getMaxScroll()));
    // Slice to viewport
    const visible = this.cachedLines.slice(this.scrollOffset, this.scrollOffset + viewportHeight);
    // Pad to fill viewport
    while (visible.length < viewportHeight) visible.push("");
    return visible;
  }
}
```

---

### Decision 3: Use Standard Components with Direct Event Data

**Choice:** Pass `AssistantMessage` objects from events directly to `AssistantMessageComponent`.

**Critical verification — streaming:** ✅ VERIFIED

The `message_update` event structure is:
```typescript
{
  type: "message_update",
  message: AgentMessage,                    // Full partial message at this point
  assistantMessageEvent: AssistantMessageEvent  // Has `partial: AssistantMessage`
}
```

The `assistantMessageEvent.partial` field contains the **full accumulated `AssistantMessage` object** at each streaming point. This means:
- We do NOT need to manually accumulate delta strings
- We do NOT need to construct fake `AssistantMessage` objects
- We pass `event.assistantMessageEvent.partial` directly to `component.updateContent()`

**Data flow for streaming:**
```
Child process emits: { type: "message_update", assistantMessageEvent: { type: "text_delta", partial: AssistantMessage } }
  → instance.events.push(event)
  → Extract: event.assistantMessageEvent.partial (full AssistantMessage at this point)
  → activeComponent.updateContent(partial)  // Component handles rendering
  → tui.requestRender()  // Diff finds only the last component's lines changed
```

---

### Decision 4: Full-Screen Overlay (Keep Current)

**Choice:** Keep `{ overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 } }`

**Rationale:**
- Full-screen coverage prevents main content bleed-through
- Overlay captures all keyboard input (no accidental main-UI interaction)
- 100% width means compositing replaces entire lines (no edge artifacts)

---

### Decision 5: Force Full Redraw on Tab Switch

**Choice:** Call `tui.requestRender(true)` on tab switch to force clear+render.

**Verification:** ✅ VERIFIED

The `tui` parameter in the factory callback IS the full `TUI` instance (`this.ui`). The signature:
```typescript
requestRender(force?: boolean): void;
```
Force mode:
1. Resets `previousLines = []`, `previousWidth = -1`, `previousHeight = -1`
2. Next render calls `fullRender(true)` which outputs `\x1b[2J\x1b[H\x1b[3J` (full screen clear)
3. Writes all new lines fresh — zero ghosting possible

**Why only on tab switch:** Normal scrolling doesn't change which components are rendered — only which slice of the cached document is visible. The slice always returns exactly `viewportHeight` lines. Lines that don't change between frames produce identical strings → diff skips them naturally.

---

### Decision 6: Per-Tab Component Tree Caching

**Choice:** Maintain `Map<instanceId, TabState>` with component trees that persist across frames.

**Structure:**
```typescript
interface TabState {
  components: Component[];                    // Ordered transcript components
  lastProcessedEventIndex: number;            // How far we've consumed events[]
  activeAssistantMessage?: AssistantMessageComponent;  // For streaming updates
  activeToolExecutions: Map<string, ToolExecutionComponent>;  // By toolCallId
  dirty: boolean;                             // Whether virtual doc needs rebuild
}
```

**Lifecycle:**
- First tab access → create TabState, process all events, create components
- Subsequent renders → only process new events (events beyond `lastProcessedEventIndex`)
- Streaming delta → update `activeAssistantMessage` in place
- Tab switch → swap to different TabState (no rebuilding)
- Instance completed → mark TabState as finalized (skip event processing forever)

---

### Decision 7: Remove All Throttle Layers Except Pi-TUI's Built-in 16ms

**Choice:** Remove the `SubagentTuiManager` 50ms throttle. Keep `ThrottledUpdater` at 150ms for data arrival only.

**Rationale:**
- The 150ms `ThrottledUpdater` already limits how often new data triggers updates
- Pi-TUI's built-in 16ms interval ensures renders don't flood the terminal
- The 50ms middle layer only adds latency without preventing any actual problem
- With component-level caching, even rapid `requestRender()` calls are cheap (no actual recomputation if nothing changed)

---

## 4. Event-to-Component Mapping Specification

This is the complete mapping from child process events to inspector components:

### Event: `message_start`
```
{ type: "message_start", message: { role: "assistant", ... } }
```
**Action:** Create new `AssistantMessageComponent(undefined, false, getMarkdownTheme())`. Store as `activeAssistantMessage`. Append to `components[]`.

### Event: `message_update` (streaming)
```
{ type: "message_update", message: AgentMessage, assistantMessageEvent: { type: "text_delta"|"thinking_delta"|..., partial: AssistantMessage } }
```
**Action:** Call `activeAssistantMessage.updateContent(event.assistantMessageEvent.partial)`. Call `requestRender()`.

### Event: `message_end`
```
{ type: "message_end", message: { role: "assistant", content: [...toolCalls...], ... } }
```
**Action:** 
1. Call `activeAssistantMessage.updateContent(event.message as AssistantMessage)` with the final message.
2. Set `activeAssistantMessage = undefined`.
3. For each `ToolCall` in `message.content` where `part.type === "toolCall"`:
   - Create `new ToolExecutionComponent(part.name, part.toolCallId || part.id, part.arguments, { showImages: false }, undefined, tui, instance.cwd)`
   - Call `component.setArgsComplete()` — args are known in full from the `message_end` event
   - Store in `activeToolExecutions.set(toolCallId, component)`
   - Append to `components[]`

### Event: `tool_execution_start`
```
{ type: "tool_execution_start", toolCallId: string, toolName: string, args: any }
```
**Action:** If `activeToolExecutions.has(toolCallId)`, call `component.markExecutionStarted()`. Otherwise, create a new `ToolExecutionComponent` (handles late-arriving tool events).

### Event: `tool_execution_update`
```
{ type: "tool_execution_update", toolCallId: string, toolName: string, args: any, partialResult: any }
```
**Action:** If `activeToolExecutions.has(toolCallId)`, call `component.updateResult(partialResult, true)`.

### Event: `tool_execution_end`
```
{ type: "tool_execution_end", toolCallId: string, toolName: string, result: any, isError: boolean }
```
**Action:** If `activeToolExecutions.has(toolCallId)`:
1. Call `component.updateResult(result, false)` (partial=false → final)
2. Remove from `activeToolExecutions`

### Event: `tool_result_end`
```
{ type: "tool_result_end", message: ToolResultMessage, toolCallId?: string }
```
**Action:** If `activeToolExecutions.has(toolCallId)` (i.e., `tool_execution_end` did NOT already finalize this tool):
- Call `component.updateResult({ content: message.content, details: message.details, isError: message.isError }, false)`
- Remove from `activeToolExecutions`
- **Precedence rule:** If the component was already finalized by `tool_execution_end`, ignore this event. `tool_execution_end` is authoritative; `tool_result_end` is fallback only.

### Tool Result Precedence Rules

Both `tool_execution_end` and `tool_result_end` can carry final results for the same tool. To avoid double-finalization:

1. **`tool_execution_*` events are primary** for component state updates
2. **`tool_result_end` is fallback only** — used when `tool_execution_end` wasn't received (edge case)
3. On `tool_execution_end`: call `updateResult(result, false)`, remove from `activeToolExecutions` map
4. On `tool_result_end`: check if component is still in `activeToolExecutions`; if yes, finalize it; if no (already removed), skip entirely
5. Never call `updateResult()` twice on the same component with `isPartial=false`

### Stderr (from child process stderr pipe)
```
instance.stderr += data
```
**Action:** Create or update a dedicated `StderrComponent` (simple `Text` with error styling) at the end of the transcript.

### Fallback: Unrecognized Events
**Action:** Ignore. Don't crash. Log to debug output if available.

### Edge Case: Empty Assistant Messages (Tool-Call-Only Messages)

When the assistant message ends with only tool calls and no visible text/thinking content:

- After `message_end`, check if the `AssistantMessageComponent` has any visible text content
- If the message contains **only** `toolCall` parts (no `text` or `thinking` content), **do not append** the `AssistantMessageComponent` to `components[]`
- Instead, only append the `ToolExecutionComponent`s created from the tool calls
- This prevents empty/blank components from occupying transcript space and affecting layout

### Dirtiness Propagation Rule (Conservative)

**Explicit rule:** Any event that mutates a child component sets `tab.dirty = true`.

Specifically:
- `message_update` → calls `updateContent()` → set `tab.dirty = true`
- `tool_execution_start` → calls `markExecutionStarted()` → set `tab.dirty = true`
- `tool_execution_update` → calls `updateResult(partial)` → set `tab.dirty = true`
- `tool_execution_end` → calls `updateResult(final)` → set `tab.dirty = true`
- New component added to `components[]` → set `tab.dirty = true`

Do NOT rely on child-to-parent invalidation propagation. The parent (`processNewEvents`) always knows when it mutates something and sets dirty explicitly.

### `clearOnShrink` Strategy

**Decision: Do nothing.** Leave `clearOnShrink` at its default value. Do not attempt to modify it while the inspector overlay is active.

**Rationale:**
- The TUI already disables `clearOnShrink` when overlays are present (it's a pi-tui internal behavior)
- The component architecture + padding to terminal height + force-redraw fallback strategy handles the cases where stale rows would otherwise persist
- Adding runtime `clearOnShrink` manipulation would couple the extension to undocumented TUI internals

---

## 5. Implementation Phases

---

### Phase 0: Validation & Proof of Concept (Prerequisite)

**Goal:** Verify all architectural assumptions with a minimal working test before committing to the full refactor.

**Tasks:**

1. **Verify `ToolExecutionComponent` works in overlay context**
   - Create a minimal test that instantiates `ToolExecutionComponent` with the `tui` parameter from the factory callback
   - Render it and verify it produces output without crashes
   - Verify `updateResult()` updates the display correctly
   - **Exit criterion:** Component renders and produces visible tool output

2. **Verify `AssistantMessageComponent` streaming with partial messages**
   - Create a component, call `updateContent()` with a partial `AssistantMessage` (single text block)
   - Verify it renders correctly
   - Call `updateContent()` again with more text → verify only new content changes
   - **Exit criterion:** Calling `updateContent()` 10 times produces stable output where only the growing text area changes

3. **Verify force redraw eliminates ghosting**
   - In the current inspector, on tab switch, replace the existing `requestRender()` call with `tui.requestRender(true)`
   - Test: switch tabs rapidly — verify no ghost content from previous tab
   - **Exit criterion:** No visual artifacts on tab switch with force redraw

4. **Verify output stability of standard components**
   - Render the same `AssistantMessageComponent` 10 times without changing content
   - Compare all 10 outputs — they must be byte-identical
   - **Exit criterion:** All 10 renders produce identical string arrays

**Estimated effort:** 2-3 hours  
**Blocker:** If any validation fails, the plan needs adjustment before Phase 1.

---

### Phase 1: Component Infrastructure

**Goal:** Create the new component files, define interfaces, build the scaffolding.

**Context for implementer:** Pi-tui components are objects with a `render(width: number): string[]` method. A `Container` is a component that has children whose render outputs are concatenated. The inspector needs to be a custom component that manages layout (header, tabs, body, footer) and delegates rendering to child components.

**Tasks:**

1. **Create directory structure:**
   ```
   src/components/
   ├── inspector.ts
   ├── tab-bar.ts
   ├── transcript-viewport.ts
   ├── task-header.ts
   ├── status-footer.ts
   └── fallback-text.ts
   ```

2. **Create `FallbackTextComponent`** (`src/components/fallback-text.ts`)
   - Simple component wrapping pre-rendered text lines
   - Used when a standard component fails to construct (error resilience)
   - Interface:
     ```typescript
     class FallbackTextComponent implements Component {
       constructor(private lines: string[]) {}
       render(width: number): string[] { return this.lines.map(l => truncateToWidth(l, width)); }
       invalidate(): void {}
     }
     ```

3. **Create `TabBarComponent`** (`src/components/tab-bar.ts`)
   - Accepts: `instances: RuntimeSubagentInstance[]`, `selectedIndex: number`, `theme: TuiTheme`
   - Renders: horizontal tab list with status icons (same visual as current)
   - Caches: output invalidates when `setInstances()` or `setSelected()` is called
   - **Selected-tab-visible algorithm:**
     - Render tabs left-to-right, wrapping to next line when width exceeded
     - Maximum 2 lines of tabs
     - If the selected tab does NOT fit in the first 2 lines of rendered tabs:
       - Use a **sliding window** centered around the selected tab
       - Show `…` prefix/suffix indicators when tabs are hidden to the left/right
     - Selected tab is ALWAYS rendered (never elided)
   - Interface:
     ```typescript
     class TabBarComponent implements Component {
       setInstances(instances: RuntimeSubagentInstance[]): void;
       setSelected(index: number): void;
       render(width: number): string[];
       invalidate(): void;
     }
     ```

4. **Create `TaskHeaderComponent`** (`src/components/task-header.ts`)
   - Accepts: `instance: RuntimeSubagentInstance`, `theme: TuiTheme`
   - Renders: agent name + status icon, model, cwd, warnings, task prompt
   - Uses `UserMessageComponent` for the task prompt → visual parity with main UI's user messages
   - **Variable height (parity-first):** renders at natural height. No artificial cap. Relies on component output stability and force-redraw to prevent layout artifacts.
   - Interface:
     ```typescript
     class TaskHeaderComponent implements Component {
       setInstance(instance: RuntimeSubagentInstance): void;
       render(width: number): string[];
       invalidate(): void;
     }
     ```

5. **Create `StatusFooterComponent`** (`src/components/status-footer.ts`)
   - Accepts: scroll metrics, instance counts, keyboard hints
   - Renders: divider + status line + hints line (3 lines total, always)
   - Interface:
     ```typescript
     class StatusFooterComponent implements Component {
       update(metrics: { total: number; running: number; completed: number; errored: number; scrollOffset: number; maxScroll: number }): void;
       render(width: number): string[];
       invalidate(): void;
     }
     ```

6. **Create `TranscriptViewport`** (`src/components/transcript-viewport.ts`)
   - **Note: This is a utility/service, NOT a `Component`**
   - The pi-tui `Component.render(width)` interface does not accept a height parameter
   - `TranscriptViewport` is called directly by `InspectorComponent` with both width and height
   - Maintains array of child components
   - Renders all children, concatenates, slices to viewport height
   - Interface:
     ```typescript
     class TranscriptViewport {
       setChildren(children: Component[]): void;
       addChild(child: Component): void;
       setScrollOffset(offset: number): void;
       scrollBy(delta: number): void;
       getMaxScroll(): number;
       get pageSize(): number;
       get scrollOffset(): number;
       markDirty(): void;
       getVisibleLines(width: number, viewportHeight: number): string[];
     }
     ```
   - Caching strategy: stores `cachedVirtualDoc: string[]` and rebuilds only when `dirty = true` or `width` changed
   - Dirtiness set externally by `InspectorComponent` when event processing updates components

7. **Create `InspectorComponent`** (`src/components/inspector.ts`) — shell only
   - Top-level component returned to `ctx.ui.custom()`
   - Orchestrates: header + tabBar + divider + taskHeader + viewport + footer
   - Implements `handleInput()` for keyboard navigation
   - Shell only in this phase — wire up in Phase 2

**Testing:**
- Unit test `TabBarComponent.render()` with 0, 1, 5 instances
- Unit test `StatusFooterComponent.render()` with various metrics
- Unit test `FallbackTextComponent.render()` with oversized lines
- Unit test `TranscriptViewport` with mock children: verify slice correctness

**Estimated effort:** 4-6 hours

---

### Phase 2: Event-to-Component Mapping & Transcript Rendering

**Goal:** Wire up the event processing pipeline to create standard pi-coding-agent components from child process events.

**Context for implementer:** The child process emits JSON events to stdout which are pushed to `instance.events[]`. These events follow the `AgentEvent` type hierarchy. Each event maps to a specific component lifecycle action (create, update, finalize). The per-tab state tracks how far we've processed and which components are "active" (still receiving updates).

**Tasks:**

1. **Create `TabState` interface and factory:**
   ```typescript
   interface TabState {
     components: Component[];
     lastProcessedEventIndex: number;
     activeAssistantMessage: AssistantMessageComponent | null;
     activeToolExecutions: Map<string, ToolExecutionComponent>;
     dirty: boolean;
     finalized: boolean;
   }
   
   function createTabState(): TabState { ... }
   ```

2. **Implement `processNewEvents(instance, tabState, tui)` function:**
   - Iterates from `tabState.lastProcessedEventIndex` to `instance.events.length`
   - For each event, applies the mapping from Section 4
   - Creates components wrapped in try-catch with FallbackTextComponent fallback
   - Updates `lastProcessedEventIndex`
   - Sets `tabState.dirty = true` when components are added/updated
   - Code structure:
     ```typescript
     function processNewEvents(instance: RuntimeSubagentInstance, tab: TabState, tui: TUI, cwd: string): void {
       const events = instance.events;
       for (let i = tab.lastProcessedEventIndex; i < events.length; i++) {
         const event = events[i];
         try {
           switch (event.type) {
             case "message_start": { /* create AssistantMessageComponent */ break; }
             case "message_update": { /* updateContent with partial */ break; }
             case "message_end": { /* finalize + create ToolExecutionComponents + setArgsComplete() */ break; }
             case "tool_execution_start": { /* markExecutionStarted */ break; }
             case "tool_execution_update": { /* updateResult partial */ break; }
             case "tool_execution_end": { /* updateResult final */ break; }
           }
         } catch (err) {
           tab.components.push(new FallbackTextComponent([`⚠ Render error: ${err}`]));
         }
         tab.dirty = true;
       }
       tab.lastProcessedEventIndex = events.length;
       
       // Mark finalized if instance is completed/error/aborted
       if (instance.status !== "running" && instance.status !== "queued") {
         tab.finalized = true;
       }
     }
     ```

3. **Implement streaming delta handling:**
   - On `message_update` with `assistantMessageEvent.partial`:
     ```typescript
     case "message_update": {
       if (event.assistantMessageEvent?.partial && tab.activeAssistantMessage) {
         tab.activeAssistantMessage.updateContent(event.assistantMessageEvent.partial);
         tab.dirty = true;
       }
       break;
     }
     ```
   - The `partial` field is a full `AssistantMessage` object — pass directly
   - No manual string accumulation needed

4. **Implement per-tab state management in the InspectorComponent:**
   ```typescript
   private tabStates: Map<string, TabState> = new Map();
   
   private getTabState(instance: RuntimeSubagentInstance): TabState {
     let tab = this.tabStates.get(instance.id);
     if (!tab) {
       tab = createTabState();
       this.tabStates.set(instance.id, tab);
     }
     if (!tab.finalized) {
       processNewEvents(instance, tab, this.tui, instance.cwd);
     }
     return tab;
   }
   ```

5. **Wire TranscriptViewport to use tab state:**
   - On render: `const tab = getTabState(selectedInstance)`
   - Set viewport children: `this.viewport.setChildren(tab.components)`
   - Viewport renders all children, slices to available height

6. **Handle the `ToolExecutionComponent` `ui` parameter:**
   - Store `tui` reference from the factory callback
   - Pass to every `ToolExecutionComponent` constructor
   - If `tui` is unavailable (edge case), create `FallbackTextComponent` instead

7. **Handle `ToolExecutionComponent.updateResult` format:**
   - The `tool_execution_end` event has: `{ toolCallId, toolName, result: any, isError: boolean }`
   - `ToolExecutionComponent.updateResult()` expects: `{ content: Array<{type, text?, data?, mimeType?}>, details?, isError }`
   - The `result` from `tool_execution_end` IS this format (same as what pi-agent-core produces)
   - If the format doesn't match (malformed event), wrap in FallbackTextComponent

**Testing:**
- Test `processNewEvents` with a sequence of message_start → message_update → message_end → tool events
- Verify correct component creation order
- Test streaming: 10 message_update events with growing partial → single component updated 10 times
- Test error resilience: malformed event doesn't crash, produces FallbackTextComponent
- Test tool pairing: tool_execution_start/end matched to correct ToolExecutionComponent by toolCallId

**Estimated effort:** 10-14 hours

---

### Phase 3: Input Handling, Scroll, and Force Redraw

**Goal:** Make the inspector fully interactive with correct scrolling and zero ghosting on navigation.

**Context for implementer:** The InspectorComponent receives all keyboard input via `handleInput(data)`. It must manage tab switching (left/right arrows), scrolling (up/down/PgUp/PgDn/Home/End), abort (Escape on running), and exit (Escape on completed, Ctrl+Up). The crucial fix: tab switching calls `tui.requestRender(true)` to force a full clear+render, eliminating all ghosting.

**Tasks:**

1. **Implement `InspectorComponent.handleInput()` (full keyboard handling):**
   ```typescript
   handleInput(data: string): void {
     if (matchesKey(data, "escape")) {
       const selected = this.getSelectedInstance();
       if (selected?.status === "running") {
         this.onAbort(selected);
       } else {
         this.onClose();
       }
       return;
     }
     
     if (matchesKey(data, "left") || matchesKey(data, "right")) {
       // Switch tab
       const instances = this.getInstances();
       if (instances.length > 0) {
         this.selectedIndex = matchesKey(data, "left")
           ? (this.selectedIndex - 1 + instances.length) % instances.length
           : (this.selectedIndex + 1) % instances.length;
         this.viewport.setScrollOffset(0);  // Reset scroll on tab switch
         this.tui.requestRender(true);  // ← THE KEY FIX: force full redraw
       }
       return;
     }
     
     if (matchesKey(data, "up")) { this.viewport.scrollBy(-1); this.tui.requestRender(); return; }
     if (matchesKey(data, "down")) { this.viewport.scrollBy(1); this.tui.requestRender(); return; }
     if (matchesKey(data, "pageup")) { this.viewport.scrollBy(-this.viewport.pageSize); this.tui.requestRender(); return; }
     if (matchesKey(data, "pagedown")) { this.viewport.scrollBy(this.viewport.pageSize); this.tui.requestRender(); return; }
     // NOTE: If ghosting persists during page navigation, upgrade these to:
     // this.tui.requestRender(true)  — force full redraw (Fallback Strategy step 1)
     if (matchesKey(data, "home")) { this.viewport.setScrollOffset(0); this.tui.requestRender(); return; }
     if (matchesKey(data, "end")) { this.viewport.setScrollOffset(Infinity); this.tui.requestRender(); return; }
     
     if (matchesKey(data, "ctrl+up")) { this.onClose(); return; }
   }
   ```

2. **Implement scroll in `TranscriptViewport` (utility class):**
   ```typescript
   class TranscriptViewport {
     private _scrollOffset = 0;
     private _viewportHeight = 20;
     private cachedVirtualDoc: string[] = [];
     private dirty = true;
     private lastWidth = -1;
     private children: Component[] = [];
     
     get pageSize(): number { return Math.max(1, this._viewportHeight - 1); }
     get scrollOffset(): number { return this._scrollOffset; }
     
     setScrollOffset(offset: number): void {
       this._scrollOffset = Math.max(0, Math.min(offset, this.getMaxScroll()));
     }
     
     scrollBy(delta: number): void {
       this.setScrollOffset(this._scrollOffset + delta);
     }
     
     getMaxScroll(): number {
       return Math.max(0, this.cachedVirtualDoc.length - this._viewportHeight);
     }
     
     markDirty(): void { this.dirty = true; }
     
     setChildren(children: Component[]): void {
       this.children = children;
       this.dirty = true;
     }
     
     getVisibleLines(width: number, viewportHeight: number): string[] {
       this._viewportHeight = viewportHeight;
       // Rebuild virtual doc if dirty or width changed
       if (this.dirty || this.lastWidth !== width) {
         this.cachedVirtualDoc = [];
         for (const child of this.children) {
           this.cachedVirtualDoc.push(...child.render(width));
         }
         this.dirty = false;
         this.lastWidth = width;
       }
       // Clamp scroll
       this._scrollOffset = Math.max(0, Math.min(this._scrollOffset, this.getMaxScroll()));
       // Slice
       const visible = this.cachedVirtualDoc.slice(this._scrollOffset, this._scrollOffset + viewportHeight);
       while (visible.length < viewportHeight) visible.push("");
       return visible;
     }
   }
   ```

3. **Implement `InspectorComponent.render()` layout:**
   ```typescript
   render(width: number): string[] {
     // Height sourcing: read process.stdout.rows once per render frame.
     // This is the same source pi-tui uses internally (this.terminal.rows).
     // Read once and pass down to ensure consistency within a single frame.
     const termHeight = process.stdout.rows || 24;
     const lines: string[] = [];
     
     // Header (2 lines)
     lines.push(theme.fg("accent", theme.bold(" ◆ Subagent Inspector")));
     lines.push(theme.fg("dim", " " + "═".repeat(Math.min(width - 2, 60))));
     
     // Tab bar (1-2 lines)
     lines.push(...this.tabBar.render(width));
     
     // Divider (1 line)
     lines.push(theme.fg("dim", " " + "─".repeat(Math.min(width - 2, 60))));
     
     // Task header (~10 lines, fixed)
     lines.push(...this.taskHeader.render(width));
     
     // Calculate available height for transcript
     const footerHeight = 3;
     const usedHeight = lines.length + footerHeight;
     const viewportHeight = Math.max(3, termHeight - usedHeight);
     
     // Transcript viewport (fills remaining space)
     lines.push(...this.viewport.getVisibleLines(width, viewportHeight));
     
     // Footer (3 lines)
     this.footer.update({
       total: instances.length,
       running: instances.filter(i => i.status === "running").length,
       completed: instances.filter(i => i.status === "completed").length,
       errored: instances.filter(i => i.status === "error").length,
       scrollOffset: this.viewport.scrollOffset,
       maxScroll: this.viewport.getMaxScroll(),
     });
     lines.push(...this.footer.render(width));
     
     // Pad to terminal height (prevent ghost rows from height fluctuation)
     while (lines.length < termHeight) lines.push("");
     
     // Truncate to terminal height and width (belt-and-suspenders)
     return lines.slice(0, termHeight).map(l => truncateToWidth(l, width));
   }
   ```

4. **Remove `frameMarker` entirely**
   - No alternating `\x1b[0m` / `\x1b[22m` appended to lines
   - Output stability guaranteed by component caching
   - Diff algorithm works correctly

5. **Implement `requestRender()` integration with SubagentTuiManager:**
   - Remove the 50ms throttle layer
   - `SubagentTuiManager.requestRender()` now directly calls `this.handle.requestRender()`
   - Pi-TUI's own 16ms throttle prevents flooding

**Testing:**
- **Stability test:** Render the inspector twice without any state change → outputs must be byte-identical
- **Tab switch test:** Switch tabs → verify `requestRender(true)` is called (mock tui)
- **Scroll test:** Verify scrollOffset clamping at boundaries (0 and maxScroll)
- **Page size test:** Verify PgUp/PgDn moves by viewportHeight-1
- **Navigation test:** Verify all keybindings produce expected state changes

**Estimated effort:** 6-8 hours

---

### Phase 4: Lifecycle, Streaming Performance, and Memory

**Goal:** Optimize for real-world usage: fast streaming, bounded memory, clean lifecycle.

**Context for implementer:** During active subagent runs, events arrive rapidly (multiple per second). The component tree must update efficiently. Completed instances should stop processing. Long-running sessions should not leak memory.

**Tasks:**

1. **Implement incremental event processing optimization:**
   - `processNewEvents()` already only processes new events (from `lastProcessedEventIndex`)
   - Add short-circuit: `if (tab.finalized) return;` — skip all processing for completed instances
   - Add guard: only rebuild virtual doc if `tab.dirty` is true

2. **Implement virtual doc caching in TranscriptViewport:**
   ```typescript
   private rebuildVirtualDoc(width: number): void {
     this.cachedVirtualDoc = [];
     for (const child of this.children) {
       const childLines = child.render(width);
       this.cachedVirtualDoc.push(...childLines);
     }
     this.dirty = false;
     this.lastWidth = width;
   }
   ```
   - Only rebuild when `dirty` or `width` changed
   - Each child component has its own cache — `child.render()` returns cached lines if unchanged

3. **Implement dirtiness propagation:**
   - When `processNewEvents()` updates a component (calls `updateContent()` or `updateResult()`), set `tab.dirty = true`
   - When TranscriptViewport detects `dirty`, it rebuilds the virtual doc
   - When the virtual doc changes, the slice may produce different lines → diff algorithm repaints only those rows

4. **Memory management (light bounds only, defer aggressive optimization):**
   - No aggressive pruning in initial implementation
   - Monitor real memory usage during testing
   - If measurement shows issues, add light caps later:
     - Suggested starting cap: 200 components per TabState
     - For finalized instances: consider trimming to 100
   - Typical subagent runs have 5-50 components — unlikely to be a problem
   - Component count = message count + tool count

5. **Clean up overlay closure lifecycle:**
   - `SubagentTuiManager.exit()` clears pending renders (already done)
   - Component's `render()` checks `active` flag before doing work
   - TabStates persist across inspector open/close cycles (user can reopen and see history)

6. **Handle terminal resize:**
   - On resize, width changes → all component caches invalidate automatically (components check width)
   - virtual doc dirty flag set → rebuild on next render
   - Height changes → viewport height recalculated in `render()` → slice adjusts automatically
   - No special handling needed — the component system handles this naturally

**Testing:**
- **Performance test:** Create 50-component transcript, stream 100 deltas, measure time per render. Goal (not guaranteed): <5ms per frame after initial render.
- **Memory test:** Create 10 instances with 100 components each → verify memory stays bounded
- **Finalization test:** Completed instance's `processNewEvents` is never called after finalization
- **Resize test:** Change width → verify all components produce valid output for new width

**Estimated effort:** 6-8 hours

---

### Phase 5: Visual Polish, Edge Cases, and Cleanup

**Goal:** Achieve strong visual parity with the main UI for content rendering, handle all edge cases, remove dead code.

**Context for implementer:** At this point the architecture is complete. This phase is about verification, edge cases, and cleanup.

**Tasks:**

1. **Visual parity verification:**
   - Compare inspector rendering of assistant messages side-by-side with main UI
   - Compare tool execution rendering (bash output, read file, edit diffs)
   - Verify same Markdown theme is applied (use `getMarkdownTheme()`)
   - Test with dark and light terminal themes
   - Fix any visual differences by adjusting component configuration

2. **Edge cases:**
   - Empty state: no instances → show "No subagents" message
   - Queued instance: show "waiting to start" placeholder
   - Very long task prompt: renders at natural height via UserMessageComponent (parity-first); verify it doesn't destabilize layout
   - Many tabs (>10): tab bar uses sliding-window algorithm (see TabBarComponent spec in Phase 1), max 2 lines, selected always visible
   - Mid-stream abort: handle `instance.status` changing to "aborted" during rendering
   - Malformed events from child process: caught by try-catch in processNewEvents

3. **Stderr rendering:**
   - Create simple `StderrComponent` extending FallbackTextComponent
   - Styled with error color theme
   - Shows first 5 lines of stderr, truncates with "... (N more lines)"
   - Positioned at the end of the transcript

4. **Remove all dead code from old implementation:**
   - Delete from `src/tui.ts`:
     - `reconstructTranscript()` — replaced by event processing pipeline
     - `normalizeCodeFenceLang()` — standard components handle this
     - `inferCLikeLanguage()` — standard components handle this
     - `findNearbyLanguage()` — standard components handle this
     - `looksMostlyLikeCode()` — standard components handle this
     - `normalizeCodeFences()` — standard components handle this
     - `stripCodeFences()` — standard components handle this
     - `replaceTabs()` — standard components handle this
     - `getInspectorMarkdownTheme()` — use `getMarkdownTheme()` directly
     - `renderTabBar()` — replaced by TabBarComponent
     - `renderConversationBody()` — replaced by TranscriptViewport
     - `renderFooter()` — replaced by StatusFooterComponent
     - `renderEpoch` and `frameMarker` logic — removed in Phase 3
   - The old `createInspectorComponent()` is replaced by `InspectorComponent` class

5. **Update tests:**
   - Port behavioral tests from `tests/tui.test.ts` to new component structure
   - Tests should verify behavior (scroll, input, content), not implementation details (specific ANSI strings)
   - Remove tests for deleted functions (`normalizeCodeFenceLang`, `reconstructTranscript`, etc.)
   - Add new tests for component creation from events

6. **Verify with live subagent runs:**
   - Run actual subagent tasks and observe the inspector
   - Test: rapid scrolling during active streaming
   - Test: tab switch during tool execution
   - Test: abort mid-stream and verify clean display

**Testing:**
- **Stability regression:** Render same inspector state 100 times → all outputs byte-identical
- **No-crash regression:** Process 500 synthetic events without any uncaught error
- **Visual regression:** Capture inspector output for known inputs → compare with baselines
- **Full suite:** `npx vitest run` passes with all updated tests

**Estimated effort:** 6-8 hours

---

## 6. Risk Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `ToolExecutionComponent` has private state that fails in overlay | Low (validated in Phase 0) | High | Phase 0 validates; fallback to FallbackTextComponent |
| `updateContent(partial)` crashes on incomplete AssistantMessage | Low (partial is well-formed) | Medium | try-catch wrapping; FallbackTextComponent fallback |
| Components produce unstable output (ANSI codes differ between frames) | Very Low (their main purpose is main UI) | High | Stability test in Phase 0; if fails, investigate component internals |
| Memory usage grows unbounded for long sessions | Low | Medium | Monitor and add light caps if measured need appears |
| Standard components don't render `read` tool results like main UI | Low (ToolExecutionComponent has built-in renderers) | Medium | If missing, file a bug; use FallbackTextComponent temporarily |
| Theme mismatch between main UI and inspector | Very Low | Low | Both use `getMarkdownTheme()` from same source |
| TypeScript type mismatches between event data and component APIs | Medium | Low | Use `as` assertions where needed; validate in Phase 0 |
| Scroll/streaming ghosting persists despite stable components | Low | Medium | Apply progressive fallback strategy (force redraw on PgUp/PgDn, then streaming, then every render) |
| Instance deleted from tracker while component tree exists | Low | Low | Clean up orphaned TabStates when instances are removed |

---

## 7. Testing Strategy

### Unit Tests (per component)
- `TabBarComponent`: renders correct icons, handles selection, wraps at width
- `StatusFooterComponent`: renders scroll metrics, handles zero instances
- `TaskHeaderComponent`: renders metadata, truncates long tasks
- `TranscriptViewport`: slice correctness, scroll clamping, dirty tracking
- `FallbackTextComponent`: renders given lines, truncates to width

### Integration Tests (event pipeline)
- `processNewEvents`: correct component creation for all event types
- Streaming: `message_update` → single component updates in place
- Tool pairing: `tool_execution_start/end` matches correct component
- Error resilience: malformed events don't crash

### Behavioral Tests (inspector as a whole)
- Tab switch: resets scroll, force redraws
- Scrolling: PgUp/PgDn/Home/End at boundaries
- Abort: sends SIGTERM to running instance
- Exit: closes overlay cleanly

### Stability Tests (critical for diff algorithm)
- Same state → identical output over 100 renders
- Streaming: each delta changes only the expected lines
- Tab switch + force render: no stale content visible

### Performance Tests (Goals — validate, not assume)
- 50-component transcript render time: goal <10ms after initial
- 100 streaming deltas: goal average <5ms per frame
- Memory: 10 instances × 100 components goal under 50MB
- These are validation targets to measure against, not guaranteed outcomes

---

## Summary

This refactor replaces a fundamentally incompatible rendering approach (manual string assembly) with the idiomatic one (pi-tui's component tree). The new architecture:

1. **Eliminates ghosting** — stable component output + force redraw on tab switch + progressive fallback strategy
2. **Achieves strong content parity** — same components as main UI for assistant messages and tool rendering
3. **Performs well during streaming** — O(1) per delta via component-level caching
4. **Is maintainable** — less code, no rendering duplication, future-proof

### What this plan likely addresses well
- Syntax highlighting instability
- Differences between inspector content rendering and main UI content rendering
- Custom heuristics around C/C++ (eliminated entirely)
- Problems created by manual line assembly
- Repeated divergence in tool rendering
- Most ghosting and diff instability issues

### What may improve but is not guaranteed
- All overlay/diff ghosting in all conditions (hence the fallback strategy)
- Perfect top-row behavior under every edge case
- Parity with arbitrary main-UI-modifying extensions

Total estimated effort: **30-44 hours** across 6 phases (0-5).
