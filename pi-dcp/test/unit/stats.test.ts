import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEnvelope } from "../../src/state/operations.ts";
import { projectCurrentEntries } from "../helpers/current-host.ts";
import { buildProtocolUnits } from "../../src/identity/protocol.ts";
import { createSnapshot } from "../../src/identity/snapshot.ts";
import { buildCompressionEnvelope } from "../../src/compression/service.ts";
import { emptyState, reduceEnvelope } from "../../src/state/reducer.ts";
import { appendSavingsRecord, emptySavingsTotals, readSavingsLedger, savingsFromOperation } from "../../src/stats.ts";
import { IMAGE_TOKEN_COST } from "../../src/tokens/estimate.ts";
import { formatStatsTable } from "../../src/commands/stats.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("savings accounting", () => {
  it("classifies every pruning source and replays its totals into session state", () => {
    const operation = {
      type: "tools.pruned" as const,
      decisions: [
        { toolCallId: "dedup", kind: "dedup-output" as const, estimatedTokens: 11 },
        { toolCallId: "sweep", kind: "sweep-output" as const, estimatedTokens: 7 },
        { toolCallId: "error", kind: "old-error-input" as const, estimatedTokens: 5 },
        { toolCallId: "question", kind: "question-input" as const, estimatedTokens: 13 },
      ],
    };
    const envelope = createEnvelope(operation, "session-a", "0.1.0", "stats-request");

    expect(savingsFromOperation(operation)).toEqual({
      deduplication: { events: 1, tokens: 11 },
      sweep: { events: 1, tokens: 7 },
      "old-error-input": { events: 1, tokens: 5 },
      "question-input": { events: 1, tokens: 13 },
    });
    const state = reduceEnvelope(emptyState(), envelope);
    expect(state.savings.deduplication.tokens).toBe(11);
    expect(state.savings.sweep.tokens).toBe(7);
    expect(state.savings["old-error-input"].tokens).toBe(5);
    expect(state.savings["question-input"].tokens).toBe(13);
  });

  it("records estimated range-compression savings from the source representation", () => {
    const messages = [
      { role: "user", content: "A long completed user request", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "A completed answer with useful detail" }], api: "test", provider: "test", model: "test", stopReason: "stop", timestamp: 2 },
      { role: "user", content: "A newer request", timestamp: 3 },
    ] as any[];
    const entries = messages.map((message, index) => ({ type: "message", id: `entry-${index}`, parentId: index ? "entry-0" : null, timestamp: new Date(index + 1).toISOString(), message }));
    const projection = projectCurrentEntries(entries as any);
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    const index = buildProtocolUnits(projection.messages);
    expect("units" in index).toBe(true);
    if (!("units" in index)) return;
    const snapshot = createSnapshot({ sessionId: "session-compression", leafId: "entry-2", model: { provider: "test", id: "test", api: "test", contextWindow: 1000 }, generation: 1, ttlMs: 60_000, index, state: emptyState(), branch: [], configHash: "stats" });
    const built = buildCompressionEnvelope({ sessionId: "session-compression", extensionVersion: "0.1.0", snapshot, state: emptyState(), params: { topic: "completed work", content: [{ startId: "m0001", endId: "m0001", summary: "short summary" }] }, model: undefined, index });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.blocks[0].estimatedSourceTokens).toBeGreaterThan(built.blocks[0].estimatedSummaryTokens);
      expect(built.blocks[0].estimatedSavingsTokens).toBeGreaterThan(0);
    }
  });

  it("caps a stored pruning estimate at the output's current size, so an old inflated decision cannot zero a new block", () => {
    const text = "Read image file [image/png]";
    const messages = [
      { role: "user", content: "A long completed user request ".repeat(80), timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", id: "read-shot", name: "read", arguments: { path: "shot.png" } }], api: "test", provider: "test", model: "test", stopReason: "toolUse", timestamp: 2 },
      { role: "toolResult", toolCallId: "read-shot", toolName: "read", content: [{ type: "text", text }, { type: "image", data: "A".repeat(4 * 1024 * 1024), mimeType: "image/png" }], isError: false, timestamp: 3 },
      { role: "user", content: "A newer request", timestamp: 4 },
    ] as any[];
    const entries = messages.map((message, index) => ({ type: "message", id: `entry-${index}`, parentId: index ? `entry-${index - 1}` : null, timestamp: new Date(index + 1).toISOString(), message }));
    const projection = projectCurrentEntries(entries as any);
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    const index = buildProtocolUnits(projection.messages);
    expect("units" in index).toBe(true);
    if (!("units" in index)) return;
    // A decision written before the image rule counted the base64 characters as text.
    const state = reduceEnvelope(emptyState(), createEnvelope({ type: "tools.pruned", decisions: [{ toolCallId: "read-shot", kind: "dedup-output", estimatedTokens: 1_016_000 }] }, "session-stored", "0.1.0"));
    const snapshot = createSnapshot({ sessionId: "session-stored", leafId: "entry-3", model: { provider: "test", id: "test", api: "test", contextWindow: 10_000 }, generation: 1, ttlMs: 60_000, index, state, branch: [], configHash: "stats" });

    const built = buildCompressionEnvelope({ sessionId: "session-stored", extensionVersion: "0.1.0", snapshot, state, params: { topic: "shot", content: [{ startId: "m0001", endId: "m0002", summary: "short summary" }] }, model: undefined, index });

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.blocks[0].creditedPruneTokens).toBe(IMAGE_TOKEN_COST + Math.ceil(text.length / 4));
    expect(savingsFromOperation(built.envelope.operation).compression?.tokens).toBeGreaterThan(0);
  });

  it("deduplicates ledger records and aggregates operations from different sessions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-dcp-stats-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "dcp_stats.jsonl");
    const first = createEnvelope({ type: "tools.pruned", decisions: [{ toolCallId: "one", kind: "sweep-output", estimatedTokens: 9 }] }, "session-a", "0.1.0", "one");
    const second = createEnvelope({ type: "tools.pruned", decisions: [{ toolCallId: "two", kind: "old-error-input", estimatedTokens: 4 }] }, "session-b", "0.1.0", "two");

    await appendSavingsRecord(first, path);
    await appendSavingsRecord(first, path);
    await appendSavingsRecord(second, path);
    const ledger = await readSavingsLedger(path);

    expect(ledger.operationIds).toEqual(new Set([first.opId, second.opId]));
    expect(ledger.totals.sweep.tokens).toBe(9);
    expect(ledger.totals["old-error-input"].tokens).toBe(4);
  });

  it("renders all sources, including sources with no savings yet", () => {
    const lines = formatStatsTable(emptySavingsTotals());
    expect(lines.join("\n")).toContain("Range compression");
    expect(lines.join("\n")).toContain("Duplicate outputs");
    expect(lines.join("\n")).toContain("Swept outputs");
    expect(lines.join("\n")).toContain("Old error inputs");
    expect(lines.join("\n")).toContain("Question inputs");
    expect(lines.at(-1)).toContain("Total");
  });
});
