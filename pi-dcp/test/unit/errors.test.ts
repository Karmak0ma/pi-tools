import { describe, expect, it } from "vitest";
import { defaults } from "../../src/config/defaults.ts";
import { emptyState } from "../../src/state/reducer.ts";
import { transformOutgoingContext } from "../../src/transform/pipeline.ts";
import { buildErrorText } from "../../src/compression/errors.ts";
import { createRuntime, publishBaseline } from "../../src/runtime.ts";
import { currentHostSessionManager } from "../helpers/current-host.ts";

describe("actionable compression errors", () => {
  const setup = () => {
    const messages = [{ role: "user", content: "old", timestamp: 1 }, { role: "user", content: "current", timestamp: 2 }] as any[];
    const entries = messages.map((message, index) => ({ type: "message", id: `entry-${index + 1}`, parentId: index ? `entry-${index}` : null, timestamp: new Date(index + 1).toISOString(), message }));
    const ctx = { cwd: "/tmp", model: { provider: "test", id: "model", api: "test", contextWindow: 10_000 }, getContextUsage: () => ({ tokens: null, contextWindow: 10_000 }), sessionManager: currentHostSessionManager(entries, "entry-2") } as any;
    const result = transformOutgoingContext(messages, { ctx, sessionId: "s", generation: 1, state: emptyState(), config: structuredClone(defaults) as any });
    const runtime = createRuntime();
    publishBaseline(runtime, result.snapshot!);
    runtime.lastReadiness = { ready: true, generation: 1 };
    return runtime;
  };

  it("names invalid ranges and the currently valid inventory", () => {
    const text = buildErrorText(setup(), "range_invalid", { id: "m0227", rangeIndex: 0 });
    expect(text).toContain('"m0227"');
    // m0002 ("current") is the live user turn, excluded from the
    // compressible inventory even though it has a valid alias.
    expect(text).toContain("Compressible labels right now: m0001.");
    expect(text).toContain("Re-issue compress");
  });

  it("explains the nesting limit and says not to merge the range", () => {
    const text = buildErrorText(setup(), "nesting_limit_exceeded", { rangeIndex: 0 });
    expect(text).toContain("nested deeper than 64 levels");
    expect(text).toContain("Do not merge this range");
  });

  it("says the walls lie between blocks when a rejected range starts or ends on a block", () => {
    const split = { rangeIndex: 0, requested: "b0001-m0005", segments: ["m0004-m0005"], blockBounded: true };
    const bounded = buildErrorText(setup(), "content_protected", { blocked: [{ id: "m0003", rangeIndex: 0, cause: "protected_message" }], splits: [split] });
    expect(bounded).toContain("The BLOCKED units lie between the selected blocks; they are visible in context, not inside blocks.");
    expect(bounded).toContain("Blocks on different sides of a wall cannot be merged into one range.");
    expect(bounded).toContain("range 0 (b0001-m0005) -> m0004-m0005");

    // A range of labels only has no such line, so the message stays as short as before.
    const plain = buildErrorText(setup(), "content_protected", { blocked: [{ id: "m0003", rangeIndex: 0, cause: "protected_message" }], splits: [{ ...split, requested: "m0001-m0005", blockBounded: false }] });
    expect(plain).not.toContain("lie between the selected blocks");
  });

  it("says a split with nothing left to merge should be removed and its blocks left alone", () => {
    const text = buildErrorText(setup(), "content_protected", { blocked: [{ id: "m0003", rangeIndex: 0, cause: "protected_message" }], splits: [{ rangeIndex: 0, requested: "b0001-m0005", segments: [], blockBounded: true }] });
    expect(text).toContain("no mergeable segment; remove this range and leave its blocks unchanged");
    // No replacement is offered, so the "Retry now" sentence would be false.
    expect(text).toContain("No rejected range can be split into a mergeable range.");
    expect(text).not.toContain("Retry now");
  });

  it("refuses a single-block rewrite and says to merge the block or leave it", () => {
    const text = buildErrorText(setup(), "single_block_rewrite", { rangeIndex: 0, id: "b0001" });
    expect(text).toContain("Range 0 would rewrite block b0001 alone. Nothing was compressed.");
    expect(text).toContain("Do not rewrite block b0001 alone. Merge it with neighbouring blocks or raw units in one range, or leave it unchanged.");
  });

  it.each([
    ["compression_unavailable", "No aliases were published"],
    ["baseline_unavailable", "No baseline could be recovered"],
    ["range_overlap", "overlaps an earlier range"],
    ["block_partial", "Select the whole block"],
    ["content_protected", "is protected"],
    ["summary_invalid", "Fix the summary"],
    ["permission_denied", "Compression permission"],
  ] as const)("explains %s", (reason, expected) => {
    const runtime = setup();
    const text = buildErrorText(runtime, reason, { stage: reason === "compression_unavailable" ? "join_ambiguous" : undefined, rangeIndex: 1, id: "m0001" });
    expect(text).toContain(expected);
  });
});
