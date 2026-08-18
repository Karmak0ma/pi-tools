import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defaults } from "../../src/config/defaults.ts";
import { emptyState } from "../../src/state/reducer.ts";
import { transformOutgoingContext } from "../../src/transform/pipeline.ts";
import { createRuntime, publishBaseline } from "../../src/runtime.ts";
import { buildErrorText } from "../../src/compression/errors.ts";

type Captured = { provider: string; model: string; api: string; entries: any[] };
const captured = JSON.parse(readFileSync(new URL("../fixtures/captured-session-2026-08-16.json", import.meta.url), "utf8")) as Captured;

describe("captured 2026-08-16 regression", () => {
  it("transforms the Codex responses API and publishes inline aliases", () => {
    const messages = captured.entries.map((entry) => entry.message);
    const ctx = { cwd: "/tmp", model: { provider: captured.provider, id: captured.model, api: captured.api, contextWindow: 128_000 }, getContextUsage: () => ({ tokens: null, contextWindow: 128_000 }), sessionManager: { buildContextEntries: () => captured.entries, getLeafId: () => captured.entries.at(-1).id } } as any;
    const result = transformOutgoingContext(messages, { ctx, sessionId: "captured", generation: 1, state: emptyState(), config: structuredClone(defaults) as any });
    expect(result.snapshot).toBeDefined();
    expect(result.messages.some((message: any) => JSON.stringify(message).includes("pi-dcp-message-id"))).toBe(true);
  });

  it("reports m0227/m2109 as invalid instead of hiding the real range error", () => {
    const messages = captured.entries.map((entry) => entry.message);
    const ctx = { cwd: "/tmp", model: { provider: captured.provider, id: captured.model, api: captured.api, contextWindow: 128_000 }, getContextUsage: () => ({ tokens: null, contextWindow: 128_000 }), sessionManager: { buildContextEntries: () => captured.entries, getLeafId: () => captured.entries.at(-1).id } } as any;
    const result = transformOutgoingContext(messages, { ctx, sessionId: "captured", generation: 1, state: emptyState(), config: structuredClone(defaults) as any });
    const runtime = createRuntime();
    publishBaseline(runtime, result.snapshot!);
    const text = buildErrorText(runtime, "range_invalid", { id: "m0227" });
    expect(text).toContain("m0227");
    // m0005 is excluded (not settled / a turn-protected unit in this capture);
    // the honest report is two segments, not one misleading first-last span.
    expect(text).toContain("Compressible labels right now: m0001-m0004, m0006.");
  });

  it("starts unavailable before any request has published a baseline", () => {
    const runtime = createRuntime();
    expect(runtime.lastReadiness?.ready).toBe(false);
    expect(runtime.lastReadiness?.reason).not.toBe("baseline_unavailable");
  });
});
