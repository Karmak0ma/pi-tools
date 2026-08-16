import { describe, expect, it, vi } from "vitest";
import toolExpansion from "../src/index.js";

class ToolExecutionComponent {
  expanded = false;
  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
  }
  render(): string[] {
    return [];
  }
}

function createContext(mode: "tui" | "rpc") {
  let globalExpanded = false;
  let rawInput: ((data: string) => { consume?: boolean } | undefined) | undefined;
  let widget: { render(width: number): string[]; invalidate(): void } | undefined;
  let widgetCleared = false;
  const inputListeners = new Set<((data: string) => { consume?: boolean } | undefined)>();
  const tool = new ToolExecutionComponent();
  const tui = {
    mode: "fullscreen" as const,
    inputListeners,
    terminal: { columns: 80, rows: 24 },
    hasOverlay: () => false,
    requestRender: vi.fn(),
    currentLayout: {
      root: {
        component: {},
        rect: { x: 0, y: 2, width: 30, height: 3 },
        clip: { x: 0, y: 2, width: 30, height: 3 },
        lines: ["tool header", "body"],
        children: [],
      },
    },
  };
  const ui = {
    getToolsExpanded: () => globalExpanded,
    setToolsExpanded: (expanded: boolean) => { globalExpanded = expanded; },
    notify: vi.fn(),
    onTerminalInput: (handler: (data: string) => { consume?: boolean } | undefined) => {
      rawInput = handler;
      inputListeners.add(handler);
      return () => inputListeners.delete(handler);
    },
    setWidget: (_key: string, content: unknown) => {
      if (content === undefined) {
        widget = undefined;
        widgetCleared = true;
        return;
      }
      widget = (content as (nextTui: unknown, theme: unknown) => { render(width: number): string[]; invalidate(): void })(tui, {});
    },
  };
  const ctx = {
    mode,
    ui,
    sessionManager: {},
  };
  return {
    ctx,
    tui,
    tool,
    getRawInput: () => rawInput,
    getWidget: () => widget,
    wasWidgetCleared: () => widgetCleared,
    listenerCount: () => inputListeners.size,
  };
}

describe("tool expansion lifecycle", () => {
  it("installs a fullscreen-priority listener and toggles only a matching header", () => {
    const registrations = new Map<string, (event: unknown, ctx: any) => void>();
    toolExpansion({ on: (event: string, handler: (event: unknown, ctx: any) => void) => registrations.set(event, handler) } as any);
    const fixture = createContext("tui");
    fixture.tui.currentLayout.root.component = fixture.tool;

    registrations.get("session_start")?.({ type: "session_start" }, fixture.ctx);
    fixture.getWidget()?.render(80);
    const input = fixture.getRawInput();
    expect(input).toBeDefined();
    expect(input?.("\u001b[<0;3;3M")).toEqual({ consume: true });
    expect(fixture.tool.expanded).toBe(true);
    expect(input?.("\u001b[<0;3;4M")).toBeUndefined();

    registrations.get("session_shutdown")?.({ type: "session_shutdown" }, fixture.ctx);
    expect(fixture.wasWidgetCleared()).toBe(true);
    expect(fixture.listenerCount()).toBe(0);
  });

  it("does not install terminal resources outside TUI mode", () => {
    const registrations = new Map<string, (event: unknown, ctx: any) => void>();
    toolExpansion({ on: (event: string, handler: (event: unknown, ctx: any) => void) => registrations.set(event, handler) } as any);
    const fixture = createContext("rpc");

    registrations.get("session_start")?.({ type: "session_start" }, fixture.ctx);
    expect(fixture.getRawInput()).toBeUndefined();
    expect(fixture.getWidget()).toBeUndefined();
  });
});
