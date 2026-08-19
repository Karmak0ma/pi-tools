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

function readyRuntimeWithBaseline() {
  const runtime = createRuntime();
  const { messages, ctx } = fixture();
  const result = transformOutgoingContext(messages, { ctx, sessionId: "s", generation: 1, state: emptyState(), config: structuredClone(defaults) as any });
  publishBaseline(runtime, result.snapshot!);
  runtime.lastReadiness = { ready: true, generation: 1 };
  return runtime;
}

describe("transient status message", () => {
  it("delivers a pending nudge exactly once", () => {
    const runtime = readyRuntimeWithBaseline();
    runtime.pendingNudge = { band: "soft", nudgeKey: "nudge" };

    const first = buildStatusMessage(runtime) as any;
    expect(first.customType).toBe("pi-dcp.v2.status");
    expect(first.content).toBe("[pi-dcp status] When convenient, use pi-dcp compress for an older closed range. Select older, resolved conversation whose work is finished or no longer needed immediately. Keep active work, unresolved questions, exact details still needed, pending tool exchanges, and protected content out of the range. Use contiguous complete protocol units and write a faithful summary.");
    expect(runtime.pendingNudge).toBeUndefined();
    // Deterministic: no timestamp, no session-varying text, so an identical
    // nudge produces identical bytes.
    expect(first.content).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(first.content).not.toMatch(/T\d{2}:\d{2}/);
  });

  it("emits nothing on an ordinary ready request", () => {
    // The whole point of the redesign: a ready runtime with compressible
    // labels adds NO message to the request. The compressible mNNNN units are
    // already tagged inline, and which of them are still live is a rule in the
    // cached system prompt (prompts/defaults.ts selectionRules), not a
    // per-request user turn on the wire.
    const runtime = readyRuntimeWithBaseline();
    expect(buildStatusMessage(runtime)).toBeUndefined();
  });

  it("emits nothing when readiness is false, even with a pending nudge", () => {
    const runtime = createRuntime();
    runtime.lastReadiness = { ready: false, reason: "join_ambiguous", generation: 0 };
    runtime.pendingNudge = { band: "soft", nudgeKey: "nudge" };
    expect(buildStatusMessage(runtime)).toBeUndefined();
    // A nudge tied to a failed/invalidated transform must not survive to a
    // later, successful one - it is re-derived from settled state instead.
    expect(runtime.pendingNudge).toBeUndefined();
  });
});
