import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEnvelope } from "../../src/state/operations.ts";
import { projectContextEntries } from "../../src/identity/project.ts";
import { buildProtocolUnits } from "../../src/identity/protocol.ts";
import { createSnapshot } from "../../src/identity/snapshot.ts";
import { buildCompressionEnvelope } from "../../src/compression/service.ts";
import { emptyState, reduceEnvelope } from "../../src/state/reducer.ts";
import { appendSavingsRecord, emptySavingsTotals, readSavingsLedger, savingsFromOperation } from "../../src/stats.ts";
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
    const projection = projectContextEntries(entries as any);
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    const index = buildProtocolUnits(projection.messages);
    expect("units" in index).toBe(true);
    if (!("units" in index)) return;
    const snapshot = createSnapshot({ sessionId: "session-compression", leafId: "entry-2", model: { provider: "test", id: "test", api: "test", contextWindow: 1000 }, generation: 1, ttlMs: 60_000, index, state: emptyState(), configHash: "stats" });
    const built = buildCompressionEnvelope({ sessionId: "session-compression", extensionVersion: "0.1.0", snapshot, state: emptyState(), params: { topic: "completed work", content: [{ startId: "m0001", endId: "m0001", summary: "short summary" }] }, model: undefined, index });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.blocks[0].estimatedSourceTokens).toBeGreaterThan(built.blocks[0].estimatedSummaryTokens);
      expect(built.blocks[0].estimatedSavingsTokens).toBeGreaterThan(0);
    }
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
