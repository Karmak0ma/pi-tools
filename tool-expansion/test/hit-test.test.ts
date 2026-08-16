import { describe, expect, it } from "vitest";
import { collectToolComponents, findToolAt } from "../src/hit-test.js";

// The local class name exercises the strict duplicate-package fallback. In a
// live Pi process the imported ToolExecutionComponent passes instanceof first.
class ToolExecutionComponent {
  expanded = false;
  constructor(private readonly renderedLines: string[] = []) {}
  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
  }
  render(): string[] {
    return this.renderedLines;
  }
}

// Pi's document/chat containers are ordinary Containers. Their children are
// rendered into one leaf layout box rather than represented as child boxes.
class Container {
  constructor(public readonly children: unknown[]) {}
  render(width: number): string[] {
    void width;
    return this.children.flatMap((child) =>
      child && typeof child === "object" && "render" in child && typeof child.render === "function"
        ? child.render(width)
        : [],
    );
  }
}

function box(
  component: unknown,
  rect: { x: number; y: number; width: number; height: number },
  lines: string[],
  lineOffset = 0,
  clip = rect,
): Record<string, unknown> {
  return { component, rect, clip, lines, lineOffset, children: [] };
}

function frame(...children: unknown[]): { root: Record<string, unknown> } {
  return { root: { children } };
}

describe("fullscreen layout hit testing", () => {
  it("matches only the first non-empty header row", () => {
    const tool = new ToolExecutionComponent();
    const layout = frame(box(tool, { x: 2, y: 5, width: 30, height: 5 }, ["   ", "\u001b[31m tool call\u001b[0m", "body"]));

    expect(findToolAt(layout, { x: 4, y: 5 })).toBeUndefined();
    expect(findToolAt(layout, { x: 4, y: 6 })).toBe(tool);
    expect(findToolAt(layout, { x: 4, y: 7 })).toBeUndefined();
    expect(findToolAt(layout, { x: 1, y: 6 })).toBeUndefined();
  });

  it("applies lineOffset when mapping a rendered source row", () => {
    const tool = new ToolExecutionComponent();
    const layout = frame(box(tool, { x: 0, y: 10, width: 20, height: 3 }, ["", "header", "body"], 1));
    expect(findToolAt(layout, { x: 1, y: 10 })).toBe(tool);
    expect(findToolAt(layout, { x: 1, y: 11 })).toBeUndefined();
  });

  it("does not match a clipped header or body row", () => {
    const clipped = new ToolExecutionComponent();
    const body = new ToolExecutionComponent();
    const layout = frame(
      box(clipped, { x: 0, y: 2, width: 20, height: 4 }, ["header", "body"], 0, { x: 0, y: 3, width: 20, height: 3 }),
      box(body, { x: 0, y: 10, width: 20, height: 3 }, ["header", "body"]),
    );

    expect(findToolAt(layout, { x: 1, y: 2 })).toBeUndefined();
    expect(findToolAt(layout, { x: 1, y: 11 })).toBeUndefined();
  });

  it("skips malformed and non-tool boxes and finds the matching child", () => {
    const tool = new ToolExecutionComponent();
    const layout = frame(
      { component: { setExpanded() {}, render() { return []; } }, rect: { x: 0, y: 0, width: 20, height: 2 }, clip: { x: 0, y: 0, width: 20, height: 2 }, lines: ["not a tool"], children: [] },
      { rect: { x: 0, y: 0, width: 20, height: 2 }, children: [{ component: tool, rect: { x: 1, y: 4, width: 10, height: 2 }, clip: { x: 1, y: 4, width: 10, height: 2 }, lines: ["child header"] }] },
      { component: tool, rect: { x: 0, y: 8, width: 0, height: 2 }, clip: { x: 0, y: 8, width: 0, height: 2 }, lines: ["bad"] },
    );

    expect(findToolAt(layout, { x: 2, y: 4 })).toBe(tool);
    expect(collectToolComponents(layout)).toEqual([tool]);
  });

  it("finds tools flattened inside a Container layout box", () => {
    const first = new ToolExecutionComponent(["", "first header"]);
    const second = new ToolExecutionComponent(["", "second header"]);
    const container = new Container([first, second]);
    const layout = frame(box(container, { x: 0, y: 3, width: 30, height: 4 }, ["", "first header", "", "second header"]));

    expect(findToolAt(layout, { x: 2, y: 4 })).toBe(first);
    expect(findToolAt(layout, { x: 2, y: 5 })).toBeUndefined();
    expect(findToolAt(layout, { x: 2, y: 6 })).toBe(second);
    expect(collectToolComponents(layout)).toEqual([first, second]);
  });

  it("returns no target for an empty or missing header", () => {
    const blank = new ToolExecutionComponent();
    const layout = frame(box(blank, { x: 0, y: 0, width: 10, height: 3 }, ["   ", "\u001b[0m", "  "]));
    expect(findToolAt(layout, { x: 1, y: 0 })).toBeUndefined();
  });
});
