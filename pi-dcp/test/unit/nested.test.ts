import { describe, expect, it } from "vitest";
import { projectCurrentEntries } from "../helpers/current-host.ts"
import { buildProtocolUnits } from "../../src/identity/protocol.ts";
import type { CanonicalIndex } from "../../src/identity/types.ts";
import { createSnapshot } from "../../src/identity/snapshot.ts";
import { emptyState, reduceEnvelope, type ReducedState } from "../../src/state/reducer.ts";
import { buildCompressionEnvelope, type CompressionBuildOptions } from "../../src/compression/service.ts";
import { createEnvelope, isOperationEnvelope, MAX_NESTED_DEPTH, type CompressionCreated } from "../../src/state/operations.ts";

const model = { provider: "openai", id: "m", api: "openai-completions", contextWindow: 128000 };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (content: unknown[], stopReason: string, timestamp: number) => ({ role: "assistant", content, api: "openai-completions", provider: "openai", model: "m", usage, stopReason, timestamp });

// Three units: m0001 user, m0002 assistant reply, m0003 live user turn.
const plainSession = [
  { role: "user", content: "old", timestamp: 1 },
  assistant([{ type: "text", text: "done" }], "stop", 2),
  { role: "user", content: "latest", timestamp: 3 },
] as any[];

// Four units: m0001 user, m0002 todo tool exchange, m0003 reply, m0004 live user turn.
const todoSession = [
  { role: "user", content: "old work", timestamp: 1 },
  assistant([{ type: "toolCall", id: "todo-1", name: "todo", arguments: {} }], "toolUse", 2),
  { role: "toolResult", toolCallId: "todo-1", toolName: "todo", content: [{ type: "text", text: "TODO: ship merge" }], isError: false, timestamp: 3 },
  assistant([{ type: "text", text: "done" }], "stop", 4),
  { role: "user", content: "latest", timestamp: 5 },
] as any[];

/** A raw session as the compressor sees it, with the leaf the snapshot is taken from. */
interface Session { index: CanonicalIndex; leafId: string }
function session(messages: readonly unknown[]): Session {
  const entries = messages.map((message, index) => ({ type: "message", id: `n${index}`, parentId: index ? `n${index - 1}` : null, timestamp: new Date(index + 1).toISOString(), message }));
  const projection = projectCurrentEntries(entries as any);
  if (!projection.ok) throw new Error("projection");
  const index = buildProtocolUnits(projection.messages);
  if (!("units" in index)) throw new Error("protocol");
  return { index, leafId: `n${messages.length - 1}` };
}

/** Build one compress envelope against `state`, as the tool would on its `generation`-th call. */
function build(raw: Session, state: ReducedState, generation: number, content: { startId: string; endId: string; summary: string }[], extra: Partial<CompressionBuildOptions> = {}) {
  const snapshot = createSnapshot({ sessionId: "s", leafId: raw.leafId, model, generation, ttlMs: 600000, index: raw.index, state, configHash: "c" });
  return buildCompressionEnvelope({ sessionId: "s", extensionVersion: "0.1.0", snapshot, state, params: { topic: "t", content }, model: undefined, toolCallId: `call-${generation}`, ...extra });
}

describe("merging compressed blocks", () => {
  it("stores the authored summary as the merged block and consumes the child", () => {
    const raw = session(plainSession);
    const first = build(raw, emptyState(), 1, [{ startId: "m0001", endId: "m0002", summary: "X: original raw work" }]);
    if (!first.ok) throw new Error(first.reason);
    const state = reduceEnvelope(emptyState(), first.envelope);
    const child = [...state.blocks.values()][0]!;

    const second = build(raw, state, 2, [{ startId: "b0001", endId: "b0001", summary: "Y: higher-level summary" }]);
    if (!second.ok) throw new Error(second.reason);
    // No child text is pasted in: the stored summary is exactly what the model wrote.
    expect(second.blocks[0]).toMatchObject({ summary: "Y: higher-level summary", authoredSummary: "Y: higher-level summary", consumedBlockIds: [child.blockId], nestedDepth: 1 });

    const next = reduceEnvelope(state, second.envelope);
    expect(next.corruptReason).toBeUndefined();
    const active = [...next.blocks.values()].filter((block) => block.active);
    expect(active).toHaveLength(1);
    expect(next.blocks.get(child.blockId)?.active).toBe(false);
    expect(active[0]!.coverage.effectiveEntryIds).toEqual(expect.arrayContaining(child.coverage.effectiveEntryIds));
  });

  it("keeps a model-written (bNNNN) as plain text instead of rejecting the call", () => {
    const raw = session(plainSession);
    const first = build(raw, emptyState(), 1, [{ startId: "m0001", endId: "m0002", summary: "X: original raw work" }]);
    if (!first.ok) throw new Error(first.reason);
    const state = reduceEnvelope(emptyState(), first.envelope);
    const second = build(raw, state, 2, [{ startId: "b0001", endId: "b0001", summary: "(b0001)" }]);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.blocks[0]!.summary).toBe("(b0001)");
  });

  it("computes the correct depth when re-nesting an already-nested block (regression: 2026-08-19 state_conflict)", () => {
    // Compress raw units into X (depth 0), merge X into Y (depth 1), then merge
    // Y into Z (depth 2). Each envelope must pass the reducer on the first try.
    const raw = session(plainSession);
    const build1 = build(raw, emptyState(), 1, [{ startId: "m0001", endId: "m0002", summary: "X: original raw work" }]);
    if (!build1.ok) throw new Error(build1.reason);
    let state = reduceEnvelope(emptyState(), build1.envelope);
    expect(state.corruptReason).toBeUndefined();
    expect([...state.blocks.values()][0]!.nestedDepth).toBe(0);

    const build2 = build(raw, state, 2, [{ startId: "b0001", endId: "b0001", summary: "Y: plus new context" }]);
    if (!build2.ok) throw new Error(build2.reason);
    state = reduceEnvelope(state, build2.envelope);
    expect(state.corruptReason).toBeUndefined();
    expect([...state.blocks.values()].find((block) => block.active)!.nestedDepth).toBe(1);

    const build3 = build(raw, state, 3, [{ startId: "b0001", endId: "b0001", summary: "Z: plus even more context" }]);
    if (!build3.ok) throw new Error(build3.reason);
    state = reduceEnvelope(state, build3.envelope);
    expect(state.corruptReason).toBeUndefined();
    const active = [...state.blocks.values()].filter((block) => block.active);
    expect(active).toHaveLength(1);
    expect(active[0]!.nestedDepth).toBe(2);
  });

  it("carries a merged child's protected output forward once, even when the range spans its raw units", () => {
    const raw = session(todoSession);
    const protection = { cwd: "/", protectedTools: ["todo"], protectedFilePatterns: [] };
    const first = build(raw, emptyState(), 1, [{ startId: "m0001", endId: "m0003", summary: "Phase one." }], { index: raw.index, protection });
    if (!first.ok) throw new Error(first.reason);
    const state = reduceEnvelope(emptyState(), first.envelope);
    expect(first.blocks[0]!.summary).toContain("TODO: ship merge");

    // b0001 spans the child's raw units. They are skipped, so the child's stored
    // section must be the only copy of the todo output.
    const second = build(raw, state, 2, [{ startId: "b0001", endId: "b0001", summary: "Merged." }], { index: raw.index, protection });
    if (!second.ok) throw new Error(second.reason);
    expect(second.blocks[0]!.summary).toBe("Merged.\n\nThe following protected tool output was part of this range and is preserved verbatim:\n### Tool: todo\nTODO: ship merge");
  });

  it("uses a merged child's stored protected output, not the raw tool result, when they differ", () => {
    const raw = session(todoSession);
    const protection = { cwd: "/", protectedTools: ["todo"], protectedFilePatterns: [] };
    const first = build(raw, emptyState(), 1, [{ startId: "m0001", endId: "m0003", summary: "Phase one." }], { index: raw.index, protection });
    if (!first.ok) throw new Error(first.reason);
    const state = reduceEnvelope(emptyState(), first.envelope);
    // Simulates a stored child whose protected text differs from the raw result (for example after a host edit).
    const child = [...state.blocks.values()][0]!;
    child.summary = `${child.authoredSummary}\n\nThe following protected tool output was part of this range and is preserved verbatim:\n### Tool: todo\nTODO: stored text`;

    const second = build(raw, state, 2, [{ startId: "b0001", endId: "b0001", summary: "Merged." }], { index: raw.index, protection });
    if (!second.ok) throw new Error(second.reason);
    expect(second.blocks[0]!.summary).toBe("Merged.\n\nThe following protected tool output was part of this range and is preserved verbatim:\n### Tool: todo\nTODO: stored text");
  });

  it("replays a legacy block whose summary pasted its child text verbatim", () => {
    const raw = session(plainSession);
    const first = build(raw, emptyState(), 1, [{ startId: "m0001", endId: "m0002", summary: "X: original raw work" }]);
    if (!first.ok) throw new Error(first.reason);
    const state = reduceEnvelope(emptyState(), first.envelope);
    const child = [...state.blocks.values()][0]!;
    const operation: CompressionCreated = {
      type: "compression.created", runId: "legacy-run", mode: "range", toolCallId: "legacy-call", snapshotHash: "legacy", model: { provider: "openai", id: "m", api: "openai-completions" },
      blocks: [{ blockId: "legacy-block", ordinal: 0, topic: "legacy", summary: `[DCP nested summary]\n${child.summary}\n\nY: legacy text`, authoredSummary: "Y: legacy text (b0001)", estimatedSummaryTokens: 10, coverage: child.coverage, anchor: {}, consumedBlockIds: [child.blockId], nestedDepth: 1 }],
    };
    const envelope = createEnvelope(operation, "s", "0.1.0", "legacy-request");
    expect(isOperationEnvelope(envelope)).toBe(true);
    const next = reduceEnvelope(state, envelope);
    expect(next.corruptReason).toBeUndefined();
    expect(next.blocks.get("legacy-block")?.active).toBe(true);
    expect(next.blocks.get(child.blockId)?.active).toBe(false);
  });

  it("accepts stored depths up to the limit and rejects one above it", () => {
    const raw = session(plainSession);
    const first = build(raw, emptyState(), 1, [{ startId: "m0001", endId: "m0002", summary: "X" }]);
    if (!first.ok) throw new Error(first.reason);
    const operation = first.envelope.operation as CompressionCreated;
    const withDepth = (nestedDepth: number) => ({ ...first.envelope, operation: { ...operation, blocks: [{ ...operation.blocks[0]!, nestedDepth }] } });
    expect(isOperationEnvelope(withDepth(9))).toBe(true);
    expect(isOperationEnvelope(withDepth(MAX_NESTED_DEPTH))).toBe(true);
    expect(isOperationEnvelope(withDepth(MAX_NESTED_DEPTH + 1))).toBe(false);
  });

  it("refuses a merge that would exceed the depth limit, and accepts one that reaches it", () => {
    const raw = session(plainSession);
    const first = build(raw, emptyState(), 1, [{ startId: "m0001", endId: "m0002", summary: "X" }]);
    if (!first.ok) throw new Error(first.reason);
    const state = reduceEnvelope(emptyState(), first.envelope);
    const child = [...state.blocks.values()][0]!;
    const content = [{ startId: "b0001", endId: "b0001", summary: "Y" }];

    // A child at depth 63 merges into depth 64, the largest depth the validator accepts.
    child.nestedDepth = MAX_NESTED_DEPTH - 1;
    const reaching = build(raw, state, 2, content);
    if (!reaching.ok) throw new Error(reaching.reason);
    expect(reaching.blocks[0]!.nestedDepth).toBe(MAX_NESTED_DEPTH);
    expect(reduceEnvelope(state, reaching.envelope).corruptReason).toBeUndefined();

    // A child at depth 64 would make 65. That must fail here, before anything is persisted.
    child.nestedDepth = MAX_NESTED_DEPTH;
    expect(build(raw, state, 3, content)).toMatchObject({ ok: false, reason: "nesting_limit_exceeded", rangeIndex: 0, limit: MAX_NESTED_DEPTH });
  });
});
