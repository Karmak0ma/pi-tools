import { describe, expect, it } from "vitest";
import { defaults } from "../../src/config/defaults.ts";
import { emptyState, reduceEnvelope, type ReducedState } from "../../src/state/reducer.ts";
import { transformOutgoingContext } from "../../src/transform/pipeline.ts";
import { buildCompressionEnvelope } from "../../src/compression/service.ts";
import { buildErrorText } from "../../src/compression/errors.ts";
import { createRuntime, publishBaseline, type DcpRuntime } from "../../src/runtime.ts";
import { currentHostSessionManager } from "../helpers/current-host.ts";

// The compress error text ends with the ranges the model may name right now.
// These tests pin that list against the request the model actually receives:
// every advertised range must be accepted by the tool, and every label in it
// must be visible in that request. A block hides the mNNNN units inside its span.

type Shape = "user" | "reply" | "system";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** Plain history. `system` is a BLOCKED unit, so it splits every run around it. */
function session(shapes: readonly Shape[]): any[] {
  return shapes.map((shape, index) => {
    const text = `${shape} ${index}`;
    if (shape === "reply") return { role: "assistant", content: [{ type: "text", text }], api: "test", provider: "test", model: "m", usage, stopReason: "stop", timestamp: index + 1 };
    return { role: shape, content: text, timestamp: index + 1 };
  });
}

/**
 * Publish the request that the context transform shows for `messages` under
 * `state`, and the runtime a rejected compress call reads. The request's
 * labels and the advertised ranges come from this one publication.
 */
function publish(messages: any[], state: ReducedState, protectUserMessages = false) {
  const entries = messages.map((message, index) => ({ type: "message", id: `entry-${index + 1}`, parentId: index ? `entry-${index}` : null, timestamp: new Date(index + 1).toISOString(), message }));
  const ctx = { cwd: "/tmp", model: { provider: "test", id: "model", api: "test", contextWindow: 10_000 }, getContextUsage: () => ({ tokens: null, contextWindow: 10_000 }), sessionManager: currentHostSessionManager(entries, `entry-${messages.length}`) } as any;
  const result = transformOutgoingContext(messages, { ctx, sessionId: "s", generation: 1, state, config: structuredClone(defaults) as any });
  if (!result.snapshot) throw new Error(`no snapshot: ${result.reason}`);
  const runtime: DcpRuntime = createRuntime();
  publishBaseline(runtime, result.snapshot);
  runtime.reduced = state;
  runtime.config.compress.protectUserMessages = protectUserMessages;
  runtime.lastReadiness = { ready: true, generation: 1 };
  return { snapshot: result.snapshot, messages: result.messages, runtime };
}

let callCount = 0;
/** One compress call, with each range given its own one-line summary. */
function compressCall(ranges: readonly string[], snapshot: ReturnType<typeof publish>["snapshot"], state: ReducedState, extra: { protectUserMessages?: boolean } = {}) {
  const content = ranges.map((range) => {
    const [startId, endId = startId] = range.split("-");
    return { startId: startId!, endId: endId!, summary: `summary of ${range}` };
  });
  return buildCompressionEnvelope({ sessionId: "s", extensionVersion: "t", snapshot, state, params: { topic: "t", content }, model: undefined, toolCallId: `call-${callCount++}`, ...extra });
}

/** Store the given ranges as blocks, the way an accepted compress call would. */
function compress(messages: any[], state: ReducedState, ranges: readonly string[]): ReducedState {
  const { snapshot } = publish(messages, state);
  const built = compressCall(ranges, snapshot, state);
  if (!built.ok) throw new Error(`compress failed: ${built.reason} ${built.id ?? ""}`);
  return reduceEnvelope(state, built.envelope);
}

/** The ranges the inventory advertises: parsed from the error text a rejected call receives. */
function advertised(runtime: DcpRuntime): string[] {
  const text = buildErrorText(runtime, "range_invalid", { id: "m9999", rangeIndex: 0 });
  const prefix = "Compressible ranges right now: ";
  const line = text.split("\n").find((item) => item.startsWith(prefix));
  if (!line) throw new Error(`no inventory line in: ${text}`);
  const list = line.slice(prefix.length).replace(/\.$/, "");
  return list === "none" ? [] : list.split(", ");
}

/** Every label the request shows, from the inline <pi-dcp-message-id> tags. */
function shownLabels(messages: readonly unknown[]): Set<string> {
  return new Set([...JSON.stringify(messages).matchAll(/<pi-dcp-message-id>([^<]+)<\/pi-dcp-message-id>/g)].map((match) => match[1]!));
}

describe("compress inventory", () => {
  it("starts a run inside a block with the block's alias, and never names the units hidden in it", () => {
    // b0001 covers m0001-m0002. The run starts there, so the alias must stand for m0001.
    // The one-block run after the wall (b0002) is omitted.
    const messages = session(["user", "reply", "user", "reply", "system", "user", "reply", "user"]);
    const state = compress(messages, emptyState(), ["m0001-m0002", "m0006-m0007"]);
    expect(advertised(publish(messages, state).runtime)).toEqual(["b0001-m0004"]);
  });

  it("ends a run inside a block with the block's alias", () => {
    // b0001 covers m0003-m0004, so the run that ends at it must end with b0001.
    const messages = session(["user", "reply", "user", "reply", "system", "user", "reply", "user"]);
    const state = compress(messages, emptyState(), ["m0003-m0004"]);
    expect(advertised(publish(messages, state).runtime)).toEqual(["m0001-b0001", "m0006-m0007"]);
  });

  it("omits a run that is one block alone, and shows two adjacent blocks as bA-bB", () => {
    // b0001 sits alone between two walls, so it is omitted: a range of it alone is refused.
    // b0002 and b0003 touch, so they form one run that the model can name as b0002-b0003.
    const messages = session(["user", "system", "user", "reply", "system", "user", "reply", "user", "reply", "user"]);
    const state = compress(messages, emptyState(), ["m0003-m0004", "m0006-m0007", "m0008-m0009"]);
    expect(advertised(publish(messages, state).runtime)).toEqual(["m0001", "b0002-b0003"]);
  });

  it("says none when the only run left is one block", () => {
    const messages = session(["user", "reply", "user"]);
    const state = compress(messages, emptyState(), ["m0001-m0002"]);
    const { runtime } = publish(messages, state);
    expect(advertised(runtime)).toEqual([]);
    expect(buildErrorText(runtime, "range_invalid", { id: "m9999", rangeIndex: 0 })).toContain("Compressible ranges right now: none.");
  });

  it("does not offer a block that holds a unit protected by the current rules, and refuses a range that includes it", () => {
    // The block was made before protectUserMessages was on. Its user unit is now
    // protected, so the block is not offered, and a range that includes it is refused.
    const messages = session(["user", "reply", "user", "reply", "user"]);
    const state = compress(messages, emptyState(), ["m0002-m0003"]);
    const protectedWorld = publish(messages, state, true);
    expect(advertised(protectedWorld.runtime)).toEqual(["m0004"]);
    expect(compressCall(["b0001-m0004"], protectedWorld.snapshot, state, { protectUserMessages: true })).toMatchObject({ ok: false, reason: "content_protected" });
  });

  it("never offers a block the request does not show, and does not name the units inside it", () => {
    // The request was published before the block existed, so it shows no bNNNN.
    // The tool validates against the newer state, which does hold the block: any
    // range that reached its units would fail with block_partial. The inventory
    // must therefore leave those units out, as it would for a shown block.
    const messages = session(["user", "reply", "user", "reply", "user"]);
    const state = compress(messages, emptyState(), ["m0001-m0002"]);
    const world = publish(messages, emptyState());
    world.runtime.reduced = state;
    expect(advertised(world.runtime)).toEqual(["m0003-m0004"]);
  });

  it("uses the same runs for the split suggestions of a rejected range as for the inventory", () => {
    const state = fixedSessionState();
    const { snapshot, runtime } = publish(FIXED_SESSION, state);
    const result = compressCall(["b0001-m0013"], snapshot, state);
    if (result.ok) throw new Error("expected content_protected: the request includes the live turn and BLOCKED units");
    expect(result.splits).toEqual([{ rangeIndex: 0, requested: "b0001-m0013", segments: advertised(runtime), blockBounded: true }]);
  });

  it("splits a rejected sub-range at its walls, with the blocks at its edges kept as blocks", () => {
    // The range starts on block b0002 and ends at the wall m0008. Both blocks lie
    // wholly inside the range, so they stay blocks. b0001 lies outside it.
    const state = fixedSessionState();
    const { snapshot } = publish(FIXED_SESSION, state);
    const result = compressCall(["b0002-m0008"], snapshot, state);
    expect(result).toMatchObject({ ok: false, reason: "content_protected" });
    if (result.ok) throw new Error("unreachable");
    expect(result.splits).toEqual([{ rangeIndex: 0, requested: "b0002-m0008", segments: ["b0002-b0003"], blockBounded: true }]);
  });

  it("advertises exactly the expected ranges for a session with several blocks, a nested merge and walls", () => {
    expect(advertised(publish(FIXED_SESSION, fixedSessionState()).runtime)).toEqual(["b0002-b0003", "b0004-m0012"]);
  });

  it("advertises only ranges the tool accepts, and only labels the request shows, for random sessions", () => {
    // Sessions and blocks come from a fixed seed, so a failure reproduces exactly.
    // Blocks are whatever the tool accepts on each attempt, so the sessions hold
    // real, mixed block shapes. Every message has visible text, so every unit gets
    // an inline label. A unit with no label would be advertised but never seen.
    let blocks = 0;
    let checked = 0;
    for (let seed = 1; seed <= 25; seed++) {
      const random = prng(seed);
      const messages = session(randomShapes(random));
      let state = emptyState();
      for (let attempt = 0; attempt < 12; attempt++) {
        const { snapshot } = publish(messages, state);
        const labels = [...snapshot.unitAliases.keys(), ...snapshot.blockAliases.keys()];
        const pick = () => labels[Math.floor(random() * labels.length)]!;
        const built = compressCall([`${pick()}-${pick()}`], snapshot, state);
        if (!built.ok) continue;
        state = reduceEnvelope(state, built.envelope);
        expect(state.corruptReason, `seed ${seed}`).toBeUndefined();
        blocks++;
      }

      const world = publish(messages, state);
      const ranges = advertised(world.runtime);
      checked += ranges.length;
      for (const range of ranges) {
        const result = compressCall([range], world.snapshot, state);
        expect(result.ok ? "ok" : result.reason, `seed ${seed}: ${range}`).toBe("ok");
      }
      if (ranges.length) {
        const together = compressCall(ranges, world.snapshot, state);
        expect(together.ok ? "ok" : together.reason, `seed ${seed}: all ranges together`).toBe("ok");
      }
      const shown = shownLabels(world.messages);
      for (const label of ranges.flatMap((range) => range.split("-"))) expect(shown.has(label), `seed ${seed}: ${label} is not shown`).toBe(true);
    }
    // The loop must have exercised both blocks and advertised ranges, or it proves nothing.
    expect(blocks).toBeGreaterThan(0);
    expect(checked).toBeGreaterThan(0);
  });
});

/** Walls between runs, several blocks, a nested merge, and a live last turn in one session. */
const FIXED_SESSION = session(["user", "reply", "system", "user", "reply", "user", "reply", "system", "user", "reply", "user", "reply", "user"]);

/** Blocks m0001-m0002, m0004-m0005, m0006-m0007 and m0009-m0010, then one nested merge of the last with m0011. */
function fixedSessionState(): ReducedState {
  const first = compress(FIXED_SESSION, emptyState(), ["m0001-m0002", "m0004-m0005", "m0006-m0007", "m0009-m0010"]);
  return compress(FIXED_SESSION, first, ["b0004-m0011"]);
}

/** Small deterministic generator, so every seed reproduces the same session. */
function prng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** Random history of 5 to 14 units. The last unit is a user turn, which is always live. */
function randomShapes(random: () => number): Shape[] {
  const length = 5 + Math.floor(random() * 10);
  const shapes: Shape[] = Array.from({ length: length - 1 }, (): Shape => {
    const roll = random();
    return roll < 0.2 ? "system" : roll < 0.6 ? "user" : "reply";
  });
  return [...shapes, "user"];
}
