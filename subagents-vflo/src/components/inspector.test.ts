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
});
