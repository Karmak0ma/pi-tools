import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { defaults } from "../../src/config/defaults.ts";
import { emptyState } from "../../src/state/reducer.ts";
import { transformOutgoingContext } from "../../src/transform/pipeline.ts";

function context(messages: AgentMessage[]) {
  const entries = messages.map((message, index) => ({ type: "message", id: `entry-${index + 1}`, parentId: index ? `entry-${index}` : null, timestamp: new Date(index + 1).toISOString(), message }));
  return { cwd: "/tmp", model: { provider: "test", id: "model", api: "test", contextWindow: 10_000 }, getContextUsage: () => ({ tokens: null, contextWindow: 10_000 }), sessionManager: { buildContextEntries: () => entries, getLeafId: () => `entry-${entries.length}` } } as any;
}

describe("inline message labels", () => {
  it("labels content without creating synthetic unit messages", () => {
    const thinking = { type: "thinking", thinking: "opaque reasoning", thinkingSignature: "signature" } as const;
    const messages: AgentMessage[] = [
      { role: "user", content: "closed request", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "finished" }], provider: "test", model: "model", api: "test", stopReason: "stop", timestamp: 2 } as any,
      { role: "assistant", content: [thinking, { type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "src/important.ts" } }], provider: "test", model: "model", api: "test", stopReason: "toolUse", timestamp: 3 } as any,
      { role: "toolResult", toolCallId: "edit-1", toolName: "edit", content: [{ type: "text", text: "changed" }], isError: false, timestamp: 4 },
    ];
    const result = transformOutgoingContext(messages, { ctx: context(messages), sessionId: "s", generation: 1, state: emptyState(), config: structuredClone(defaults) as any });
    expect(result.snapshot).toBeDefined();
    expect(result.messages.some((message) => message.role === "custom" && message.customType === "pi-dcp.v2.unit")).toBe(false);
    const assistant = result.messages.find((message) => message.role === "assistant" && message.content.some((part) => part.type === "thinking")) as any;
    expect(assistant.content[0]).toEqual(thinking);
    // The edit tool call is no longer BLOCKED: tool-output protection now
    // absorbs protected tool content into compression summaries instead of
    // rejecting/blocking the unit that contains it (see
    // compression/protected.ts). It gets its own ordinary alias like any
    // other settled unit.
    expect(JSON.stringify(assistant)).toContain("m0003");
    expect(result.messages.some((message) => JSON.stringify(message).includes("BLOCKED"))).toBe(false);
    expect(JSON.stringify(result.messages[1])).toContain("m0002");
  });

  it("is deterministic across equivalent transforms", () => {
    const messages: AgentMessage[] = [{ role: "user", content: "same request", timestamp: 1 }];
    const options = { ctx: context(messages), sessionId: "s", generation: 1, state: emptyState(), config: structuredClone(defaults) as any };
    expect(transformOutgoingContext(messages, options).messages).toEqual(transformOutgoingContext(messages, { ...options, ctx: context(messages) }).messages);
  });
});
