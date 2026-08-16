import { afterEach, describe, expect, it, vi } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { InspectorComponent } from "./inspector.js";
import { createInstance, SubagentTracker } from "../tracker.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function createFakeTui() {
  return {
    terminal: { rows: 24, columns: 80 },
    requestRender: vi.fn(),
  } as any;
}

function elapsedLine(lines: string[]): string | undefined {
  return lines.find((line) => line.includes("Elapsed"));
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("InspectorComponent live tool rendering", () => {
  it("refreshes a running bash command's elapsed time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    initTheme();

    const tracker = new SubagentTracker();
    const instance = createInstance({
      id: "subagent-1",
      agent: "worker",
      source: "builtin",
      task: "run a command",
      cwd: "/tmp",
    });
    instance.status = "running";
    instance.summary.status = "running";
    instance.events.push(
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              toolCallId: "call-1",
              name: "bash",
              arguments: { command: "sleep 10" },
            },
          ],
        },
      },
      {
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "sleep 10" },
      },
      {
        type: "tool_execution_update",
        toolCallId: "call-1",
        toolName: "bash",
        partialResult: { content: [], details: undefined },
      },
    );
    tracker.add(instance);

    const tui = createFakeTui();
    const inspector = new InspectorComponent(
      tracker,
      tui,
      theme,
      {
        onClose: vi.fn(),
        onAbort: vi.fn(),
        onMessage: async () => {},
      },
    );

    const initialElapsed = elapsedLine(inspector.render(80));
    expect(initialElapsed).toContain("Elapsed 0.0s");

    vi.advanceTimersByTime(1500);

    // The bash renderer's timer requests a frame and invalidates its own
    // component. The inspector must also invalidate its cached viewport so
    // that the updated child output is actually rendered.
    expect(tui.requestRender).toHaveBeenCalled();
    const updatedElapsed = elapsedLine(inspector.render(80));
    expect(updatedElapsed).toContain("Elapsed 1.0s");
    expect(updatedElapsed).not.toBe(initialElapsed);
  });

  it("applies Ctrl+O to completed tool components owned by the inspector", () => {
    initTheme();

    let toolsExpanded = false;
    const tracker = new SubagentTracker();
    const instance = createInstance({
      id: "subagent-2",
      agent: "worker",
      source: "builtin",
      task: "read a file",
      cwd: "/tmp",
    });
    instance.status = "completed";
    instance.summary.status = "completed";
    instance.events.push(
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              toolCallId: "call-2",
              name: "read",
              arguments: { path: "/tmp/example.txt" },
            },
          ],
        },
      },
      {
        type: "tool_execution_end",
        toolCallId: "call-2",
        toolName: "read",
        result: {
          content: [{ type: "text", text: "example output" }],
          details: undefined,
          isError: false,
        },
        isError: false,
      },
    );
    tracker.add(instance);

    const tui = createFakeTui();
    const setToolsExpanded = vi.fn((expanded: boolean) => {
      toolsExpanded = expanded;
    });
    const inspector = new InspectorComponent(
      tracker,
      tui,
      theme,
      {
        onClose: vi.fn(),
        onAbort: vi.fn(),
        onMessage: async () => {},
      },
      undefined,
      {
        getToolsExpanded: () => toolsExpanded,
        setToolsExpanded,
      },
    );

    const collapsedView = inspector.render(80).join("\n");
    const tab = (inspector as any).tabStates.get(instance.id);
    const toolComponents = [...tab.toolExecutions] as Array<{ expanded: boolean }>;
    expect(toolComponents).toHaveLength(1);
    expect(tab.activeToolExecutions.size).toBe(0);
    expect(toolComponents[0].expanded).toBe(false);

    inspector.handleInput("\x0f");
    expect(setToolsExpanded).toHaveBeenLastCalledWith(true);
    expect(toolComponents[0].expanded).toBe(true);
    expect(inspector.render(80).join("\n")).not.toBe(collapsedView);

    inspector.handleInput("\x0f");
    expect(setToolsExpanded).toHaveBeenLastCalledWith(false);
    expect(toolComponents[0].expanded).toBe(false);
    expect(inspector.render(80).join("\n")).toBe(collapsedView);
  });
});
