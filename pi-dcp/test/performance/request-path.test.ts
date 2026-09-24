import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSyntheticHarness } from "../helpers/synthetic-session.ts";

/**
 * SHA-256 of the transformed messages for the default synthetic session.
 *
 * This pins behavior while the request path is optimized: a faster version
 * must produce byte-identical output. Update the value ONLY for an intended
 * behavior change, and say which change in the commit message; never update it
 * just to make an optimization pass.
 */
const GOLDEN_OUTPUT_SHA256 = "881fc7b91d2971d3c8cd31da995adffab6632e5b3f538d0bc53c846e6d608b7e";

/**
 * Coarse guard against a large regression, not a performance target. The
 * measured median on the development machine is about 0.3 s; the ceiling is
 * several times higher so slower CI machines do not flake. Use `npm run bench`
 * for real measurements.
 */
const MEDIAN_CEILING_MS = 2_000;

const sha256 = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

describe("realistic request path", () => {
  it("runs the full transform on a large session and keeps its output stable", async () => {
    const harness = createSyntheticHarness();
    const first = await harness.run();

    // The fixture must exercise the full path. A raw fallback would make both
    // the golden hash and the timing meaningless.
    expect(harness.incoming.length).toBe(1500);
    expect(JSON.stringify(harness.incoming).length).toBeGreaterThan(10_000_000);
    expect(harness.runtime.contextStats.rawRequests).toBe(0);
    expect(harness.runtime.lastReadiness?.ready).toBe(true);

    const output = JSON.stringify(first.messages);
    // The nested block replaces its two children, and later blocks stay active.
    expect(output).toContain("summary-nested-1:0");
    expect(output).toContain("summary-b5:0");
    expect(output).not.toContain("summary-b1:0");
    // Pi applies the host context_edit before DCP sees the projection.
    expect(output).toContain("[edited by host");
    // Every dedup-pruned output is replaced by a short placeholder.
    const pruned = new Set(harness.runtime.reduced.toolPrunes.keys());
    const prunedResults = first.messages.filter((message): message is Extract<typeof message, { role: "toolResult" }> => message.role === "toolResult" && pruned.has(message.toolCallId));
    expect(prunedResults.length).toBe(pruned.size);
    for (const message of prunedResults) expect(JSON.stringify(message.content).length).toBeLessThan(200);
    // Pi 0.87 omits system messages from `context`; DCP must not add them back.
    expect(first.messages.some((message) => message.role === "system")).toBe(false);

    expect(sha256(first.messages)).toBe(GOLDEN_OUTPUT_SHA256);

    const timings: number[] = [];
    for (let run = 0; run < 3; run++) {
      const started = performance.now();
      const repeated = await harness.run();
      timings.push(performance.now() - started);
      // Repeated requests over an unchanged session must be byte-identical,
      // including any future cache hits.
      expect(sha256(repeated.messages)).toBe(GOLDEN_OUTPUT_SHA256);
    }
    timings.sort((a, b) => a - b);
    expect(timings[1]).toBeLessThan(MEDIAN_CEILING_MS);
  });
});
