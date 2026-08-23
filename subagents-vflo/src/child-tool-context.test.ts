import { describe, expect, it, vi } from "vitest";

// index.ts also registers the extension schema at module load. The repository
// tests do not install typebox directly, so keep this test focused on the
// exported event-tracking seam rather than the schema implementation.
vi.mock("typebox", () => {
  const schema = () => ({});
  return { Type: { Object: schema, String: schema, Optional: schema, Union: schema, Literal: schema, Array: schema } };
});
import { ChildExtensionUIBroker, type ChildUIDialogPresenter, type QueuedChildUIRequest } from "./extension-ui-broker.js";
import type { ChildExtensionUIDialogRequest, ChildExtensionUIResponse } from "./rpc-extension-ui.js";
import type { ChildExtensionUIChannel } from "./runner.js";
import { trackActiveChildToolCalls } from "./index.js";

function owner() {
  return { instanceId: "task-1", agent: "build", task: "run the requested task", cwd: "/tmp" };
}

describe("announced child tool context", () => {
  it("hands an announced bash command to the broker before tool execution starts", async () => {
    const activeToolCalls = new Map();
    const command = "printf 'approval modal must show this'";

    // This is the real ordering that matters: the assistant message arrives,
    // then the guardrail's select request arrives, with no execution-start
    // event in between.
    trackActiveChildToolCalls(activeToolCalls, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command } }],
      },
    });

    const request: ChildExtensionUIDialogRequest = {
      type: "extension_ui_request",
      id: "request-1",
      method: "select",
      title: "Allow command?",
      options: ["Allow once", "Deny"],
    };
    const writes: ChildExtensionUIResponse[] = [];
    const channel: ChildExtensionUIChannel = {
      respond(response) {
        writes.push(response);
        return true;
      },
      forget() {},
      isOpen() { return true; },
    };
    let handedToBroker: Pick<QueuedChildUIRequest, "request" | "activeToolCalls"> | undefined;
    const presenter: ChildUIDialogPresenter = {
      async present(item) {
        handedToBroker = { request: item.request, activeToolCalls: [...item.activeToolCalls] };
        return { kind: "value", value: "Deny" };
      },
    };
    const broker = new ChildExtensionUIBroker();

    expect(broker.enqueue({
      owner: owner(),
      request,
      channel,
      presenter,
      activeToolCalls: Array.from(activeToolCalls.values()),
    })).toBe(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(handedToBroker?.request).toEqual(request);
    expect(handedToBroker?.activeToolCalls).toHaveLength(1);
    expect(handedToBroker?.activeToolCalls[0]).toMatchObject({
      toolCallId: "call-1",
      toolName: "bash",
      args: { command },
    });
    expect(writes).toEqual([{ type: "extension_ui_response", id: "request-1", value: "Deny" }]);
  });

  it("upgrades an announcement in place and clears it at execution and terminal events", () => {
    const activeToolCalls = new Map();
    trackActiveChildToolCalls(activeToolCalls, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "old" } }],
      },
    });

    trackActiveChildToolCalls(activeToolCalls, {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "authoritative" },
    });
    expect(activeToolCalls).toHaveLength(1);
    expect(activeToolCalls.get("call-1").args).toEqual({ command: "authoritative" });

    trackActiveChildToolCalls(activeToolCalls, { type: "tool_execution_end", toolCallId: "call-1" });
    expect(activeToolCalls).toHaveLength(0);

    trackActiveChildToolCalls(activeToolCalls, {
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        toolCall: { type: "toolCall", id: "call-2", name: "bash", arguments: { command: "blocked" } },
      },
    });
    trackActiveChildToolCalls(activeToolCalls, { type: "agent_end" });
    expect(activeToolCalls).toHaveLength(0);
  });
});
