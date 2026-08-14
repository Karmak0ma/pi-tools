import { describe, expect, it } from "vitest";
import { projectContextEntries } from "../../src/identity/project.ts";
import { buildProtocolUnits } from "../../src/identity/protocol.ts";
import { createSnapshot } from "../../src/identity/snapshot.ts";
import { emptyState, reduceEnvelope } from "../../src/state/reducer.ts";
import { buildCompressionEnvelope } from "../../src/compression/service.ts";
import { createEnvelope } from "../../src/state/operations.ts";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const raw = [{ role: "user", content: "old", timestamp: 1 }, { role: "assistant", content: [{ type: "text", text: "done" }], api: "openai-completions", provider: "openai", model: "m", usage, stopReason: "stop", timestamp: 2 }, { role: "user", content: "latest", timestamp: 3 }] as any[];
const entries = raw.map((message, index) => ({ type: "message", id: `n${index}`, parentId: index ? `n${index - 1}` : null, timestamp: new Date(index + 1).toISOString(), message }));

describe("nested blocks", () => {
  it("expands exact b aliases and consumes the child atomically", () => { const projection = projectContextEntries(entries as any); if (!projection.ok) throw new Error("projection"); const index = buildProtocolUnits(projection.messages); if (!("units" in index)) throw new Error("protocol"); const firstSnapshot = createSnapshot({ sessionId: "s", leafId: "n2", model: { provider: "openai", id: "m", api: "openai-completions", contextWindow: 128000 }, generation: 1, ttlMs: 600000, index, state: emptyState(), configHash: "c" }); const first = buildCompressionEnvelope({ sessionId: "s", extensionVersion: "0.1.0", snapshot: firstSnapshot, state: emptyState(), params: { snapshotId: firstSnapshot.snapshotId, topic: "old", content: [{ startId: "m0001", endId: "m0002", summary: "old work" }] }, model: undefined, toolCallId: "c1" }); if (!first.ok) throw new Error(first.reason); const state = reduceEnvelope(emptyState(), first.envelope); const secondSnapshot = createSnapshot({ sessionId: "s", leafId: "n2", model: { provider: "openai", id: "m", api: "openai-completions", contextWindow: 128000 }, generation: 2, ttlMs: 600000, index, state, configHash: "c" }); const second = buildCompressionEnvelope({ sessionId: "s", extensionVersion: "0.1.0", snapshot: secondSnapshot, state, params: { snapshotId: secondSnapshot.snapshotId, topic: "nested", content: [{ startId: "b0001", endId: "b0001", summary: "new context: (b0001)" }] }, model: undefined, toolCallId: "c2" }); if (!second.ok) throw new Error(second.reason); expect(second.ok).toBe(true); if (second.ok) { const next = reduceEnvelope(state, second.envelope); expect(next.blocks.size).toBe(2); expect([...next.blocks.values()].filter((block) => block.active)).toHaveLength(1); expect([...next.blocks.values()].find((block) => block.active)?.consumedBlockIds).toHaveLength(1); } });
});
