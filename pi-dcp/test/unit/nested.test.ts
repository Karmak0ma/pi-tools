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
  it("expands exact b aliases and consumes the child atomically", () => { const projection = projectContextEntries(entries as any); if (!projection.ok) throw new Error("projection"); const index = buildProtocolUnits(projection.messages); if (!("units" in index)) throw new Error("protocol"); const firstSnapshot = createSnapshot({ sessionId: "s", leafId: "n2", model: { provider: "openai", id: "m", api: "openai-completions", contextWindow: 128000 }, generation: 1, ttlMs: 600000, index, state: emptyState(), configHash: "c" }); const first = buildCompressionEnvelope({ sessionId: "s", extensionVersion: "0.1.0", snapshot: firstSnapshot, state: emptyState(), params: { topic: "old", content: [{ startId: "m0001", endId: "m0002", summary: "old work" }] }, model: undefined, toolCallId: "c1" }); if (!first.ok) throw new Error(first.reason); const state = reduceEnvelope(emptyState(), first.envelope); const secondSnapshot = createSnapshot({ sessionId: "s", leafId: "n2", model: { provider: "openai", id: "m", api: "openai-completions", contextWindow: 128000 }, generation: 2, ttlMs: 600000, index, state, configHash: "c" }); const second = buildCompressionEnvelope({ sessionId: "s", extensionVersion: "0.1.0", snapshot: secondSnapshot, state, params: { topic: "nested", content: [{ startId: "b0001", endId: "b0001", summary: "new context: (b0001)" }] }, model: undefined, toolCallId: "c2" }); if (!second.ok) throw new Error(second.reason); expect(second.ok).toBe(true); if (second.ok) { const next = reduceEnvelope(state, second.envelope); expect(next.blocks.size).toBe(2); expect([...next.blocks.values()].filter((block) => block.active)).toHaveLength(1); expect([...next.blocks.values()].find((block) => block.active)?.consumedBlockIds).toHaveLength(1); } });

  it("computes the correct depth when re-nesting an already-nested block (regression: 2026-08-19 state_conflict)", () => {
    // Reproduces the incident chain exactly: compress raw units into X
    // (depth 0), compress X into Y (depth 1, succeeds), then compress Y into
    // Z (must be depth 2). Before the nesting.ts fix, Z's computed depth
    // collapsed to 1 (nested.depth can never see past one already-flattened
    // hop), which the reducer's `nestedDepth` invariant then rejected -
    // after the envelope was already persisted. This chain must now build
    // an envelope the reducer accepts on the first attempt.
    const projection = projectContextEntries(entries as any); if (!projection.ok) throw new Error("projection");
    const index = buildProtocolUnits(projection.messages); if (!("units" in index)) throw new Error("protocol");
    const model = { provider: "openai", id: "m", api: "openai-completions", contextWindow: 128000 };

    const snapshot1 = createSnapshot({ sessionId: "s", leafId: "n2", model, generation: 1, ttlMs: 600000, index, state: emptyState(), configHash: "c" });
    const build1 = buildCompressionEnvelope({ sessionId: "s", extensionVersion: "0.1.0", snapshot: snapshot1, state: emptyState(), params: { topic: "x", content: [{ startId: "m0001", endId: "m0002", summary: "X: original raw work" }] }, model: undefined, toolCallId: "c1" });
    if (!build1.ok) throw new Error(build1.reason);
    let state = reduceEnvelope(emptyState(), build1.envelope);
    expect(state.corruptReason).toBeUndefined();
    const blockX = [...state.blocks.values()][0];
    expect(blockX.nestedDepth).toBe(0);

    const snapshot2 = createSnapshot({ sessionId: "s", leafId: "n2", model, generation: 2, ttlMs: 600000, index, state, configHash: "c" });
    const build2 = buildCompressionEnvelope({ sessionId: "s", extensionVersion: "0.1.0", snapshot: snapshot2, state, params: { topic: "y", content: [{ startId: "b0001", endId: "b0001", summary: "Y: (b0001) plus new context" }] }, model: undefined, toolCallId: "c2" });
    if (!build2.ok) throw new Error(build2.reason);
    state = reduceEnvelope(state, build2.envelope);
    expect(state.corruptReason).toBeUndefined();
    const blockY = [...state.blocks.values()].find((block) => block.active)!;
    expect(blockY.nestedDepth).toBe(1);

    const snapshot3 = createSnapshot({ sessionId: "s", leafId: "n2", model, generation: 3, ttlMs: 600000, index, state, configHash: "c" });
    const build3 = buildCompressionEnvelope({ sessionId: "s", extensionVersion: "0.1.0", snapshot: snapshot3, state, params: { topic: "z", content: [{ startId: "b0001", endId: "b0001", summary: "Z: (b0001) plus even more context" }] }, model: undefined, toolCallId: "c3" });
    if (!build3.ok) throw new Error(build3.reason);
    state = reduceEnvelope(state, build3.envelope);
    expect(state.corruptReason).toBeUndefined();
    const blockZ = [...state.blocks.values()].find((block) => block.active)!;
    expect(blockZ.nestedDepth).toBe(2);
    expect([...state.blocks.values()].filter((block) => block.active)).toHaveLength(1);
  });

  it("reports the range and required alias when a nested placeholder is missing", () => { const projection = projectContextEntries(entries as any); if (!projection.ok) throw new Error("projection"); const index = buildProtocolUnits(projection.messages); if (!("units" in index)) throw new Error("protocol"); const firstSnapshot = createSnapshot({ sessionId: "s", leafId: "n2", model: { provider: "openai", id: "m", api: "openai-completions", contextWindow: 128000 }, generation: 1, ttlMs: 600000, index, state: emptyState(), configHash: "c" }); const first = buildCompressionEnvelope({ sessionId: "s", extensionVersion: "0.1.0", snapshot: firstSnapshot, state: emptyState(), params: { topic: "old", content: [{ startId: "m0001", endId: "m0002", summary: "old work" }] }, model: undefined, toolCallId: "c1" }); if (!first.ok) throw new Error(first.reason); const state = reduceEnvelope(emptyState(), first.envelope); const secondSnapshot = createSnapshot({ sessionId: "s", leafId: "n2", model: { provider: "openai", id: "m", api: "openai-completions", contextWindow: 128000 }, generation: 2, ttlMs: 600000, index, state, configHash: "c" }); const second = buildCompressionEnvelope({ sessionId: "s", extensionVersion: "0.1.0", snapshot: secondSnapshot, state, params: { topic: "nested", content: [{ startId: "m0001", endId: "m0002", summary: "new context" }] }, model: undefined, toolCallId: "c2" }); expect(second).toMatchObject({ ok: false, reason: "placeholder_invalid", rangeIndex: 0, hint: expect.stringContaining("(b0001)") }); if (!second.ok) expect(second.hint).toContain("m0001-m0002"); });
});
