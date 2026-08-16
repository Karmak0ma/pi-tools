import { describe, expect, it } from "vitest";
import {
  clearExpansionState,
  createExpansionState,
  reconcileExpansionState,
  toggleToolExpansion,
} from "../src/state.js";

class FakeTool {
  expanded = false;
  calls: boolean[] = [];
  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.calls.push(expanded);
  }
}

describe("per-tool expansion state", () => {
  it("leaves untouched tools following the global state", () => {
    const state = createExpansionState(false);
    const first = new FakeTool();
    const second = new FakeTool();

    toggleToolExpansion(state, first);
    expect(first.expanded).toBe(true);
    expect(second.calls).toEqual([]);
    expect(state.globalExpanded).toBe(false);
  });

  it("toggles only the selected component and toggles it again", () => {
    const state = createExpansionState(false);
    const first = new FakeTool();
    const second = new FakeTool();

    expect(toggleToolExpansion(state, first)).toBe(true);
    expect(toggleToolExpansion(state, first)).toBe(false);
    expect(first.calls).toEqual([true, false]);
    expect(second.calls).toEqual([]);
  });

  it("reapplies local overrides without calling setExpanded every frame", () => {
    const state = createExpansionState(true);
    const tool = new FakeTool();
    toggleToolExpansion(state, tool); // local exception: collapse
    tool.calls = [];

    expect(reconcileExpansionState(state, true, [tool])).toBe(false);
    expect(tool.calls).toEqual([]);
    state.applied = new WeakMap();
    expect(reconcileExpansionState(state, true, [tool])).toBe(true);
    expect(tool.calls).toEqual([false]);
  });

  it("clears local exceptions when the global setting changes", () => {
    const state = createExpansionState(false);
    const clicked = new FakeTool();
    const newTool = new FakeTool();
    toggleToolExpansion(state, clicked);

    expect(reconcileExpansionState(state, true, [clicked, newTool])).toBe(false);
    expect(state.globalExpanded).toBe(true);
    expect(clicked.calls).toEqual([true]);
    expect(state.overrides.has(clicked)).toBe(false);

    toggleToolExpansion(state, newTool);
    expect(newTool.expanded).toBe(false);
  });

  it("resets state on tree navigation while retaining the current global value", () => {
    const state = createExpansionState(true);
    const tool = new FakeTool();
    toggleToolExpansion(state, tool);
    clearExpansionState(state);

    expect(state.globalExpanded).toBe(true);
    expect(state.overrides.has(tool)).toBe(false);
    expect(state.applied.has(tool)).toBe(false);
  });
});
