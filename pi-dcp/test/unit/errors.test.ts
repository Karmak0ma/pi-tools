import { describe, expect, it } from "vitest";
import { defaults } from "../../src/config/defaults.ts";
import { emptyState } from "../../src/state/reducer.ts";
import { transformOutgoingContext } from "../../src/transform/pipeline.ts";
import { buildErrorText } from "../../src/compression/errors.ts";
import { createRuntime, publishBaseline } from "../../src/runtime.ts";

describe("actionable compression errors", () => {
  const setup = () => {
    const messages = [{ role: "user", content: "old", timestamp: 1 }, { role: "user", content: "current", timestamp: 2 }] as any[];
    const entries = messages.map((message, index) => ({ type: "message", id: `entry-${index + 1}`, parentId: index ? `entry-${index}` : null, timestamp: new Date(index + 1).toISOString(), message }));
    const ctx = { cwd: "/tmp", model: { provider: "test", id: "model", api: "test", contextWindow: 10_000 }, getContextUsage: () => ({ tokens: null, contextWindow: 10_000 }), sessionManager: { buildContextEntries: () => entries, getLeafId: () => "entry-2" } } as any;
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

  it("includes the specific nested-placeholder repair in the model-visible error", () => {
    const text = buildErrorText(setup(), "placeholder_invalid", {
      hint: "range 0 (m0001-m0002) includes (b0001); include it exactly once.",
    });

    expect(text).toContain("range 0 (m0001-m0002) includes (b0001)");
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
