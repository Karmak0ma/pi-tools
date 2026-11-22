import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { defaults } from "../../src/config/defaults.ts";
import { loadConfig } from "../../src/config/load.ts";
import { createEnvelope, OPERATION_CUSTOM_TYPE, type CreatedBlock, type OpEnvelope, type PrunedToolDecision } from "../../src/state/operations.ts";
import { emptyState, outgoingPrune, reduceEnvelope, requestLayout } from "../../src/state/reducer.ts";
import { reconstructFromBranch } from "../../src/state/reconstruct.ts";
import { transformOutgoingContext } from "../../src/transform/pipeline.ts";
import { estimatePotentialSavings } from "../../src/transform/semantic-nudge.ts";
import { evaluateSettledStrategies } from "../../src/strategies/settle.ts";
import { collectToolRecords } from "../../src/strategies/deduplicate.ts";
import { buildProtocolUnits } from "../../src/identity/protocol.ts";
import { createSnapshot, unitAlias } from "../../src/identity/snapshot.ts";
import { buildCompressionEnvelope } from "../../src/compression/service.ts";
import { savingsFromOperation } from "../../src/stats.ts";
import { currentHostSessionManager, projectCurrentEntries } from "../helpers/current-host.ts";

/**
 * A pruning decision on raw history must not move the change point of the request
 * earlier than the compression already does. Changing bytes earlier drops the
 * signed thinking of every later assistant turn and misses the prompt cache from
 * that point (see state/reducer.ts, outgoingPrune).
 */

const SESSION = "session-1";
const MODEL = { provider: "test", id: "model", api: "test", contextWindow: 10_000 };
const CONFIG = structuredClone(defaults) as any;
const RAW_A = "A output ".repeat(400);
const RAW_B = "B output ".repeat(400);
const CLEARED = "[Old tool result content cleared by pi-dcp]";
const OLD_INPUT_CLEARED = "[Old tool input cleared by pi-dcp]";

const user = (text: string, timestamp: number): AgentMessage => ({ role: "user", content: text, timestamp } as AgentMessage);
const call = (id: string, path: string, timestamp: number): AgentMessage => ({ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path } }], provider: "test", model: "model", api: "test", stopReason: "toolUse", timestamp } as any);
const result = (toolCallId: string, text: string, timestamp: number): AgentMessage => ({ role: "toolResult", toolCallId, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp } as any);
const reply = (text: string, timestamp: number): AgentMessage => ({ role: "assistant", content: [{ type: "text", text }], provider: "test", model: "model", api: "test", stopReason: "stop", timestamp } as any);

/**
 * Turn one reads a.ts, turn two reads b.ts, and the third (current) turn is open.
 * Protocol units: 0 user, 1 call-a, 2 reply-a, 3 user, 4 call-b, 5 reply-b, 6 user, 7 reply.
 */
function session(): AgentMessage[] {
  return [
    user("first request", 1),
    call("call-a", "src/a.ts", 2), result("call-a", RAW_A, 3), reply("done with a", 4),
    user("second request", 5),
    call("call-b", "src/b.ts", 6), result("call-b", RAW_B, 7), reply("done with b", 8),
    user("third request", 9), reply("working", 10),
  ];
}

/** Turn one reads a.ts; turn two reads it again; the current turn reads x.ts twice. */
function repeatedReads(): AgentMessage[] {
  return [
    user("first request", 1),
    call("call-a1", "src/a.ts", 2), result("call-a1", RAW_A, 3), reply("done with a", 4),
    user("second request", 5),
    call("call-a2", "src/a.ts", 6), result("call-a2", RAW_A, 7), reply("read a again", 8),
    user("third request", 9),
    call("call-x1", "src/x.ts", 10), result("call-x1", RAW_B, 11),
    call("call-x2", "src/x.ts", 12), result("call-x2", RAW_B, 13), reply("working", 14),
  ];
}

function toEntries(messages: AgentMessage[]) {
  return messages.map((message, index) => ({ type: "message", id: `entry-${index + 1}`, parentId: index ? `entry-${index}` : null, timestamp: new Date((index + 1) * 1000).toISOString(), message }));
}

function transform(messages: AgentMessage[], state: ReturnType<typeof emptyState>) {
  const entries = toEntries(messages);
  return transformOutgoingContext(messages, {
    ctx: { cwd: "/tmp", model: MODEL, getContextUsage: () => ({ tokens: null, contextWindow: 10_000 }), sessionManager: currentHostSessionManager(entries, `entry-${messages.length}`) } as any,
    sessionId: SESSION,
    generation: 1,
    state,
    config: CONFIG,
  });
}

function indexOf(messages: AgentMessage[]) {
  const projection = projectCurrentEntries(toEntries(messages));
  if (!projection.ok) throw new Error("projection failed");
  const index = buildProtocolUnits(projection.messages);
  if (!("units" in index)) throw new Error("protocol index failed");
  return index;
}

/** The layout that transform() builds for these messages: the same branch and the same units. */
function layoutOf(messages: AgentMessage[], state: ReturnType<typeof emptyState>) {
  return requestLayout(toEntries(messages), indexOf(messages).units, state);
}

function prune(decisions: PrunedToolDecision[]): OpEnvelope {
  return createEnvelope({ type: "tools.pruned", decisions }, SESSION, "0.2.0");
}

/** A compression.created envelope whose block covers the given raw entries, as compress would store it. */
function compression(runId: string, entryIds: string[], toolCallIds: string[], afterEntryId: string): OpEnvelope {
  const block: CreatedBlock = {
    blockId: `block-${runId}`, ordinal: 0, topic: "earlier work", summary: "Earlier work summary", authoredSummary: "Earlier work summary",
    estimatedSummaryTokens: 10, estimatedSourceTokens: 1_000, estimatedSavingsTokens: 990,
    coverage: { directEntryIds: entryIds, effectiveEntryIds: entryIds, directToolCallIds: toolCallIds, effectiveToolCallIds: toolCallIds },
    anchor: { afterEntryId }, consumedBlockIds: [], nestedDepth: 0,
  };
  return createEnvelope({ type: "compression.created", runId, mode: "range", toolCallId: `compress-${runId}`, snapshotHash: "snapshot", model: { provider: "test", id: "model", api: "test" }, blocks: [block] }, SESSION, "0.2.0");
}
/** Turn one: entries 1-4 and the call on a.ts. */
const TURN_ONE = (runId: string) => compression(runId, ["entry-1", "entry-2", "entry-3", "entry-4"], ["call-a"], "entry-5");

/**
 * Build the compress envelope for a range of units, as the compress tool does. The
 * state supplies earlier blocks, and the branch is the messages' own entries.
 */
function buildRange(state: ReturnType<typeof emptyState>, messages: AgentMessage[], first: number, last: number) {
  const index = indexOf(messages);
  const snapshot = createSnapshot({ sessionId: SESSION, leafId: "entry-10", model: MODEL, generation: 1, ttlMs: 60_000, index, state, branch: toEntries(messages), configHash: "stats" });
  const built = buildCompressionEnvelope({
    sessionId: SESSION, extensionVersion: "0.2.0", snapshot, state, model: undefined, index,
    params: { topic: "range", content: [{ startId: unitAlias(first), endId: unitAlias(last), summary: "short summary" }] },
  });
  if (!built.ok) throw new Error(`compress rejected: ${built.reason}`);
  return built;
}

function branch(envelopes: OpEnvelope[]): any[] {
  return envelopes.map((envelope, index) => ({ type: "custom", id: `op-${index}`, parentId: null, timestamp: new Date(index + 1).toISOString(), customType: OPERATION_CUSTOM_TYPE, data: envelope }));
}

/** Index of the first message that differs between two requests. */
function firstDifference(before: readonly unknown[], after: readonly unknown[]): number {
  let index = 0;
  while (index < Math.min(before.length, after.length) && JSON.stringify(before[index]) === JSON.stringify(after[index])) index++;
  return index;
}

describe("deferred pruning of raw history", () => {
  // old-error-input is legacy: no version creates it now, but stored sessions hold it,
  // and it must wait under the same rule as a live claim.
  it.each(["dedup-output", "old-error-input"] as const)("a %s claim leaves the request byte-identical until the next compression", (kind) => {
    const messages = session();
    const claimed = reduceEnvelope(emptyState(), prune([{ toolCallId: "call-b", kind, estimatedTokens: 900 }]));
    const before = transform(messages, emptyState());
    const pending = transform(messages, claimed);

    expect(JSON.stringify(pending.messages)).toBe(JSON.stringify(before.messages));
    expect(pending.snapshot?.hash).toBe(before.snapshot?.hash);
    expect(outgoingPrune(claimed, "call-b", layoutOf(messages, claimed))).toBeUndefined();
  });

  it("the claim reaches the request in the same one where the next compression first appears", () => {
    const messages = session();
    const claimed = reduceEnvelope(emptyState(), prune([{ toolCallId: "call-b", kind: "dedup-output", estimatedTokens: 900 }]));
    const withoutClaim = transform(messages, reduceEnvelope(emptyState(), TURN_ONE("one")));
    const withClaim = transform(messages, reduceEnvelope(claimed, TURN_ONE("one")));

    // The compression already rewrites turn one, so the only other change is the
    // pruned output of turn two. Everything before that output is unchanged.
    const changed = firstDifference(withoutClaim.messages, withClaim.messages);
    expect(withClaim.messages[changed]).toMatchObject({ role: "toolResult", toolCallId: "call-b" });
    expect(JSON.stringify(withClaim.messages[changed])).toContain(CLEARED);
    expect(JSON.stringify(withoutClaim.messages[changed])).toContain(RAW_B.slice(0, 40));
  });

  it("a claim before the next compression's range start keeps waiting, and the request does not change", () => {
    const messages = session();
    const claimed = reduceEnvelope(emptyState(), prune([{ toolCallId: "call-a", kind: "dedup-output", estimatedTokens: 900 }]));
    // Turn two starts after call-a, so the claim lies before the change point.
    const turnTwo = buildRange(claimed, messages, 3, 5).envelope;
    const withClaim = reduceEnvelope(claimed, turnTwo);
    const withoutClaim = reduceEnvelope(emptyState(), turnTwo);

    expect(JSON.stringify(transform(messages, withClaim).messages)).toBe(JSON.stringify(transform(messages, withoutClaim).messages));
    expect(outgoingPrune(withClaim, "call-a", layoutOf(messages, withClaim))).toBeUndefined();
    expect(JSON.stringify(transform(messages, withClaim).messages)).toContain(RAW_A.slice(0, 40));
  });

  it("a claim inside a later compression's range, or after it, takes effect", () => {
    const messages = session();
    const claim = prune([{ toolCallId: "call-a", kind: "dedup-output", estimatedTokens: 900 }]);
    // The range starts on call-a's own unit, so the claim lies inside it. The block hides it.
    const inside = reduceEnvelope(reduceEnvelope(emptyState(), claim), buildRange(reduceEnvelope(emptyState(), claim), messages, 1, 2).envelope);
    expect(outgoingPrune(inside, "call-a", layoutOf(messages, inside))?.output).toBeDefined();

    // A claim after the range: the range starts at unit 0, before call-b.
    const after = prune([{ toolCallId: "call-b", kind: "dedup-output", estimatedTokens: 900 }]);
    const earlier = reduceEnvelope(reduceEnvelope(emptyState(), after), buildRange(emptyState(), messages, 0, 2).envelope);
    expect(JSON.stringify(transform(messages, earlier).messages)).toContain(CLEARED);
  });

  it("a merged block takes the start of its own range, not the start of the child it consumes", () => {
    const messages = session();
    // The first block is created before the claim, so it does not count for the claim.
    let state = reduceEnvelope(emptyState(), buildRange(emptyState(), messages, 3, 5).envelope);
    state = reduceEnvelope(state, prune([{ toolCallId: "call-a", kind: "dedup-output", estimatedTokens: 900 }]));
    expect(outgoingPrune(state, "call-a", layoutOf(messages, state))).toBeUndefined();

    // The merge starts at unit 2, which is still after call-a.
    state = reduceEnvelope(state, buildRange(state, messages, 2, 5).envelope);
    expect(state.corruptReason).toBeUndefined();
    expect(outgoingPrune(state, "call-a", layoutOf(messages, state))).toBeUndefined();

    // The next merge starts on call-a's own unit, so the claim lies inside the new range.
    state = reduceEnvelope(state, buildRange(state, messages, 1, 5).envelope);
    expect(state.corruptReason).toBeUndefined();
    expect(outgoingPrune(state, "call-a", layoutOf(messages, state))?.output).toBeDefined();
  });

  it("an effective claim keeps its place when the projection loses its first unit", () => {
    const messages = session();
    const claim = prune([{ toolCallId: "call-b", kind: "dedup-output", estimatedTokens: 900 }]);
    const state = reduceEnvelope(reduceEnvelope(emptyState(), claim), buildRange(emptyState(), messages, 0, 2).envelope);
    const entries = toEntries(messages);
    const units = indexOf(messages).units;

    expect(outgoingPrune(state, "call-b", requestLayout(entries, units, state))?.output).toBeDefined();
    // Native compaction can drop projected units, but the branch still holds them,
    // so the claim's place and the block's start do not move.
    expect(outgoingPrune(state, "call-b", requestLayout(entries, units.slice(1), state))?.output).toBeDefined();
  });

  it("replayed entries build the same request as the live state, including claims that wait", () => {
    const messages = session();
    const claim = prune([{ toolCallId: "call-b", kind: "dedup-output", estimatedTokens: 900 }]);
    const compressed = TURN_ONE("one");

    const live = reduceEnvelope(reduceEnvelope(emptyState(), claim), compressed);
    const replayed = reconstructFromBranch(branch([claim, compressed])).state;
    expect(replayed.corruptReason).toBeUndefined();
    expect(JSON.stringify(transform(messages, replayed).messages)).toBe(JSON.stringify(transform(messages, live).messages));

    // Decided after the last compression, so it waits. Live and replayed must agree.
    const liveWaiting = reduceEnvelope(reduceEnvelope(emptyState(), compressed), claim);
    const replayedWaiting = reconstructFromBranch(branch([compressed, claim])).state;
    expect(replayedWaiting.corruptReason).toBeUndefined();
    expect(JSON.stringify(transform(messages, replayedWaiting).messages)).toBe(JSON.stringify(transform(messages, liveWaiting).messages));
    expect(JSON.stringify(transform(messages, replayedWaiting).messages)).toBe(JSON.stringify(transform(messages, reduceEnvelope(emptyState(), compressed)).messages));

    // Recorded before a range that starts after it, so it waits on both paths.
    const earlyClaim = prune([{ toolCallId: "call-a", kind: "dedup-output", estimatedTokens: 900 }]);
    const laterRange = buildRange(emptyState(), messages, 3, 5).envelope;
    const liveStrict = reduceEnvelope(reduceEnvelope(emptyState(), earlyClaim), laterRange);
    const replayedStrict = reconstructFromBranch(branch([earlyClaim, laterRange])).state;
    expect(replayedStrict.corruptReason).toBeUndefined();
    expect(JSON.stringify(transform(messages, replayedStrict).messages)).toBe(JSON.stringify(transform(messages, liveStrict).messages));

    // Ordering is per branch: a branch that never saw the compression cannot activate the claim.
    const forked = reconstructFromBranch(branch([claim])).state;
    expect(outgoingPrune(forked, "call-b", layoutOf(messages, forked))).toBeUndefined();
  });

  it("a rejected compression does not activate pending claims", () => {
    const claimed = reduceEnvelope(emptyState(), prune([{ toolCallId: "call-b", kind: "dedup-output", estimatedTokens: 900 }]));
    // The anchor lies inside the block's own coverage, which the reducer refuses.
    const rejected = reduceEnvelope(claimed, compression("bad", ["entry-1", "entry-2", "entry-3", "entry-4"], ["call-a"], "entry-2"));
    expect(rejected.corruptReason).toBeDefined();
    expect(rejected.blocks.size).toBe(0);
  });

  it("a sweep claim changes the request at once, with no compression", () => {
    const messages = session();
    const swept = reduceEnvelope(emptyState(), prune([{ toolCallId: "call-b", kind: "sweep-output", estimatedTokens: 900 }]));
    const before = transform(messages, emptyState());
    const after = transform(messages, swept);

    expect(JSON.stringify(after.messages)).not.toBe(JSON.stringify(before.messages));
    expect(JSON.stringify(after.messages)).toContain(CLEARED);
  });

  it("a sweep switches on a claim that still waits, and adds no tokens", () => {
    const messages = session();
    const waiting = reduceEnvelope(emptyState(), prune([{ toolCallId: "call-b", kind: "dedup-output", estimatedTokens: 900 }]));
    const swept = reduceEnvelope(waiting, prune([{ toolCallId: "call-b", kind: "sweep-output", estimatedTokens: 0 }]));

    expect(JSON.stringify(transform(messages, swept).messages)).toContain(CLEARED);
    // The output was counted once, when the dedup decided it. The sweep is not a second saving.
    expect(swept.savings.deduplication.tokens).toBe(900);
    expect(swept.savings.sweep).toEqual({ events: 0, tokens: 0 });
  });

  it("counts a token once when a decided pruning lies inside a compressed range", () => {
    const messages = session();
    const state = reduceEnvelope(emptyState(), prune([{ toolCallId: "call-b", kind: "dedup-output", estimatedTokens: 120 }]));
    const built = buildRange(state, messages, 0, 5);

    const [block] = built.blocks;
    expect(block.creditedPruneTokens).toBe(120);
    const reduced = reduceEnvelope(state, built.envelope);
    expect(reduced.corruptReason).toBeUndefined();
    // The decision's 120 tokens plus the compression's remainder add up to the
    // block's whole saving. Neither side counts them a second time.
    expect(reduced.savings.deduplication.tokens + reduced.savings.compression.tokens).toBe(block.estimatedSavingsTokens!);
    expect(savingsFromOperation(built.envelope.operation).compression?.tokens).toBe(block.estimatedSavingsTokens! - 120);
  });

  it("counts a claim outside a later range once, even when a later compression covers it", () => {
    const messages = session();
    const claim = prune([{ toolCallId: "call-a", kind: "dedup-output", estimatedTokens: 120 }]);
    // Turn two does not contain call-a, so this compression credits nothing for it.
    const turnTwo = buildRange(reduceEnvelope(emptyState(), claim), messages, 3, 5);
    let state = reduceEnvelope(reduceEnvelope(emptyState(), claim), turnTwo.envelope);
    expect(state.savings.deduplication.tokens).toBe(120);
    expect(state.savings.compression.tokens).toBe(turnTwo.blocks[0].estimatedSavingsTokens);

    // A later compression covers call-a and subtracts the decided tokens once.
    const all = buildRange(state, messages, 0, 5);
    state = reduceEnvelope(state, all.envelope);
    expect(state.corruptReason).toBeUndefined();
    expect(state.savings.deduplication.tokens + state.savings.compression.tokens).toBe(turnTwo.blocks[0].estimatedSavingsTokens! + all.blocks[0].estimatedSavingsTokens!);
  });

  it("a block that merges a compressed child subtracts only the pruning inside its own units", () => {
    const messages = session();
    let state = reduceEnvelope(emptyState(), prune([
      { toolCallId: "call-a", kind: "dedup-output", estimatedTokens: 50 },
      { toolCallId: "call-b", kind: "dedup-output", estimatedTokens: 120 },
    ]));
    const child = buildRange(state, messages, 0, 2);
    state = reduceEnvelope(state, child.envelope);
    const parent = buildRange(state, messages, 0, 5);
    state = reduceEnvelope(state, parent.envelope);
    expect(state.corruptReason).toBeUndefined();

    const [childBlock] = child.blocks;
    const [parentBlock] = parent.blocks;
    expect(childBlock.creditedPruneTokens).toBe(50);
    expect(parentBlock.consumedBlockIds).toEqual([childBlock.blockId]);
    // call-a sits in the child, which already subtracted it. The parent subtracts only call-b.
    expect(parentBlock.creditedPruneTokens).toBe(120);
    // Together the two blocks save the raw turns minus the final summary, once.
    expect(state.savings.deduplication.tokens + state.savings.compression.tokens).toBe(childBlock.estimatedSavingsTokens! + parentBlock.estimatedSavingsTokens!);
  });

  it("automatic strategies claim neither the current turn nor a tool call that an active block covers", () => {
    const index = indexOf(repeatedReads());
    const settled = { cwd: "/tmp", deduplication: true, protectedTools: [], protectedFilePatterns: [] };

    // call-a1 is an older duplicate in a closed turn. call-x1 is an older duplicate
    // in the current turn, which automatic strategies leave alone.
    expect(evaluateSettledStrategies(index, emptyState(), settled).map((decision) => decision.toolCallId)).toEqual(["call-a1"]);
    const covered = reduceEnvelope(emptyState(), compression("one", ["entry-1", "entry-2", "entry-3", "entry-4"], ["call-a1"], "entry-5"));
    expect(evaluateSettledStrategies(index, covered, settled)).toEqual([]);
  });

  it("a config file that disables deduplication loads, and the same transcript then gets no duplicate-read claim", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dcp-dedup-config-"));
    try {
      await writeFile(join(dir, "dcp.json"), JSON.stringify({ strategies: { deduplication: { enabled: false } } }));
      // The project path does not exist and is untrusted, so only the global file is read.
      const loaded = await loadConfig(join(dir, "project"), false, { PI_CODING_AGENT_DIR: dir });
      expect(loaded.error).toBeUndefined();
      const index = indexOf(repeatedReads());
      // lifecycle.ts passes these two fields to evaluateSettledStrategies. The defaults claim
      // call-a1 on this transcript, so the empty result below is caused by the file.
      const claimsWith = (config: typeof CONFIG) => evaluateSettledStrategies(index, emptyState(), { cwd: "/tmp", deduplication: config.strategies.deduplication.enabled, protectedTools: [...config.strategies.deduplication.protectedTools], protectedFilePatterns: [] }).map((decision) => decision.toolCallId);
      expect(claimsWith(CONFIG)).toEqual(["call-a1"]);
      expect(claimsWith(loaded.config)).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("automatic strategies no longer record old-error-input, even for a failed call many turns old", () => {
    // Under the removed default (four user turns) this failed call would have been claimed.
    const messages: AgentMessage[] = [
      user("first request", 1),
      call("call-err", "src/missing.ts", 2), { ...result("call-err", "ENOENT", 3), isError: true } as AgentMessage, reply("failed", 4),
      user("second request", 5), reply("two", 6),
      user("third request", 7), reply("three", 8),
      user("fourth request", 9), reply("four", 10),
      user("fifth request", 11), reply("five", 12),
      user("current request", 13), reply("working", 14),
    ];
    const index = indexOf(messages);
    // The precondition: the index does see the failed call, so the empty result is not vacuous.
    expect(collectToolRecords(index).find((record) => record.toolCallId === "call-err")?.result?.isError).toBe(true);
    const settled = { cwd: "/tmp", deduplication: true, protectedTools: [], protectedFilePatterns: [] };
    expect(evaluateSettledStrategies(index, emptyState(), settled)).toEqual([]);
  });

  it("a stored old-error-input claim applies only once a compression starts at or before its call", () => {
    const messages = session();
    // call-a sits before the range that starts at unit 3, so its claim keeps waiting.
    const waiting = reduceEnvelope(reduceEnvelope(emptyState(), prune([{ toolCallId: "call-a", kind: "old-error-input", estimatedTokens: 81 }])), buildRange(emptyState(), messages, 3, 5).envelope);
    expect(JSON.stringify(transform(messages, waiting).messages)).toContain('"path":"src/a.ts"');
    expect(JSON.stringify(transform(messages, waiting).messages)).not.toContain(OLD_INPUT_CLEARED);

    // call-b lies after the start of a compression at unit 0, so its claim applies. The
    // call stays visible because the range ends before it.
    const legacyClaim = prune([{ toolCallId: "call-b", kind: "old-error-input", estimatedTokens: 81 }]);
    const turnOne = buildRange(emptyState(), messages, 0, 2).envelope;
    const applied = reduceEnvelope(reduceEnvelope(emptyState(), legacyClaim), turnOne);
    expect(JSON.stringify(transform(messages, applied).messages)).toContain(OLD_INPUT_CLEARED);
    expect(JSON.stringify(transform(messages, applied).messages)).not.toContain('"path":"src/b.ts"');

    // A session that stores the legacy claim replays to the same request.
    const replayed = reconstructFromBranch(branch([legacyClaim, turnOne])).state;
    expect(replayed.corruptReason).toBeUndefined();
    expect(JSON.stringify(transform(messages, replayed).messages)).toBe(JSON.stringify(transform(messages, applied).messages));
  });

  it("a pending claim is not counted as already saved by the nudge estimate", () => {
    const messages = session();
    const index = indexOf(messages);
    const potential = (state: ReturnType<typeof emptyState>) => estimatePotentialSavings(index, state, CONFIG, "/tmp", layoutOf(messages, state));
    const pending = reduceEnvelope(emptyState(), prune([{ toolCallId: "call-b", kind: "dedup-output", estimatedTokens: 900 }]));
    expect(potential(pending)).toEqual(potential(emptyState()));

    // Once a compression makes the claim effective, its bytes leave the source estimate.
    const effective = reduceEnvelope(reduceEnvelope(emptyState(), prune([{ toolCallId: "call-b", kind: "dedup-output", estimatedTokens: 900 }])), TURN_ONE("one"));
    const stillPending = reduceEnvelope(reduceEnvelope(emptyState(), TURN_ONE("one")), prune([{ toolCallId: "call-b", kind: "dedup-output", estimatedTokens: 900 }]));
    expect(potential(effective).sourceTokens).toBeLessThan(potential(stillPending).sourceTokens);
  });
});
