import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { defaults } from "../../src/config/defaults.ts";
import { emptyState } from "../../src/state/reducer.ts";
import { joinProjectedMessages } from "../../src/identity/join.ts";
import { projectContextEntries } from "../../src/identity/project.ts";
import { transformOutgoingContext } from "../../src/transform/pipeline.ts";

function setup(messages: AgentMessage[]) {
  const entries = messages.map((message, index) => ({ type: "message", id: `entry-${index + 1}`, parentId: index ? `entry-${index}` : null, timestamp: new Date(index + 1).toISOString(), message }));
  return { entries, ctx: { cwd: "/tmp", model: { provider: "test", id: "model", api: "test", contextWindow: 10_000 }, getContextUsage: () => ({ tokens: null, contextWindow: 10_000 }), sessionManager: { buildContextEntries: () => entries, getLeafId: () => `entry-${entries.length}` } } as any };
}

describe("tolerant projected-message joins", () => {
  it("passes injected extras through unchanged and labels expected messages", () => {
    const canonical: AgentMessage[] = [
      { role: "user", content: "first", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "done" }], provider: "test", model: "model", api: "test", stopReason: "stop", timestamp: 2 } as any,
      { role: "user", content: "latest", timestamp: 3 },
    ];
    const { ctx } = setup(canonical);
    const extra = { role: "custom", customType: "other-extension", content: "untouched", display: false, timestamp: 0 } as AgentMessage;
    const result = transformOutgoingContext([extra, canonical[0], canonical[1], canonical[2]], { ctx, sessionId: "s", generation: 1, state: emptyState(), config: structuredClone(defaults) as any });
    expect(result.snapshot).toBeDefined();
    expect(result.messages[0]).toEqual(extra);
    expect(result.messages.slice(1).every((message) => JSON.stringify(message).includes("pi-dcp-message-id"))).toBe(true);
  });

  it("joins duplicate-content messages unambiguously by position (identical content, so any pairing is equivalent)", () => {
    // Real sessions routinely contain byte-identical messages (repeated "yes",
    // an identical prompt run twice, ...). Duplicate fingerprints do not by
    // themselves make the join ambiguous: the strictly-increasing search
    // below still finds exactly one order-preserving solution, and since the
    // messages are content-identical, that solution is correct regardless of
    // which physical twin is paired with which.
    const messages: AgentMessage[] = [
      { role: "user", content: "same", timestamp: 1 },
      { role: "user", content: "same", timestamp: 1 },
    ];
    const projection = projectContextEntries(setup(messages).entries as any);
    expect(projection.ok).toBe(true);
    if (projection.ok) expect(joinProjectedMessages(projection.messages, messages)).toEqual({ ok: true, incomingByExpected: [0, 1] });
  });

  it("still fails closed when a duplicate-fingerprint extra creates genuine ambiguity", () => {
    // Two expected duplicates but three matching incoming candidates: more
    // than one strictly-increasing pairing exists, so this is genuinely
    // ambiguous and must still fail closed.
    const canonical: AgentMessage[] = [
      { role: "user", content: "same", timestamp: 1 },
      { role: "user", content: "same", timestamp: 1 },
    ];
    const projection = projectContextEntries(setup(canonical).entries as any);
    expect(projection.ok).toBe(true);
    const extraDuplicate = { role: "user", content: "same", timestamp: 1 } as AgentMessage;
    const incoming = [canonical[0], extraDuplicate, canonical[1]];
    if (projection.ok) expect(joinProjectedMessages(projection.messages, incoming)).toEqual({ ok: false, reason: "join_ambiguous" });
  });
});
