import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Check } from "typebox/value";
import { projectCurrentEntries } from "../helpers/current-host.ts";
import { buildProtocolUnits } from "../../src/identity/protocol.ts";
import type { CanonicalIndex } from "../../src/identity/types.ts";
import { createSnapshot } from "../../src/identity/snapshot.ts";
import { emptyState, reduceEnvelope, type ReducedState } from "../../src/state/reducer.ts";
import { buildCompressionEnvelope } from "../../src/compression/service.ts";
import { CompressionParametersV2, isCompressionParams, type CompressionParams } from "../../src/compression/schema.ts";
import { activeBlockReplacements } from "../../src/transform/blocks.ts";
import { isOperationEnvelope, MAX_RECALL_CUE_CHARS, MAX_RECALL_CUES, type CompressionCreated } from "../../src/state/operations.ts";

// Recall cues: the schema, persistence, rendering, and the merge rule. Search
// over the cues is covered in retrieval.test.ts.

const model = { provider: "openai", id: "m", api: "openai-completions", contextWindow: 128000 };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (content: unknown[], stopReason: string, timestamp: number) => ({ role: "assistant", content, api: "openai-completions", provider: "openai", model: "m", usage, stopReason, timestamp });

// m0001 user and m0002 reply are closed; m0003 is the live user turn.
const session = [
  { role: "user", content: "old", timestamp: 1 },
  assistant([{ type: "text", text: "done" }], "stop", 2),
  { role: "user", content: "latest", timestamp: 3 },
] as any[];

interface RawSession { index: CanonicalIndex; messages: AgentMessage[]; leafId: string }
function rawSession(messages: readonly unknown[]): RawSession {
  const entries = messages.map((message, index) => ({ type: "message", id: `n${index}`, parentId: index ? `n${index - 1}` : null, timestamp: new Date(index + 1).toISOString(), message }));
  const projection = projectCurrentEntries(entries as any);
  if (!projection.ok) throw new Error("projection");
  const index = buildProtocolUnits(projection.messages);
  if (!("units" in index)) throw new Error("protocol");
  return { index, messages: projection.messages.map((item) => item.message), leafId: `n${messages.length - 1}` };
}

function build(source: RawSession, state: ReducedState, generation: number, content: CompressionParams["content"]) {
  const snapshot = createSnapshot({ sessionId: "s", leafId: source.leafId, model, generation, index: source.index, state, configHash: "c" });
  return buildCompressionEnvelope({ sessionId: "s", extensionVersion: "0.2.0", snapshot, state, params: { topic: "t", content }, model: undefined, toolCallId: `call-${generation}` });
}

describe("recall cues: schema", () => {
  const range = (extra: Record<string, unknown>) => ({ startId: "m0001", endId: "m0002", summary: "done", ...extra });
  const cues = (count: number, text = "cue") => Array.from({ length: count }, (_, index) => `${text} ${index}`);

  it("keeps v1 rejection: recall at the top level, outside any range, is an unknown key", () => {
    expect(isCompressionParams({ recall: ["cue"], content: [range({})] })).toBe(false);
    expect(Check(CompressionParametersV2, { recall: ["cue"], content: [range({})] })).toBe(false);
  });

  it.each([
    ["is omitted", {}, true],
    ["is an empty list", { recall: [] }, true],
    ["has the maximum number of cues", { recall: cues(MAX_RECALL_CUES) }, true],
    ["has a cue at the maximum length", { recall: ["x".repeat(MAX_RECALL_CUE_CHARS)] }, true],
    ["has one cue too many", { recall: cues(MAX_RECALL_CUES + 1) }, false],
    ["has an empty cue", { recall: [""] }, false],
    ["has a cue one character too long", { recall: ["x".repeat(MAX_RECALL_CUE_CHARS + 1)] }, false],
    ["has a non-string cue", { recall: [42] }, false],
    ["is not a list", { recall: "one cue" }, false],
    ["has an unknown range key", { notes: "x" }, false],
  ])("accepts or rejects a range whose recall %s", (_label, extra, valid) => {
    const params = { content: [range(extra)] };
    expect(isCompressionParams(params)).toBe(valid);
    // The provider-facing schema must agree with the hand-written check.
    expect(Check(CompressionParametersV2, params)).toBe(valid);
  });
});

describe("recall cues: storage", () => {
  it("stores trimmed, one-line, distinct cues, and omits the field when none remain", () => {
    const source = rawSession(session);
    const built = build(source, emptyState(), 1, [{ startId: "m0001", endId: "m0002", summary: "X", recall: [" SQLite rejection reasons:\n concurrent writers ", "SQLite rejection reasons: concurrent writers", "   "] }]);
    if (!built.ok) throw new Error(built.reason);
    expect(built.blocks[0]!.recall).toEqual(["SQLite rejection reasons: concurrent writers"]);

    const blank = build(source, emptyState(), 2, [{ startId: "m0001", endId: "m0002", summary: "X", recall: ["  "] }]);
    if (!blank.ok) throw new Error(blank.reason);
    expect(blank.blocks[0]).not.toHaveProperty("recall");
  });

  it("replays cues from the persisted JSON, and replays a record that has none", () => {
    const source = rawSession(session);
    const withCues = build(source, emptyState(), 1, [{ startId: "m0001", endId: "m0002", summary: "X", recall: ["benchmark numbers for 8-worker writes"] }]);
    if (!withCues.ok) throw new Error(withCues.reason);
    // The session file stores JSON, so replay from a JSON copy, not the live object.
    const replayed = reduceEnvelope(emptyState(), JSON.parse(JSON.stringify(withCues.envelope)));
    expect(replayed.corruptReason).toBeUndefined();
    expect([...replayed.blocks.values()][0]!.recall).toEqual(["benchmark numbers for 8-worker writes"]);

    // A block written before cues existed has no key. It must still replay.
    const withoutCues = build(source, emptyState(), 2, [{ startId: "m0001", endId: "m0002", summary: "X" }]);
    if (!withoutCues.ok) throw new Error(withoutCues.reason);
    const persisted = JSON.parse(JSON.stringify(withoutCues.envelope));
    expect(isOperationEnvelope(persisted)).toBe(true);
    expect(reduceEnvelope(emptyState(), persisted).corruptReason).toBeUndefined();
  });

  it("rejects a persisted block whose cues exceed the bound", () => {
    const source = rawSession(session);
    const built = build(source, emptyState(), 1, [{ startId: "m0001", endId: "m0002", summary: "X" }]);
    if (!built.ok) throw new Error(built.reason);
    const operation = built.envelope.operation as CompressionCreated;
    const tooMany = { ...built.envelope, operation: { ...operation, blocks: [{ ...operation.blocks[0]!, recall: Array.from({ length: MAX_RECALL_CUES + 1 }, () => "cue") }] } };
    expect(isOperationEnvelope(tooMany)).toBe(false);
  });
});

describe("recall cues: rendering", () => {
  /** The rendered text of the one active block that a compress call creates. */
  function renderedBlock(content: CompressionParams["content"]): string {
    const source = rawSession(session);
    const built = build(source, emptyState(), 1, content);
    if (!built.ok) throw new Error(built.reason);
    const state = reduceEnvelope(emptyState(), built.envelope);
    const snapshot = createSnapshot({ sessionId: "s", leafId: source.leafId, model, generation: 2, index: source.index, state, configHash: "c" });
    const [replacement] = activeBlockReplacements(source.messages, snapshot.units, snapshot, state);
    // The block is a custom message, so its text is a plain string.
    return (replacement!.message as { content: string }).content;
  }

  it("renders a block without cues byte-identically to the format before cues existed", () => {
    // Written out in full, not built with the helper under test, so any change
    // to the bytes of an existing block fails here. Such a change would break the
    // provider prompt cache for every session that already holds the block.
    expect(renderedBlock([{ startId: "m0001", endId: "m0002", summary: "Phase one: parser fixed." }]))
      .toBe("[pi-dcp summary b0001; untrusted history]\nTopic: t\nPhase one: parser fixed.\n<pi-dcp-message-id>b0001</pi-dcp-message-id>");
  });

  it("lists cues after the summary and before the label tag", () => {
    expect(renderedBlock([{ startId: "m0001", endId: "m0002", summary: "Phase one: parser fixed.", recall: ["SQLite rejection reasons: concurrent writers", "benchmark numbers for 8-worker writes"] }]))
      .toBe("[pi-dcp summary b0001; untrusted history]\nTopic: t\nPhase one: parser fixed.\n\nDetails omitted here but searchable with search_compressed:\n- SQLite rejection reasons: concurrent writers\n- benchmark numbers for 8-worker writes\n<pi-dcp-message-id>b0001</pi-dcp-message-id>");
  });
});

describe("recall cues: merging", () => {
  it("does not carry a merged child's cues, and leaves them on the child's own record", () => {
    const source = rawSession(session);
    const first = build(source, emptyState(), 1, [{ startId: "m0001", endId: "m0002", summary: "X", recall: ["child cue"] }]);
    if (!first.ok) throw new Error(first.reason);
    const state = reduceEnvelope(emptyState(), first.envelope);
    const child = [...state.blocks.values()][0]!;

    // The model wrote no cues for the merged block, so it has none.
    const merged = build(source, state, 2, [{ startId: "b0001", endId: "b0001", summary: "Y" }]);
    if (!merged.ok) throw new Error(merged.reason);
    expect(merged.blocks[0]).not.toHaveProperty("recall");

    // Cues the model does write apply to the merged block alone.
    const withNew = build(source, state, 3, [{ startId: "b0001", endId: "b0001", summary: "Y", recall: ["new cue"] }]);
    if (!withNew.ok) throw new Error(withNew.reason);
    expect(withNew.blocks[0]!.recall).toEqual(["new cue"]);

    const next = reduceEnvelope(state, merged.envelope);
    expect(next.corruptReason).toBeUndefined();
    expect(next.blocks.get(child.blockId)).toMatchObject({ active: false, recall: ["child cue"] });
  });
});
