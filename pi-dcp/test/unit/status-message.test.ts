import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { defaults } from "../../src/config/defaults.ts";
import { emptyState } from "../../src/state/reducer.ts";
import { transformOutgoingContext } from "../../src/transform/pipeline.ts";
import { createRuntime, publishBaseline } from "../../src/runtime.ts";
import { buildStatusMessage } from "../../src/prompts/status.ts";

function fixture() {
  const messages: AgentMessage[] = [{ role: "user", content: "old", timestamp: 1 }, { role: "user", content: "current", timestamp: 2 }];
  const entries = messages.map((message, index) => ({ type: "message", id: `entry-${index + 1}`, parentId: index ? `entry-${index}` : null, timestamp: new Date(index + 1).toISOString(), message }));
  const ctx = { cwd: "/tmp", model: { provider: "test", id: "model", api: "test", contextWindow: 10_000 }, getContextUsage: () => ({ tokens: null, contextWindow: 10_000 }), sessionManager: { buildContextEntries: () => entries, getLeafId: () => "entry-2" } } as any;
  return { messages, ctx };
}

describe("transient status message", () => {
  it("reports deterministic labels and consumes a pending nudge", () => {
    const runtime = createRuntime();
    const { messages, ctx } = fixture();
    const result = transformOutgoingContext(messages, { ctx, sessionId: "s", generation: 1, state: emptyState(), config: structuredClone(defaults) as any });
    publishBaseline(runtime, result.snapshot!);
    runtime.lastReadiness = { ready: true, generation: 1 };
    runtime.pendingNudge = { band: "soft", nudgeKey: "nudge" };
    const first = buildStatusMessage(runtime) as any;
    expect(first.customType).toBe("pi-dcp.v2.status");
    // m0002 ("current") is the live user turn and is excluded from the
    // compressible inventory - it can never be part of a compress call, so
    // reporting it as compressible would be exactly the misleading span this
    // segment-based report replaces.
    expect(first.content).toContain("Compressible labels: m0001.");
    expect(first.content).toContain("When convenient");
    expect(runtime.pendingNudge).toBeUndefined();
    expect(buildStatusMessage(runtime)).toEqual(buildStatusMessage(runtime));
    expect(first.content).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(first.content).not.toMatch(/T\d{2}:\d{2}/);
  });

  it("does not publish aliases when readiness is false", () => {
    const runtime = createRuntime();
    runtime.lastReadiness = { ready: false, reason: "join_ambiguous", generation: 0 };
    const status = buildStatusMessage(runtime) as any;
    expect(status.content).toContain("join_ambiguous");
    expect(status.content).toContain("No aliases were published");
    expect(status.content).not.toContain("m0001");
  });
});
