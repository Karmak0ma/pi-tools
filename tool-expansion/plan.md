# Tool Output Mouse Expansion — Implementation Plan

## Goal

Build a Pi extension that lets the user click an individual tool-output box in **fullscreen TUI mode** to expand or collapse that tool output.

Current Pi behavior exposes `Ctrl+o` (`app.tools.expand`) as a global toggle: it expands or collapses all tool outputs together. The extension must add per-tool mouse control without removing or replacing the existing keyboard behavior.

## Scope decision

This is deliberately a fullscreen-only extension.

### In scope

- Interactive TUI mode (`ctx.mode === "tui"`).
- Pi fullscreen renderer (`tui.mode === "fullscreen"`).
- SGR mouse primary-button clicks.
- Clicking the first non-empty line of an individual tool component (the tool header/call row).
- Toggling only the clicked `ToolExecutionComponent`.
- Preserving normal Pi behavior for all other mouse input:
  - transcript scrolling,
  - text selection and copying,
  - scrollbar dragging,
  - hyperlink activation,
  - right-click behavior.
- Keeping `Ctrl+o` as the global expand/collapse action.

### Explicitly out of scope for the first version

- Regular TUI mode. It has a different rendering/scrollback model and no equivalent fullscreen layout tree.
- RPC, JSON, print, or non-interactive modes.
- Clicking arbitrary output-body rows. Body clicks must remain available for selection.
- Drag selection, double-click selection, wheel handling, scrollbar handling, and hyperlink handling.
- Persisting per-tool expansion state to sessions or configuration.
- Reimplementing Pi's tool renderer.
- Enabling or disabling terminal mouse tracking directly.

## Feasibility summary

The feature is practical for a personal extension against the current Pi release, but it necessarily uses a small amount of private TUI state because Pi does not currently expose a public mouse-coordinate or hit-testing API.

The two private implementation details required are:

1. The fullscreen TUI input-listener `Set`, so the extension can receive mouse clicks before Pi's viewport listener consumes them.
2. The fullscreen TUI's last computed layout, so terminal coordinates can be mapped to visible tool components.

The extension must feature-detect both details and fail closed if they are unavailable. It must never crash Pi or consume mouse input when compatibility cannot be established.

Current installed/reference version:

- `@earendil-works/pi-coding-agent` `0.84.1`
- `@earendil-works/pi-tui` `0.84.1`

Relevant installed files:

- `/home/vflores/.local/share/fnm/node-versions/v24.15.0/installation/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js`
- `/home/vflores/.local/share/fnm/node-versions/v24.15.0/installation/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js`
- `/home/vflores/.local/share/fnm/node-versions/v24.15.0/installation/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/tui.js`
- `/home/vflores/.local/share/fnm/node-versions/v24.15.0/installation/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js`
- `/home/vflores/.local/share/fnm/node-versions/v24.15.0/installation/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/layout.js`

## Pi behavior to rely on

### Mouse input

`TuiAltScreen` enables terminal mouse tracking itself when fullscreen mode starts. It uses SGR mouse reporting and consumes mouse events in its viewport input listener.

`TuiBase.handleTerminalInput()` dispatches registered input listeners before forwarding input to the focused component. Listeners are iterated in insertion order. The fullscreen viewport listener is registered before extension listeners, so a normal `ctx.ui.onTerminalInput()` subscription is too late to handle clicks: the viewport consumes the mouse event first.

The extension must therefore reorder its own listener ahead of the viewport listener. This is the same private-listener technique already used by:

- `sidebar-vflo/src/split-pane.ts`
- `subagents-vflo/src/tui.ts`

Do not write mouse enable/disable escape sequences. Pi owns terminal mouse reporting and cleanup. Emitting competing mouse-mode sequences would create lifecycle and compatibility problems.

### Tool rendering

Pi renders each tool call/result as a public `ToolExecutionComponent`:

```ts
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
```

The component has the public method:

```ts
setExpanded(expanded: boolean): void
```

Its actual `expanded` field is private implementation state. Avoid depending on that field where possible. The extension can maintain its own effective state using the global state and a per-component override table.

### Global expansion API

The extension UI context exposes:

```ts
ctx.ui.getToolsExpanded(): boolean;
ctx.ui.setToolsExpanded(expanded: boolean): void;
```

The extension should not call `setToolsExpanded()` for a mouse click because that would affect every tool. It should call `setExpanded()` only on the selected `ToolExecutionComponent`.

## Recommended user semantics

Use the following semantics because they preserve the meaning of both controls:

1. A click toggles only the selected tool.
2. `Ctrl+o` continues to toggle all tools.
3. When the global expansion state changes, clear all per-tool overrides. The next render then reflects Pi's global state for every tool.
4. Newly created tools inherit Pi's current global state unless clicked.
5. Per-tool state is in-memory only and is discarded on session changes, tree navigation, reload, and shutdown.

This means `Ctrl+o` acts as a useful global reset rather than being silently overridden by old click state.

## Proposed package layout

Create:

```text
tool-expansion/
├── package.json
├── tsconfig.json
├── plan.md
├── src/
│   ├── index.ts
│   ├── mouse.ts
│   ├── hit-test.ts
│   ├── input-priority.ts
│   └── types.ts              # optional; keep only if it improves clarity
└── test/
    ├── mouse.test.ts
    ├── hit-test.test.ts
    ├── input-priority.test.ts
    └── state.test.ts
```

A smaller file count is fine, but keep mouse parsing, listener ordering, and layout hit-testing independently testable.

Follow repository conventions from `sidebar-vflo`:

- ESM package.
- Strict TypeScript.
- Vitest.
- `typecheck`, `test`, and `check` scripts.
- Pi packages as peer dependencies and development dependencies.

Because this extension uses private Pi internals, prefer a release range tied to the known layout/input implementation, for example:

```json
"peerDependencies": {
  "@earendil-works/pi-coding-agent": ">=0.84.1 <0.85.0",
  "@earendil-works/pi-tui": ">=0.84.1 <0.85.0"
}
```

If the implementation chooses a broader range, it must include runtime feature detection and a compatibility warning. Do not pretend that private layout access is stable across arbitrary versions.

## Architecture

### Runtime state

Keep one session-scoped runtime object containing:

```ts
interface Runtime {
  ctx: ExtensionContext;
  tui?: TUI;
  unsubscribeInput?: () => void;
  hookWidgetInstalled: boolean;
  enabled: boolean;
  compatibilityWarningShown: boolean;
  lastGlobalExpanded?: boolean;
  overrides: WeakMap<ToolExecutionComponent, boolean>;
  applied: WeakMap<ToolExecutionComponent, boolean>;
}
```

The exact shape may differ, but the state should be isolated per session and should not survive a session replacement through stale references.

Use a `WeakMap` keyed by the component object rather than a map keyed by private `toolCallId`:

- It avoids reading another private field.
- It naturally drops entries when Pi discards components.
- Pi normally reuses the same component while a transcript is alive.
- Clear/recreate the maps on global-state changes and session/tree changes.

### Capturing the current TUI

`ctx.ui.onTerminalInput()` gives the extension raw input but does not pass the TUI object. Use a zero-line widget below the editor to capture Pi's stable TUI reference:

```ts
ctx.ui.setWidget(
  "tool-expansion-vflo-input-hook",
  (tui) => {
    runtime.tui = tui;
    return {
      render() {
        // Re-apply input-listener priority and state reconciliation here.
        return [];
      },
      invalidate() {},
    };
  },
  { placement: "belowEditor" },
);
```

The below-editor placement is important: Pi does not add the leading spacer used by the above-editor widget path, and an empty component should not visibly change the layout.

This widget is a public-API bridge to the current TUI. It also gives the extension a render-time opportunity to re-prioritize its listener after Pi switches between regular and fullscreen renderers.

Clean it up with:

```ts
ctx.ui.setWidget("tool-expansion-vflo-input-hook", undefined);
```

Use a unique key and document that the extension owns it.

### Installing and prioritizing the input listener

Register the handler using the public API:

```ts
runtime.unsubscribeInput = ctx.ui.onTerminalInput((data) => {
  return handleTerminalInput(runtime, data);
});
```

Then, from the hook widget's `render()` and immediately after subscription, feature-detect and reorder the private listener set:

```ts
function prioritizeInputListener(tui: TUI, handler: InputListener): boolean {
  if (tui.mode !== "fullscreen") return false;

  const listeners = (tui as unknown as { inputListeners?: unknown }).inputListeners;
  if (!(listeners instanceof Set) || !listeners.has(handler)) return false;

  if ([...listeners][0] === handler) return true;

  const existing = [...listeners];
  listeners.clear();
  listeners.add(handler);
  for (const listener of existing) {
    if (listener !== handler) listeners.add(listener);
  }
  return true;
}
```

Do not reorder the set from inside the input handler itself. Mutating a `Set` while it is being iterated can produce confusing iteration behavior. Reorder during render, after registration, and after any known renderer rebind opportunity.

If the set is unavailable, return `undefined` from the handler and disable click behavior. Show at most one warning, and do not throw.

Important lifecycle detail: when Pi switches TUI renderer, `InteractiveMode` rebinds extension listeners to the new renderer. The old listener ordering does not carry over. The hook widget's render-time priority check is therefore required.

### Hidden hook widget caveat

This is an intentional compatibility workaround. It should return no lines and do no work other than:

- capture the TUI reference,
- ensure listener priority,
- reconcile per-tool state.

Do not put user-visible controls in this widget.

## Mouse parsing

Implement a small pure parser in `src/mouse.ts`.

Pi's `StdinBuffer` already handles partial escape sequences, so the extension should parse complete strings and should not add another buffering layer.

At minimum support SGR:

```text
ESC [ < button ; column ; row M   # press/motion/wheel
ESC [ < button ; column ; row m   # release
```

Convert SGR's one-based coordinates to zero-based coordinates immediately.

For a toggle, accept only an unmodified primary-button press:

- `button === 0`
- release marker is `M`
- no motion bit (`32`)
- no wheel bit (`64`)
- no modifier bits (`4`, `8`, `16`)

Ignore:

- release events,
- motion events,
- wheel events,
- secondary/middle buttons,
- modified clicks,
- malformed coordinates.

The parser may support legacy six-byte mouse sequences as a small compatibility improvement, but SGR is the required path because Pi enables SGR reporting in fullscreen mode. If legacy support is added, test it separately and do not confuse its byte coordinates with SGR's decimal coordinates.

The input handler must return:

- `{ consume: true }` only after it has toggled a matching tool header.
- `undefined` for every non-target event, so Pi handles it normally.
- `{ consume: true }` for a target click even if no state change was necessary, to prevent the click from starting text selection after it was interpreted as a tool action.

## Overlay and focus safety

Never steal clicks from an active dialog or capturing overlay.

For the first version use a conservative guard:

```ts
if (tui.hasOverlay()) return undefined;
```

This may temporarily disable clicks while a non-capturing extension overlay is present. That is acceptable for the first version and safer than toggling an underlying tool when the user clicked a visible overlay.

A more advanced implementation can inspect private `overlayStack` entries and distinguish `options.nonCapturing`, but it should not be required for the MVP. If this is implemented, retain a conservative fallback when overlay geometry or visibility cannot be determined.

Also check:

- `tui.mode === "fullscreen"`.
- A usable `currentLayout` exists.
- The click coordinates are inside the terminal dimensions if those are available.

## Hit-testing

### Why use the current layout

`TuiAltScreen` computes a `currentLayout` after rendering. Its layout frame contains `LayoutBox` objects with:

```ts
component;
rect: { x, y, width, height };
clip: { x, y, width, height };
lines;
lineOffset;
children;
```

The fullscreen layout already accounts for transcript scrolling, fixed dock rows, clipping, and terminal coordinates. Do not manually calculate the scroll offset from the transcript.

Access this privately and untyped:

```ts
const frame = (tui as unknown as { currentLayout?: unknown }).currentLayout;
```

Do not import private `layout.js` APIs as package imports. Traverse the layout object defensively.

### Tool identification

Prefer:

```ts
box.component instanceof ToolExecutionComponent
```

If runtime duplication makes `instanceof` unreliable, use a strict duck-type fallback requiring:

- constructor name `ToolExecutionComponent`,
- a callable `setExpanded` method,
- a component-like `render` method.

Keep the fallback narrow so arbitrary expandable components are not treated as tools.

### Click target

Only the first non-empty rendered line of the tool component should be clickable.

This is the tool header/call row in Pi's built-in rendering. It is safer than making the whole box clickable because output-body clicks are needed for selection.

To find the row:

1. Read `box.lines` if it is an array.
2. Strip terminal sequences using the public `stripTerminalSequences()` helper from `@earendil-works/pi-tui`.
3. Find the first line whose stripped text contains non-whitespace characters.
4. Convert that source-line index to a screen row using:

```ts
screenRow = box.rect.y + sourceIndex - (box.lineOffset ?? 0);
```

5. Require:
   - `event.y === screenRow`,
   - `event.x` is inside `box.rect`,
   - the point is inside `box.clip`.

The layout's `rect.y` is already translated for transcript scrolling. A tool whose header is scrolled off-screen must not be clickable.

Some tool renderers may have no non-empty header line. In that case, do not create a hit target.

### Traversal

Walk `frame.root` recursively through `children`. Return the first matching visible tool header. Keep traversal defensive:

- Ignore malformed boxes.
- Ignore negative/zero dimensions.
- Avoid assuming every node has `children` or `lines`.
- Do not mutate the layout.

Unit-test hit-testing with fake boxes rather than requiring a live terminal.

## Per-tool state reconciliation

The global state and local overrides must coexist without fighting each other.

### State rules

- `lastGlobalExpanded` starts as `ctx.ui.getToolsExpanded()` at session setup.
- On every hook-widget render and input event, read `ctx.ui.getToolsExpanded()`.
- If it differs from `lastGlobalExpanded`:
  - replace `runtime.overrides` with a new empty `WeakMap`,
  - replace `runtime.applied` with a new empty `WeakMap`,
  - update `lastGlobalExpanded`.
- If the global value did not change:
  - for each visible tool with a local override, ensure `component.setExpanded(override)` has been applied.

Do not repeatedly call `setExpanded()` every frame. Track what the extension last applied in `runtime.applied` and call it only when the desired value differs from the recorded applied value.

The reconciliation hook may run after the transcript has already been rendered in the current layout pass because the invisible widget is in the dock. If it changes a component, call `tui.requestRender()` once so the next frame reflects it. Avoid an unconditional request from every render, or it will create a render loop.

### Click handling pseudocode

```ts
function handleToolClick(runtime: Runtime, component: ToolExecutionComponent): void {
  reconcileGlobalState(runtime);

  const global = runtime.ctx.ui.getToolsExpanded();
  const current = runtime.overrides.get(component) ?? global;
  const next = !current;

  runtime.overrides.set(component, next);
  runtime.applied.set(component, next);
  component.setExpanded(next);
  runtime.tui?.requestRender();
}
```

A component that has not been clicked follows the global state. A clicked component follows its local override until the user invokes the global toggle.

Clear the maps on:

- `session_start`,
- `session_tree`,
- `session_shutdown`.

## Lifecycle

Register the extension handlers in the factory, but create session-bound UI/input resources from `session_start`.

### `session_start`

Only install the hook when:

```ts
ctx.mode === "tui"
```

Create the runtime, install the zero-line widget, register `onTerminalInput`, initialize `lastGlobalExpanded`, and request a render.

The current TUI may initially be regular even though the user later switches to fullscreen. The listener may remain registered, but click handling must always check the current `tui.mode` and only activate in fullscreen.

### `session_tree`

Clear per-component overrides and applied-state tracking. Pi may rebuild transcript components after tree navigation.

### `session_shutdown`

In this order:

1. Unsubscribe the raw input listener.
2. Clear the hook widget with `setWidget(..., undefined)`.
3. Drop the runtime reference.
4. Do not reuse the old `ctx`, TUI proxy, or component references after shutdown.

The extension must also be safe if shutdown cleanup is called more than once.

### `/reload` and renderer switches

Pi tears down and reloads extension runtime state during `/reload` and session replacement. Do not keep module-global TUI or component references that outlive the session runtime.

When the user switches between regular and fullscreen mode, the hook widget and input subscription may be rebound. Re-run listener-priority detection from the widget render and continue to guard on `tui.mode`.

## Error handling and compatibility behavior

The extension must be non-invasive:

- Never throw from the input handler.
- Wrap private-field access and hit-testing in narrow try/catch blocks.
- If compatibility checks fail, return `undefined` and let Pi process the event.
- Show at most one warning per session, preferably only when the user attempts a click or when the hook first detects an unsupported renderer.
- Do not disable Pi's normal mouse reporting.
- Do not monkey-patch `TuiAltScreen` methods.
- Do not patch `hasOverlay`, renderer methods, or layout generation for the MVP.

If the extension cannot establish listener priority, it should remain loaded but effectively inert rather than consuming clicks after the viewport has already handled them.

## Testing plan

### Pure parser tests (`mouse.test.ts`)

Test:

- SGR primary press.
- SGR primary release.
- wheel event ignored.
- motion event ignored.
- modified click ignored.
- middle/right click ignored.
- malformed sequence ignored.
- one-based to zero-based coordinate conversion.
- optional legacy sequence behavior if implemented.

### Listener ordering tests (`input-priority.test.ts`)

Use a fake fullscreen TUI with an `inputListeners: Set` containing a host listener and extension handler.

Verify:

- extension becomes first,
- relative order of all other listeners is preserved,
- calling priority repeatedly is idempotent,
- regular mode is not modified,
- missing/private-shape-invalid listener set fails safely.

### Hit-test tests (`hit-test.test.ts`)

Build fake layout frames containing:

- a tool box at a known screen row,
- a tool whose header is clipped,
- a tool below the viewport,
- multiple tools,
- malformed/non-tool boxes,
- `lineOffset` values,
- ANSI-styled header lines and blank padded lines.

Verify only the first non-empty header row matches and body rows do not.

### State tests (`state.test.ts`)

Verify:

- untouched tools follow global state,
- clicking one tool changes only that component,
- repeated click toggles the same component,
- global state change clears local overrides,
- new tools use the new global state,
- session/tree reset clears local state.

### Manual integration test

Run against the current Pi installation in fullscreen mode, preferably with only this extension first:

```bash
cd /home/vflores/repos/pi-tools/tool-expansion
npm install
npm run check
pi --no-extensions -e ./src/index.ts --tui-mode fullscreen
```

Generate several tool calls with distinct outputs. Verify:

1. A click on tool A's header changes only A.
2. A click on tool B changes only B.
3. Clicking output body still permits selection/copying.
4. Wheel scrolling still works.
5. Scrollbar behavior remains unchanged.
6. `Ctrl+o` changes all tools and clears local exceptions.
7. Clicking a tool after scrolling uses the visible screen position, not its unscrolled document position.
8. A tool expanding near the bottom redraws correctly without ghost rows.
9. Streaming tools remain usable.
10. Opening `/settings` or another overlay prevents underlying tool clicks.
11. `/reload`, `/new`, `/resume`, `/fork`, and `/tree` do not leave a stale listener or hook widget.
12. Switching regular/fullscreen does not cause crashes; clicks are active only in fullscreen.

Then test alongside existing repository extensions, especially:

- `sidebar-vflo`,
- `subagents-vflo`.

Pay particular attention to listener ordering conflicts. Multiple extensions may reorder the private listener set; each must preserve the other listeners and avoid permanently consuming unrelated input.

## Known limitations to document

- The extension is coupled to Pi's current private fullscreen layout and input-listener implementation.
- A Pi upgrade may temporarily disable click handling until the compatibility code is updated.
- The first version targets tool header rows, not the entire output box.
- Non-capturing overlays may conservatively disable clicks while visible.
- Per-tool expansion state is not persisted.
- Regular mode is intentionally unsupported.

## Implementation order

1. Create package metadata, TypeScript config, and test scripts.
2. Implement and test SGR mouse parsing.
3. Implement and test input-listener priority detection.
4. Implement defensive layout traversal and header hit-testing.
5. Implement runtime lifecycle and the zero-line hook widget.
6. Implement per-component expansion overrides and global-state reconciliation.
7. Connect the input handler, preserving pass-through behavior.
8. Add lifecycle, state, and integration tests.
9. Run `npm run check` and manual fullscreen tests.
10. Only after the MVP is stable, consider legacy mouse support or non-capturing overlay geometry.

## Acceptance criteria

The implementation is complete when:

- `npm run check` passes in `tool-expansion`.
- In fullscreen mode, clicking an individual tool header toggles only that tool.
- Normal scrolling, selection, hyperlinks, and keyboard input continue to work.
- `Ctrl+o` still toggles all tool output and resets local click overrides.
- The extension is inert outside fullscreen mode.
- Missing private TUI fields cause graceful degradation rather than a Pi crash.
- Session replacement, reload, and renderer switching do not leak listeners, widgets, or stale component state.
