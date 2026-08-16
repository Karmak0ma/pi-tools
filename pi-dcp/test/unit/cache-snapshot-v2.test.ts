import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { defaults } from "../../src/config/defaults.ts";
import { emptyState } from "../../src/state/reducer.ts";
import { transformOutgoingContext } from "../../src/transform/pipeline.ts";
import { isCompressionParams } from "../../src/compression/schema.ts";
import { createEnvelope, OPERATION_CUSTOM_TYPE } from "../../src/state/operations.ts";
import { reconstructFromBranch } from "../../src/state/reconstruct.ts";
import { adapterForModel } from "../../src/transform/adapters.ts";

function context(messages: AgentMessage[], leaf: string) {
  const entries = messages.map((message, index) => ({
    type: "message",
    id: `entry-${index + 1}`,
    parentId: index ? `entry-${index}` : null,
    timestamp: new Date((index + 1) * 1000).toISOString(),
    message,
  }));
  return {
    cwd: "/tmp",
    model: { provider: "test", id: "model", api: "test", contextWindow: 10_000 },
    getContextUsage: () => ({ tokens: null, contextWindow: 10_000 }),
    sessionManager: { buildContextEntries: () => entries, getLeafId: () => leaf },
  } as any;
}

function messages(): AgentMessage[] {
  return [
    { role: "user", content: "closed work", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "finished" }], provider: "test", model: "model", api: "test", stopReason: "stop", timestamp: 2 } as any,
  ];
}

describe("cache snapshot redesign v2", () => {
  it("renders equivalent transforms identically and without dynamic DCP content", () => {
    const input = messages();
    const options = { ctx: context(input, "entry-2"), sessionId: "session", generation: 1, state: emptyState(), config: structuredClone(defaults) as any };
    const first = transformOutgoingContext(input, options);
    const second = transformOutgoingContext(input, { ...options, ctx: context(input, "entry-2") });
    expect(second.messages).toEqual(first.messages);
    const dcpText = first.messages.filter((message) => message.role === "custom").map((message) => String(message.content)).join("\n");
    expect(dcpText).not.toMatch(/baseline-|snapshot|expires|T\d{2}:\d{2}/i);
  });

  it("keeps the old wire prefix when ordinary history is appended", () => {
    const before = messages();
    const after = [...before, { role: "user", content: "new request", timestamp: 3 } as AgentMessage];
    const first = transformOutgoingContext(before, { ctx: context(before, "entry-2"), sessionId: "session", generation: 1, state: emptyState(), config: structuredClone(defaults) as any });
    const second = transformOutgoingContext(after, { ctx: context(after, "entry-3"), sessionId: "session", generation: 1, state: emptyState(), config: structuredClone(defaults) as any });
    expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages);
    const adapter = adapterForModel({ api: "test" });
    expect(adapter).toBeDefined();
    expect((adapter!.canonicalWire(second.messages) as unknown[]).slice(0, (adapter!.canonicalWire(first.messages) as unknown[]).length)).toEqual(adapter!.canonicalWire(first.messages));
  });

  it("breaks the public schema cleanly and replays v2 operations across forks", () => {
    expect(isCompressionParams({ snapshotId: "legacy", topic: "x", content: [] })).toBe(false);
    expect(isCompressionParams({ topic: "x", content: [{ startId: "m0001", endId: "m0001", summary: "done" }] })).toBe(true);
    const envelope = createEnvelope({ type: "manual.changed", enabled: true }, "origin-session", "0.2.0", "fork-request");
    const result = reconstructFromBranch([{
      type: "custom", id: "operation", parentId: null, timestamp: new Date(1).toISOString(), customType: OPERATION_CUSTOM_TYPE, data: envelope,
    } as any], "different-destination-session");
    expect(result.state.corruptReason).toBeUndefined();
    expect(result.state.manualMode).toBe(true);
  });
});
