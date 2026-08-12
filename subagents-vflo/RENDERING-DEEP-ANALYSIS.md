# Subagent Inspector — Deep Rendering Analysis

**Date:** 2026-05-28  
**Scope:** Full analysis of every rendering issue source in the subagent inspector extension, based on reading the pi-tui internals, pi-coding-agent's `showExtensionCustom`, and the extension's own `src/tui.ts`.

---

## Executive Summary

The inspector's rendering issues stem from a **fundamental architectural mismatch**: the extension builds a full-screen overlay via manual string assembly (line-by-line construction), but the pi-tui runtime uses **differential line-based rendering** that compares `previousLines[i] === newLines[i]` with strict string equality. Any instability in string output between frames — even invisible differences — can cause the diff algorithm to either repaint too little (ghosting) or too much (flicker).

Below are **all identified sources of rendering problems**, categorized by root cause.

---

## Category 1: Differential Rendering Interactions

### Issue 1.1: The `frameMarker` trick fights the diff engine

**Location:** `src/tui.ts`, end of `render()` method

```typescript
const frameMarker = renderEpoch % 2 === 0 ? "\u001b[0m" : "\u001b[22m";
const paddedLines = allLines
  .slice(0, termHeight)
  .map((line) => truncateToWidth(line, Math.max(1, width), "...", true) + frameMarker);
```

**Problem:** The TUI's `applyLineResets()` appends `"\x1b[0m\x1b]8;;\x07"` to every line **after** it receives the component's output. So the final line becomes:

```
<component output> + frameMarker + "\x1b[0m\x1b]8;;\x07"
```

The `frameMarker` alternates between `\x1b[0m` and `\x1b[22m`. This means **every line changes on every render** regardless of content. The diff algorithm (`doRender()`) finds `firstChanged = 0` and `lastChanged = termHeight - 1` every single frame, forcing a full rewrite of all rows every time.

**Consequence:** This defeats the purpose of differential rendering. Every single render becomes a full-screen write. On slow terminals this causes visible flicker because the TUI uses synchronized output (`\x1b[?2026h`/`\x1b[?2026l`), but many terminal emulators handle sync imperfectly under rapid repaints.

**Additionally:** The alternating `\x1b[0m` marker is redundant because `applyLineResets()` already appends a full SGR reset. The `\x1b[22m` (bold-off) marker in the alternating frame is not a full reset and creates a subtle styling leak if the previous ANSI state is not fully closed.

### Issue 1.2: The `truncateToWidth(..., pad=true)` interaction with overlays

**Location:** `src/tui.ts`, `render()` final line construction

The component pads every line to the full terminal width with spaces via `truncateToWidth(line, width, "...", true)`. Then the TUI's `compositeOverlays()` applies the overlay content by **splicing** the component's lines into the base content array.

But because the overlay uses `anchor: "top-left"` with `width: "100%"` and `margin: 0`, the overlay occupies the entire terminal — meaning the base content is **completely replaced** by the overlay content. The splicing step effectively becomes a no-op since the overlay covers 100% of the area.

**However**, this creates a subtle issue: the compositing logic runs `compositeLineAt()` which:
1. Extracts a "before" segment (0 cols — nothing before col 0)
2. Extracts an "after" segment (0 cols — nothing after overlay width)
3. Pads with `SEGMENT_RESET` separators between segments

This adds extra `\x1b[0m\x1b]8;;\x07` resets between the null segments and the overlay content. Combined with the `applyLineResets()` pass, each line accumulates **multiple redundant reset sequences** that increase string length and slow down comparisons.

### Issue 1.3: `clearOnShrink` triggers unintended full redraws

**Location:** pi-tui `doRender()` lines 823-827

```javascript
if (this.clearOnShrink && newLines.length < this.maxLinesRendered && this.overlayStack.length === 0) {
    fullRender(true);
    return;
}
```

The `clearOnShrink` check is explicitly **disabled when overlays are active** (`this.overlayStack.length === 0` check). This means while the inspector is open, the TUI will not auto-clear stale rows when content height shrinks. If the component returns fewer lines on one frame than the previous frame (e.g., after switching tabs with different content lengths), the excess rows from the previous frame will **persist as ghost content** until the next full redraw.

The component attempts to prevent this by always padding to `termHeight`, but if there's ever a frame where `process.stdout.rows` returns a different value (terminal resize in progress, race condition), a single short frame can leave artifacts.

---

## Category 2: Scroll and Viewport State Issues

### Issue 2.1: `lastMaxScroll` is stale on the first render after tab switch

**Location:** `src/tui.ts`, `handleInput` for left/right arrows

```typescript
state.scrollOffset = 0;
lastMaxScroll = 0;
lastPageSize = 1;
```

When switching tabs, `lastMaxScroll` is reset to 0. But the next `render()` call computes the new `lastMaxScroll` **inside** `renderConversationBody()`. If any user input arrives between the state reset and the next completed render, `lastMaxScroll = 0` means:
- `pagedown` becomes a no-op (min of 0 and current offset)
- `end` becomes a no-op
- `down` arrow also becomes a no-op

This is a **timing race** — if renders are throttled (50ms), the user can press keys during the stale window.

### Issue 2.2: Scroll offset can drift during live streaming

**Location:** `src/tui.ts`, `renderConversationBody()`

```typescript
lastMaxScroll = Math.max(0, transcriptLines.length - transcriptViewport);
if (state.scrollOffset > lastMaxScroll) {
  state.scrollOffset = lastMaxScroll;
}
```

During streaming (live text updates from a running subagent), `transcriptLines.length` grows continuously. The `lastMaxScroll` grows, but `state.scrollOffset` is left unchanged unless it exceeds the new max. This means:

- If the user scrolled up, they stay at their position while content grows below (correct behavior)
- But the footer shows stale scroll position info until the next render

More critically: if the transcript **shrinks** (e.g., a `reconstructTranscript()` call returns fewer entries due to event processing order), the clamping `state.scrollOffset = lastMaxScroll` can snap the viewport unexpectedly.

### Issue 2.3: Height calculation uses `process.stdout.rows` directly

**Location:** `src/tui.ts`, `render()` method

```typescript
const termHeight = process.stdout.rows || 24;
```

The TUI passes `width` as a parameter to `render()`, but height is read from `process.stdout.rows` directly. The TUI itself uses `this.terminal.rows` which may differ if:
- A resize event is in flight
- The terminal hasn't flushed the SIGWINCH handler yet

If the component reads a different height than the TUI's internal `height`, the number of output lines won't match what the TUI expects for its viewport calculations. This creates:
- Empty gap at bottom (component returns too many lines — TUI's overlay compositor pads to max)
- Missing rows at bottom (component returns too few lines — ghost rows from previous frame)

---

## Category 3: Overlay Lifecycle and Compositing

### Issue 3.1: The overlay stays in the TUI stack even during throttled no-op renders

**Location:** `src/tui.ts`, `SubagentTuiManager.requestRender()`

```typescript
requestRender(): void {
  if (!this.handle || !this.state.active) return;
  if (this.renderTimer) return; // Already scheduled
  this.renderTimer = setTimeout(() => {
    this.renderTimer = null;
    if (this.handle && this.state.active) {
      this.handle.requestRender();
    }
  }, SubagentTuiManager.RENDER_THROTTLE_MS);
}
```

The `SubagentTuiManager` throttles at 50ms. But pi-tui's own `requestRender()` also has a `MIN_RENDER_INTERVAL_MS = 16ms` throttle. These two throttle layers interact:

1. Extension throttle fires after 50ms → calls `tui.requestRender()`
2. TUI's `requestRender()` marks render requested, schedules via `nextTick → scheduleRender()`
3. `scheduleRender()` waits up to 16ms from last render

This creates **variable latency** (50ms to 66ms) between data arrival and screen update. During active streaming, this means:
- Multiple state mutations accumulate between renders
- A single render frame can represent a large delta (many lines added/changed)
- The diff algorithm sees a large `lastChanged - firstChanged` range and must write many lines

### Issue 3.2: Overlay closing race condition

**Location:** `interactive-mode.js`, `showExtensionCustom()` and `src/tui.ts`, `SubagentTuiManager.exit()`

When `exit()` is called:
```typescript
exit(): void {
  if (!this.state.active) return;
  this.state.active = false;
  if (this.renderTimer) {
    clearTimeout(this.renderTimer);
    this.renderTimer = null;
  }
  if (this.closeCallback) {
    this.closeCallback();  // calls `done()` which triggers hideOverlay()
    this.closeCallback = null;
  }
  this.handle = null;
}
```

The `closeCallback` calls `done()` in the promise wrapper of `showExtensionCustom()`, which calls `this.ui.hideOverlay()`. This removes the overlay from the stack and restores the editor. But if a pending `requestRender()` was already scheduled in the TUI's `scheduleRender()` pipeline, the overlay's component might be called for one more `render()` after `state.active` is false.

This isn't catastrophic because the component still has valid state, but it can cause a brief flash where the inspector renders with no active instance selected (if `instances` changed between the exit and the stale render).

### Issue 3.3: Full-screen overlay disables `clearOnShrink` for main content

When the overlay is active, `this.overlayStack.length > 0` prevents `clearOnShrink` from triggering. If the **main content behind the overlay** changes (e.g., the agent completes a message), those changes accumulate. When the overlay closes, the main content may be shorter or longer than it was when the overlay opened, potentially triggering visual discontinuity.

---

## Category 4: Line Construction and ANSI Issues

### Issue 4.1: Double truncation of pre-highlighted content

**Location:** `src/tui.ts`, `renderConversationBody()`, tool_result rendering

```typescript
const resultLines = isCodeResult
  ? highlightCode(replaceTabs(entry.content), entry.language)
      .map((line) => truncateToWidth(replaceTabs(line), toolWidth))
  : wrapTextWithAnsi(entry.content, toolWidth);
```

Then later, the outer `render()` does:
```typescript
.map((line) => truncateToWidth(line, Math.max(1, width), "...", true) + frameMarker);
```

This is **double truncation**: first to `toolWidth`, then to `width`. Double truncation of ANSI-styled text can produce malformed escape sequences if the first truncation cuts in the middle of a multi-byte escape and the second truncation's `pad=true` adds spaces before the escape is properly closed.

### Issue 4.2: `replaceTabs()` called multiple times on the same text

```typescript
highlightCode(replaceTabs(entry.content), entry.language)
  .map((line) => truncateToWidth(replaceTabs(line), toolWidth))
```

Tabs are replaced in the source before `highlightCode()`, but then `replaceTabs()` is called again on each output line. If `highlightCode()` somehow introduces tabs (unlikely but possible in edge cases), this double-call is harmless. However, it's wasted CPU and obscures intent.

### Issue 4.3: `Markdown` component creates new instances on every render

```typescript
const md = new Markdown(mdText, 1, 0, mdTheme);
const rendered = md.render(bodyWidth);
```

Each render frame creates a new `Markdown` instance for each assistant message in the transcript. The `Markdown` component performs:
- Markdown parsing
- Syntax highlighting via `highlightCode`
- Line wrapping via `wrapTextWithAnsi`

This is expensive, especially for long transcripts with multiple highlighted code blocks. There's no caching because the render cache was intentionally removed in Pass 7. Every 50ms throttled render re-parses all markdown from scratch.

### Issue 4.4: ANSI state leakage across transcript entries

The `Markdown` component is documented to require SGR reset at end of each line (which the TUI provides via `applyLineResets()`). However, the inspector **prefixes** each markdown line with `"  "` (two spaces):

```typescript
for (const rl of rendered) {
  transcriptLines.push("  " + truncateToWidth(rl, bodyWidth));
}
```

If the `Markdown` render returns a line that starts with an SGR sequence (e.g., a highlighted code line), the two-space prefix is unstyled. This is fine. But if a line **ends** with an unclosed SGR state (relying on the TUI's per-line reset), and the next line begins with spaces, the spaces inherit the previous styling until the next SGR code is encountered.

This is normally invisible (spaces look the same styled or unstyled), but with background colors it can create visible color bleed between lines.

### Issue 4.5: `visibleWidth` of padded lines may exceed terminal width

The `truncateToWidth(line, width, "...", true)` call with `pad=true` should guarantee the line is exactly `width` visible characters. However, if `line` already contains the alternating `frameMarker` (which is appended after truncation), the TUI's `doRender()` detects:

```javascript
if (!isImage && visibleWidth(line) > width) {
  // CRASH: throws Error
}
```

The `frameMarker` is `\x1b[0m` or `\x1b[22m` — both are zero-width ANSI codes. So `visibleWidth` won't count them. This means the crash won't happen, but the **actual bytes** in the string are longer than `width`, which means the TUI's string comparison `oldLine !== newLine` will compare longer strings than necessary.

---

## Category 5: Interaction Between Extension and Pi Internals

### Issue 5.1: The extension's `invalidate()` is a no-op

```typescript
invalidate(): void {
  // No-op: render is rebuilt from current state on every frame.
}
```

The TUI documentation states: *"Called when theme changes or when component needs to re-render from scratch."* The TUI calls `invalidate()` on theme changes and expects the component to clear its cache. Since there's no cache, this is fine for correctness. But it means the TUI has no way to signal "you must re-render" — it relies entirely on `requestRender()` being called externally.

If the TUI changes theme while the inspector is active, the theme reference held in the closure from `createInspectorComponent` becomes stale. The `theme` parameter passed at component creation time is captured in the closure and never refreshed.

### Issue 5.2: The `tui.requestRender()` called from within `handleInput` is redundant

In `handleInput`, after every key press:
```typescript
renderEpoch++;
invalidate();  // no-op
requestRender();
```

The `requestRender()` here calls `tui.requestRender()` which is the pi-tui's method. But pi-tui already calls `requestRender()` automatically after dispatching `handleInput()` to the focused component (this is how the editor works — you type, it re-renders). Looking at the TUI source:

```javascript
handleInput(data) {
    // ... dispatch to focused component ...
    // NOTE: There's no automatic requestRender after handleInput in tui.js
}
```

Actually, examining the code more carefully, pi-tui does **not** auto-request render after input. The component must do it. So the extension's `requestRender()` calls are correct and necessary. However, the `invalidate()` call is dead code.

### Issue 5.3: `process.stdout.rows` vs TUI's internal height tracking

The TUI passes `width` to the component's `render(width)`, but does NOT pass height. The component reads `process.stdout.rows` directly. The TUI internally uses `this.terminal.rows` which reads from the same source. However:

- The TUI renders in a `nextTick` or `setTimeout` callback
- `process.stdout.rows` can change between when the TUI reads it and when the component reads it
- If the terminal resizes mid-render, the component might return a different number of lines than the TUI's viewport expects

This is a known pi-tui limitation: height is not passed to `render()`. The workaround is to always return enough lines to fill the screen, which the extension does via padding. But the race window exists.

### Issue 5.4: The extension returns exactly `termHeight` lines, but compositing may extend this

The `compositeOverlays` function in pi-tui extends the line array:

```javascript
const workingHeight = Math.max(result.length, termHeight, minLinesNeeded);
while (result.length < workingHeight) {
  result.push("");
}
```

Since the overlay has `width: "100%"` and the component returns `termHeight` lines, and the overlay is positioned at row 0 with no offset, the compositor:
1. Takes the base content (main chat area, which could be longer than termHeight)
2. Pads to at least `termHeight` 
3. Splices the overlay at `viewportStart + row + i` for each overlay line

The `viewportStart` is `Math.max(0, workingHeight - termHeight)`. If `workingHeight > termHeight` (because main content is longer), the overlay is positioned partway down the array, and the top of the array shows **main content bleeding through above the overlay**.

This is the exact issue described in Pass 8 of the investigation log — "top line showed the main agent screen". The full-screen overlay with `anchor: "top-left"` is positioned relative to the **viewport**, which starts at `viewportStart`, not at array index 0.

---

## Category 6: Rendering Frequency and Timing

### Issue 6.1: Triple-layer throttling creates unpredictable update intervals

1. **Child process stdout** → parsed into events (no throttle, event-driven)
2. **ThrottledUpdater** → 150ms throttle for text deltas
3. **SubagentTuiManager.requestRender()** → 50ms throttle
4. **pi-tui TUI.requestRender()** → 16ms minimum interval

Combined worst case: up to 216ms from event to screen. Best case: ~16ms. This variability means:
- Animation-style content (spinners, streaming text) appears jerky
- Large content jumps can happen when multiple events accumulate
- The differential rendering sees large diffs, causing more rows to repaint

### Issue 6.2: Live streaming overwhelms the diff algorithm

During active tool execution in a subagent, events arrive rapidly. Each `message_update` event with `assistantMessageEvent.delta` triggers:
```
instance.summary.latestOutput += delta
updater.throttled()
```

After throttle expires:
```
tuiManager.requestRender() → [50ms throttle] → tui.requestRender()
```

The `render()` function then reconstructs the **entire transcript from scratch** (calls `reconstructTranscript`), creates new `Markdown` instances, highlights all code, wraps all text. For a long transcript, this can take significant CPU time within the render frame.

If rendering takes more than 16ms, the next scheduled render is delayed further, accumulating even more changes. This creates a **cascading delay** effect during heavy streaming.

---

## Category 7: Structural Architecture Problems

### Issue 7.1: Manual line assembly vs Component tree

Pi-tui's design philosophy is:
- Container → children → each child's `render()` returns lines → Container concatenates
- The TUI does one top-level `render()` → gets all lines → composites overlays → diffs

The inspector uses a **flat function** that returns a string array. It doesn't use `Container`/`Text`/`Box` components. This means:
- No benefit from pi-tui's component invalidation tracking
- No ability to use pi-tui's built-in caching patterns
- Manual viewport/scroll management instead of letting the container system handle it
- Manual ANSI styling instead of using theme-aware components

### Issue 7.2: The inspector duplicates rendering logic from the main chat UI

The main pi chat UI uses:
- `Markdown` components for assistant messages (with proper lifecycle management)
- Built-in tool rendering components
- Proper `Container` nesting with automatic height calculation
- The TUI's native scroll management

The inspector rebuilds all of this from scratch with string operations. Every quirk of the main UI's rendering (word wrap edge cases, ANSI continuation, theme application) must be reimplemented.

### Issue 7.3: No way to perform partial updates

When a single character is appended to the streaming text, the entire transcript is re-rendered. In the main UI, only the last message component would re-render (via invalidation). In the inspector, the entire `render()` function runs, rebuilding all lines from all transcript entries.

---

## Category 8: Edge Cases and Minor Issues

### Issue 8.1: Tab bar width calculation with ANSI codes

```typescript
const currentWidth = visibleWidth(tabLine) + visibleWidth(tab) + (tabLine ? visibleWidth(separator) : 0);
```

The `visibleWidth` function properly handles ANSI codes, but the tab rendering uses theme functions (`theme.bg("selectedBg", ...)`) that may produce different-length ANSI sequences on different terminals/themes. If the visible width calculation has any edge case (e.g., with certain Unicode in agent names), the tab bar could overflow a single line and wrap incorrectly.

### Issue 8.2: `reconstructTranscript` event ordering assumptions

The function iterates `instance.events` in array order and uses `message_end` events for assistant text. If events arrive out of order (possible in async scenarios), the transcript might show tool results before the corresponding tool calls.

### Issue 8.3: Tool result truncation at 500 characters

```typescript
const preview = part.text.length > 500 ? part.text.slice(0, 500) + "..." : part.text;
```

Truncating in the middle of a multi-byte character (emoji, CJK) can produce invalid UTF-8. `String.prototype.slice()` works on code units, which is safe for basic multilingual plane characters but could produce surrogate pairs issues with astral characters.

### Issue 8.4: The `wrapTextWithAnsi` for tool results doesn't account for prefix width

```typescript
const resultLines = wrapTextWithAnsi(entry.content, toolWidth);
// ...
transcriptLines.push(theme.fg("dim", "    │ ") + wl);
```

The `toolWidth` is `safeWidth - 6`, and the prefix `"    │ "` is 6 characters. So the total should fit within `safeWidth`. This is correct. But the prefix contains a Unicode box character (`│`) which is typically 1 column wide. If a terminal treats it as 2 columns (some older terminals), lines overflow by 1 character.

---

## Prioritized Recommendations

### Priority 1: Fix the `frameMarker` strategy (Critical)

The alternating frame marker forces a full-screen diff every render. This is the single most impactful change:

**Option A:** Remove `frameMarker` entirely. The component already pads to full height and width. If content genuinely changes, the diff will catch it.

**Option B:** If ghost lines persist without the marker, investigate `requestRender(force: true)` on tab switches and scroll actions only. The `force: true` parameter resets `previousLines` and forces a full clear+render, which is the correct way to request a full repaint.

### Priority 2: Use pi-tui's Component system (Architectural)

Refactor the inspector to use `Container` with child components:
- Header component (static, rarely changes)
- Tab bar component (changes on tab switch)
- Body/transcript component (changes on data updates)
- Footer component (changes on scroll)

Each component caches its own output and invalidates only when its state changes. The `Container.render()` concatenates them. The diff algorithm then only rewrites the rows that actually changed.

### Priority 3: Don't use `process.stdout.rows` directly (Medium)

Accept that the component doesn't know the height, and always emit enough content. Or, store the height from the overlay options calculation. Since the overlay uses `maxHeight: "100%"`, the TUI will cap the output at terminal height anyway.

### Priority 4: Cache transcript rendering (Performance)

Instead of re-rendering the entire transcript from scratch every frame:
1. Cache rendered lines per transcript entry (keyed by entry content hash)
2. Only re-render entries that changed (typically just the last one during streaming)
3. Concatenate cached line arrays for the viewport slice

### Priority 5: Reduce throttle layers (Responsiveness)

Consider removing the `SubagentTuiManager` 50ms throttle and relying solely on:
- `ThrottledUpdater`'s 150ms for data arrival
- pi-tui's 16ms for render scheduling

The 50ms layer was added to prevent flooding but creates unnecessary latency.

### Priority 6: Fix tab switch to use `requestRender(force: true)` (Ghosting fix)

On tab switch, call `tui.requestRender(true)` (pass `force = true`). This tells pi-tui to clear `previousLines` and perform a full clear+render, eliminating any ghost content from the previous tab. This is the intended API for "I need a clean slate."

However, this requires access to the TUI instance's `requestRender` with the force parameter. The current code only has access via the closure parameter. Check if the `tui` object passed to the factory supports `requestRender(true)`.

---

## Summary Table

| # | Issue | Severity | Category | Fix Complexity |
|---|-------|----------|----------|----------------|
| 1.1 | frameMarker forces full diff every frame | **Critical** | Diff | Simple (remove it) |
| 1.2 | 100% overlay compositing adds redundant resets | Low | Diff | None needed (perf only) |
| 1.3 | clearOnShrink disabled during overlay | Medium | Diff | Architectural (use force render) |
| 2.1 | Stale lastMaxScroll after tab switch | Medium | Scroll | Simple (defer input until render) |
| 2.2 | Scroll snap during transcript shrink | Low | Scroll | Simple (clamp differently) |
| 2.3 | process.stdout.rows race | Low | Scroll | Medium (use TUI-provided height) |
| 3.1 | Double throttle timing | Medium | Timing | Simple (remove one layer) |
| 3.2 | Overlay close race | Low | Lifecycle | Low priority |
| 3.3 | clearOnShrink after overlay close | Low | Lifecycle | None (pi-tui handles it) |
| 4.1 | Double truncation of highlighted code | Medium | ANSI | Simple (remove inner truncate) |
| 4.2 | Double replaceTabs | Trivial | ANSI | Simple |
| 4.3 | Markdown re-instantiation every frame | High | Performance | Medium (add caching) |
| 4.4 | ANSI state leakage with prefixes | Low | ANSI | None (cosmetic only) |
| 4.5 | frameMarker increases string length | Low | Performance | Fixed by 1.1 |
| 5.1 | Stale theme reference | Low | Lifecycle | Medium |
| 5.2 | Redundant invalidate() calls | Trivial | Code quality | Simple |
| 5.3 | process.stdout.rows inconsistency | Low | Architecture | See 2.3 |
| 5.4 | viewportStart offset in compositing | Low | Architecture | By design for overlays |
| 6.1 | Triple throttle latency | Medium | Timing | Simple |
| 6.2 | Full transcript re-render on each frame | High | Performance | Medium (caching) |
| 7.1 | Manual line assembly | **Architectural** | Design | Large refactor |
| 7.2 | Duplicated rendering logic | Medium | Design | Large refactor |
| 7.3 | No partial updates possible | High | Design | Architectural |
| 8.1 | Tab bar width edge cases | Low | Edge case | Simple |
| 8.2 | Event ordering assumptions | Low | Correctness | Simple |
| 8.3 | Mid-character truncation | Trivial | Correctness | Simple |
| 8.4 | Box char width assumption | Trivial | Compatibility | None |

---

## Recommended Fix Order

1. **Remove `frameMarker`** — immediate ghosting + flicker reduction
2. **Use `requestRender(force: true)` on tab switch** — eliminates tab-switch ghosting
3. **Add per-entry transcript caching** — eliminates performance bottleneck
4. **Remove the 50ms TUI throttle layer** — reduces latency
5. **Fix double truncation** — eliminates rare ANSI glitches
6. **Long-term: refactor to Component tree** — permanent fix for all categories

---

## Appendix: Key Pi-TUI Internals Reference

### Diff algorithm (simplified flow)
```
doRender():
  1. Call container.render(width) → get newLines[]
  2. compositeOverlays(newLines) → splice overlay content
  3. extractCursorPosition(newLines)
  4. applyLineResets(newLines) → append "\x1b[0m\x1b]8;;\x07" to each line
  5. Check for full-render triggers (width/height change, clearOnShrink)
  6. Find firstChanged/lastChanged by comparing previousLines[i] === newLines[i]
  7. Write only changed rows using CSI cursor movement + \x1b[2K (clear line)
  8. Wrap in synchronized output (\x1b[?2026h ... \x1b[?2026l)
  9. Store newLines as previousLines
```

### Overlay compositing (for 100% width overlay)
```
compositeOverlays(lines, termWidth, termHeight):
  1. Render overlay component at termWidth
  2. Pad base array to workingHeight = max(lines.length, termHeight)
  3. viewportStart = max(0, workingHeight - termHeight)
  4. For each overlay line i:
     result[viewportStart + row + i] = compositeLineAt(base, overlay, col=0, w=termWidth, termWidth)
```

### requestRender(force=true) behavior
```
requestRender(force=true):
  1. previousLines = []
  2. previousWidth = -1 → triggers widthChanged detection
  3. previousHeight = -1 → triggers heightChanged detection
  4. Next doRender() will call fullRender(true):
     - Clear screen: \x1b[2J\x1b[H\x1b[3J
     - Write all new lines fresh
     - Reset all tracking state
```
