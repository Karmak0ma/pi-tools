import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { emptyState } from "../../src/state/reducer.ts";
import { applyPersistedRedactions, compressSummaryMarker } from "../../src/transform/tools.ts";

/**
 * The assistant message that calls compress always sits after the range it
 * compresses, so no block can ever cover it. If the authored summary stays in
 * its arguments, the session pays for that text twice for the rest of its life:
 * once here and once in the block replacement pi-dcp renders.
 */
function callWith(summary: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: "call-1", name: "compress", arguments: { topic: "closed work", content: [{ startId: "m0001", endId: "m0004", summary }] } }],
    provider: "test", model: "model", api: "test", stopReason: "toolUse", timestamp: 1,
  } as unknown as AgentMessage;
}

describe("compress tool-call arguments", () => {
  it("keeps the range labels but drops the summary once the block exists", () => {
    const state = emptyState();
    state.compressToolCallIds.add("call-1");

    const [message] = applyPersistedRedactions([callWith("a very long authored summary")], state);
    const part = (message as any).content[0];

    expect(part.arguments.topic).toBe("closed work");
    expect(part.arguments.content[0]).toEqual({ startId: "m0001", endId: "m0004", summary: compressSummaryMarker() });
  });

  it("leaves a call that produced no block untouched", () => {
    // A rejected call never created a block, so its text is not stored anywhere
    // else. Removing it would hide from the model what it just tried to do.
    const [message] = applyPersistedRedactions([callWith("summary of a rejected range")], emptyState());
    expect((message as any).content[0].arguments.content[0].summary).toBe("summary of a rejected range");
  });

  it("never mutates the caller's messages", () => {
    const state = emptyState();
    state.compressToolCallIds.add("call-1");
    const original = callWith("original text");
    applyPersistedRedactions([original], state);
    expect((original as any).content[0].arguments.content[0].summary).toBe("original text");
  });
});
