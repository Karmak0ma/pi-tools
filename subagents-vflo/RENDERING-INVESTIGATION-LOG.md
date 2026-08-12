# Subagent Inspector Rendering Investigation Log

Project: `~/AI/pi/subagents-vflo`
Date: 2026-05-27/28 session

## Goal
Track everything attempted to fix the subagent inspector's visual/rendering issues, plus related syntax-highlighting and child-process UI problems.

---

## Original reported issues

The investigation started from these user-visible problems:

- stale extension errors appearing inside subagent tabs
- `PgUp` / `PgDn` not working in the inspector
- visual glitches while scrolling: broken lines, ghosting, overlapping text
- inability to scroll back to the subagent prompt
- parent agent not seeing subagent results reliably

Later reports added:

- C / C++ syntax highlighting missing or unstable
- visual contamination when switching tabs
- top header line intermittently missing
- main agent screen showing through the inspector in some modes
- `PgUp` / `PgDn` affecting the main agent instead of the inspector in one attempted architecture
- continued ghosting/artifacts especially during tool-heavy subagent activity

---

## Files touched during the investigation

Primary implementation files:

- `src/tui.ts`
- `src/index.ts`
- `src/runner.ts`
- `tests/tui.test.ts`
- `tests/index.test.ts`

Relevant supporting files (read/reviewed during investigation):

- `src/render.ts`
- pi runtime / TUI internals under installed package paths

---

## Investigation timeline and attempted fixes

## Pass 1 — Reduce render churn and make inspector usable

### A. Throttled live updates
Implemented earlier in the session before the later rendering deep-dives:

- Added `ThrottledUpdater` in `src/index.ts`
- Used immediate updates for status transitions
- Used throttled updates for streaming text deltas / stderr
- Suppressed main tool-row `onUpdate()` while inspector is active
- Throttled inspector re-renders in `SubagentTuiManager`

### B. Batch retention / post-completion access
- Kept runtime subagent instances after completion
- Added `batchId` tracking in tracker/runtime types

### C. Initial high-fidelity transcript rendering
In `src/tui.ts`:

- assistant text rendered with `Markdown`
- task prompt rendered in a custom bordered box
- tool calls rendered with custom `▶` rows
- tool results rendered as plain wrapped text
- stderr rendered separately
- custom footer/status line added

### D. Sidebar disable via events (attempted)
Attempted approach:

- introduced `INSPECTOR_VISIBILITY_CHANNEL`
- emitted visibility events on open/close
- intended other extensions (sidebar/footer) to suspend themselves

### Discovery
This caused/was associated with stale extension context errors:

- `ctx is stale after session replacement or reload`
- errors came from sidebar/footer-style extensions

### Outcome
Backed out runtime event emission from the inspector manager.
Exports were left, but automatic event emission was removed.

---

## Pass 2 — Fix child process extension errors

### Problem discovered
The stale extension errors shown inside a subagent tab were likely coming from the **child `pi --mode json` subprocess itself**, not the parent inspector.

The child process was loading the user's regular extensions (sidebar/footer/etc.), and those UI-oriented extensions were writing errors to stderr in JSON/print child mode.

### Fix
In `src/runner.ts`:

- child invocation changed to include `--no-extensions`

This was intended to stop user UI extensions from loading in the child process at all.

### Related test coverage
Added/updated regression coverage in `tests/index.test.ts` for child subprocess arguments to assert `--no-extensions` is present.

---

## Pass 3 — Fix scroll model and prompt visibility

### Problems targeted
- `PgUp` / `PgDn` not working
- unbounded scroll offset
- hard to get back to the prompt
- prompt could scroll offscreen

### Fixes in `src/tui.ts`

- added `pageup` / `pagedown` handling
- added `home` / `end` handling
- introduced `lastMaxScroll` / `lastPageSize`
- clamped scroll offset during rendering
- changed body rendering so the top metadata/task area is pinned and transcript is the scrollable portion
- capped visible task prompt lines
- reset scroll offset when switching tabs

### Added test coverage in `tests/tui.test.ts`
- page up/down scrolling
- scroll clamping
- prompt staying visible while scrolling transcript

---

## Pass 4 — Try to eliminate stale line remnants by width/height padding

### Problem targeted
Ghost lines / stale text remaining on the screen after scrolling or tab changes.

### Reasoning
If the custom component returns short lines or too few lines, the TUI diff renderer may leave stale characters/rows visible from the previous frame.

### Fixes in `src/tui.ts`

- padded every final emitted line to viewport width using `truncateToWidth(..., pad=true)`
- rendered exact full terminal height by padding lines to `process.stdout.rows`

### Added test coverage
In `tests/tui.test.ts`:

- all lines have visible width equal to viewport width
- render covers full terminal height

### Result
Improved stability somewhat, but ghosting still reported.

---

## Pass 5 — Improve syntax highlighting for assistant markdown and tool results

### Problem targeted
Code highlighting missing or inconsistent.

### Initial assumptions investigated
- `Markdown` component was already being used
- `getMarkdownTheme()` from pi-coding-agent already supports syntax highlighting
- issue seemed partly due to language/fence handling and partly due to tool results being rendered as plain text

### A. Fence language normalization
Added in `src/tui.ts`:

- `normalizeCodeFenceLang()`
- handled aliases / metadata such as:
  - `c++`
  - `cxx`
  - `cc`
  - `shell`
  - `plaintext`
  - fences with extra info strings such as `c++ title=main.cpp`

### B. Tool result language association
In `reconstructTranscript()`:

- tracked tool call metadata (tool name/path/language)
- attempted to associate `tool_result_end` entries with the originating tool call
- initially used FIFO queue only
- later improved to prefer `toolCallId` matching with queue fallback

### C. Highlight `read` tool results
For tool results in `src/tui.ts`:

- if associated tool is `read` and a language can be derived from file path,
  use `highlightCode()` instead of plain wrapped text
- aligned more closely with built-in `read` renderer behavior
- added `replaceTabs()` tab normalization to match pi's built-in read tool more closely

### D. Assistant raw-code heuristics
Because assistant messages are not always fenced cleanly:

- added `findNearbyLanguage()`
- added `inferCLikeLanguage()`
- added `stripCodeFences()` / `normalizeCodeFences()`
- attempted to highlight assistant outputs that are mostly code even if not perfectly fenced markdown
- broadened C / C++ heuristics repeatedly over multiple passes

### Test coverage added/updated
In `tests/tui.test.ts`:

- normalize code fence language tests
- associate `.cpp` `read` result with `language: "cpp"`
- detect `.c` `read` result language as `c`

### Result
Syntax highlighting improved in several passes, but remained unstable in real usage, especially for streamed code and some C/C++ cases. Multiple follow-up heuristic refinements were attempted.

---

## Pass 6 — Stabilize tab switching and top-region layout

### Problem targeted
Text from one tab lingering when switching to another.

### Reasoning
A variable-height top region can make content shift vertically from frame to frame, increasing the chance of stale remnants under differential redraw.

### Fixes in `src/tui.ts`

- made metadata section use fixed slots:
  - fixed model line slot
  - fixed cwd line slot
  - fixed warning line slots
- made task prompt area fixed-height with padded blank lines
- capped tab bar to 2 lines to reduce viewport instability under many tabs
- moved footer calculation to use current-frame scroll information instead of previous-frame values

### Result
Some improvement in stability, but not enough.

---

## Pass 7 — Remove component render cache

### Reasoning
Any stale cached frame in a custom inspector is more dangerous than the small performance win from memoization.

### Fixes in `src/tui.ts`

- removed `cachedWidth` / `cachedHeight` / `cachedLines` memoization behavior
- `invalidate()` became a no-op because rendering is rebuilt fresh each time

### Tests updated
`tests/tui.test.ts` was updated from cache-specific assertions to fresh-render assertions.

### Result
Reduced one possible stale-frame class, but did not fully solve ghosting.

---

## Pass 8 — Structural experiment: switch from overlay to full-screen custom mode

### Reasoning
Overlay compositing might be interacting badly with the main transcript buffer / viewport diffing.

### Attempted change
Changed `ctx.ui.custom(...)` usage in `src/tui.ts` to non-overlay full-screen mode.

### Discovery
This introduced new problems:

- top line showed the main agent screen
- `PgUp` / `PgDn` affected the main agent window instead of the inspector

### Outcome
Reverted back to full-screen overlay mode.

---

## Pass 9 — Independent subagent review (Sonnet 4.6)

A separate review subagent was spawned with Sonnet 4.6 to independently inspect `src/tui.ts`.

### Key findings from the independent review
The review identified these main risks:

1. stale `lastMaxScroll` immediately after tab switch
2. FIFO-only tool result pairing was unsafe under multiple/parallel tool calls
3. tab bar growth could destabilize visible layout
4. pre-highlighted ANSI lines being re-wrapped could cause escape-state / visual issues
5. footer scroll state was one frame stale because footer was rendered before body updated scroll metrics
6. render cache provided little value and could hide stale-state bugs

### Implemented based on that review
- reset scroll metrics on tab switch
- improved tool-result pairing with `toolCallId` preference
- truncated pre-highlighted lines instead of re-wrapping them
- moved footer to use current-frame body-derived scroll state
- capped tab bar growth
- removed render cache

---

## Pass 10 — Force broader redraws to fight differential ghosting

### Reasoning
The remaining symptoms strongly resembled incremental diff redraws failing to repaint enough rows when the inspector changed during scroll/tool activity.

### Attempt A — invisible render marker tied to navigation actions
Added a `renderEpoch` token and changed visible output invisibly on scroll/tab actions so pi-tui would redraw from the top instead of only changed lower rows.

### Attempt B — moved marker off the header
The initial invisible marker placement interfered with the top header line, so it was moved.

### Attempt C — append invisible marker to final emitted lines
Instead of attaching the marker to the header line, it was appended to final padded lines.

### Attempt D — force a changing invisible marker on **every render**
Latest strategy:

- increment the render epoch on every render
- append an invisible token to every emitted line
- goal: force a full-frame diff every render for correctness over efficiency

### Result
This was the latest anti-ghosting strategy attempted.

---

## Current state at the end of this log

### Things that improved at various points
- child process no longer intentionally loads user extensions (`--no-extensions`)
- page up/down / home/end support exists
- scroll clamping exists
- prompt visibility was improved via pinned layout
- line width / full-height padding exists
- render cache was removed
- tool result language association is better than at the beginning
- C highlighting improved in some scenarios
- C++ highlighting improved in some scenarios
- header top-line issue was investigated and partially adjusted multiple times

### Things that remained problematic in real usage
The user still reported real-world issues even after multiple passes, including:

- ghosting / stale rows during scrolling
- overlapping lines after repeated PgUp/PgDn
- syntax highlight instability during streamed code output
- repeated regressions where one language (C or C++) worked while the other did not
- the inspector still not looking identical to the main UI

---

## Architectural discoveries / limitations

### 1. The inspector is a custom renderer, not the main chat renderer
This is the biggest architectural difference.

Even when using the same theme and markdown highlighter, the inspector is still a **separate custom TUI surface**. That means:

- it does not automatically inherit arbitrary main-window UI extensions
- it does not automatically reuse built-in message/tool execution components unless explicitly refactored to do so
- it is more vulnerable to custom line-by-line diff issues because the current implementation constructs output manually

### 2. Overlay mode vs non-overlay mode is a tradeoff
- overlay mode gave better screen/key ownership
- non-overlay mode introduced top-line bleed-through and wrong PgUp/PgDn ownership
- overlay mode, however, appears to have been implicated in at least some redraw/compositing complexity

### 3. Tool-heavy / streaming-heavy use appears to be the hardest case
Most persistent artifact reports happened during:

- repeated scrolling
- tab switching
- subagents actively using tools or streaming code/text

This suggests the unresolved issues are likely in the interaction between:

- frequent repaints
- overlay compositing
- line-based differential rendering
- custom manual line construction

---

## Most important code paths investigated

### `src/tui.ts`
Main problem surface:

- transcript reconstruction
- manual line rendering
- pinned section layout
- footer status rendering
- scroll handling
- custom render lifecycle
- overlay / non-overlay mode changes
- redraw token strategy

### `src/runner.ts`
Child-process fix:

- added `--no-extensions`

### `src/index.ts`
Result propagation / output visibility work:

- improved multi-task readable output
- accumulated multiple assistant messages in child result output

---

## Tests added/updated over the course of the work

Examples of added/updated coverage:

- page up/down support
- scroll clamping
- prompt visibility while scrolling
- per-line width padding to viewport width
- full terminal-height coverage
- `.cpp` and `.c` language association for `read` tool results
- child subprocess includes `--no-extensions`
- fresh render behavior after removing cache

At end of session, suite still passed:

- `npx tsc --noEmit`
- `npx vitest run`
- 199 tests passing

---

## Summary of attempted fixes (short form)

1. throttled live updates / inspector re-renders
2. retained completed instances and batch IDs
3. rendered assistant text with Markdown
4. attempted sidebar disable via events, then removed runtime emission
5. disabled child extension loading with `--no-extensions`
6. added PgUp/PgDn/Home/End support
7. clamped scroll offset
8. pinned the task prompt / metadata section
9. padded every line to full width
10. padded output to full terminal height
11. normalized markdown code fence languages
12. highlighted `read` tool results using file-derived languages
13. added assistant code heuristics for raw/fenced C-family code
14. fixed top-region layout to be more stable across tabs
15. removed render cache entirely
16. briefly switched away from overlay mode, then reverted
17. incorporated an independent Sonnet 4.6 review
18. improved tool-result pairing with `toolCallId`
19. truncated pre-highlighted ANSI lines instead of re-wrapping them
20. changed footer to compute from current-frame body state
21. added invisible render-token strategies to force broader redraws
22. broadened C/C++ inference repeatedly

---

## Suggested next step (based on everything learned so far)

If work resumes, the most likely productive next step is **not another small patch**, but a structural refactor of the inspector rendering path.

Most promising directions:

1. rebuild the inspector body around more of pi's built-in exported components (`AssistantMessageComponent`, `UserMessageComponent`, built-in tool rendering where possible)
2. reduce the amount of manual string assembly in `src/tui.ts`
3. minimize dependence on overlay diff behavior by using a rendering strategy closer to the main chat UI
4. if possible, capture/render through the same component model as the main transcript rather than a custom handcrafted line renderer

That is likely the clearest path to true visual parity and stability.
