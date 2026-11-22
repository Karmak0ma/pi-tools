import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildSyntheticSession, contextEventMessages, createContextHarness } from "../helpers/synthetic-session.ts";
import { currentHostSessionManager } from "../helpers/current-host.ts";
import { deepFreeze } from "../../src/util/clone.ts";
import { outgoingPrune } from "../../src/state/reducer.ts";

/**
 * SHA-256 of the transformed messages for the default synthetic session.
 *
 * This pins behavior while the request path is optimized: a faster version
 * must produce byte-identical output. Update the value ONLY for an intended
 * behavior change, and say which change in the commit message; never update it
 * just to make an optimization pass.
 */
// Updated 2026-11-06: tool-call units are labelled on their tool result, not
// inside the assistant turn (plain-text tool-call incident, labels.ts).
// Updated for deferred pruning: the fixture's dedup decisions come after its last
// compression, so their 12 outputs stay raw until the next one. Nothing else in
// the output changed (verified by diffing the two outputs message by message).
const GOLDEN_OUTPUT_SHA256 = "5be03650fa6d399387eddbd9deaeff49d529f94130475273daa5854cac1cca2d";

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
    const session = buildSyntheticSession();
    const incoming = contextEventMessages(session.entries, session.leafId);
    const harness = createContextHarness(currentHostSessionManager(session.entries, session.leafId), incoming);
    // The request path avoids deep copies by never mutating Pi's session
    // objects or the `context` input (see transformOutgoingContext). Freeze
    // both: ES modules are strict, so any write throws, the pipeline falls
    // back to raw context, and the no-fallback check below fails.
    deepFreeze(session.entries);
    deepFreeze(incoming);
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
    // Every dedup-pruned output that takes effect is replaced by a short placeholder.
    const state = harness.runtime.reduced;
    const effective = new Set([...state.toolPrunes.keys()].filter((id) => outgoingPrune(state, id)?.output));
    const prunedResults = first.messages.filter((message): message is Extract<typeof message, { role: "toolResult" }> => message.role === "toolResult" && effective.has(message.toolCallId));
    expect(prunedResults.length).toBe(effective.size);
    for (const message of prunedResults) expect(JSON.stringify(message.content).length).toBeLessThan(200);
    // Decisions recorded after the last compression wait for the next one, so
    // their outputs must still be raw here. Replacing them now would change bytes
    // before every later turn (see state/reducer.ts, outgoingPrune).
    const pendingResults = first.messages.filter((message): message is Extract<typeof message, { role: "toolResult" }> => message.role === "toolResult" && state.toolPrunes.has(message.toolCallId) && !effective.has(message.toolCallId));
    expect(pendingResults.length).toBeGreaterThan(0);
    for (const message of pendingResults) expect(JSON.stringify(message.content).length).toBeGreaterThan(200);
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
