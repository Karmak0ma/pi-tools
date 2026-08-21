import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { defaults } from "../../src/config/defaults.ts";
import { emptyState } from "../../src/state/reducer.ts";
import { transformOutgoingContext } from "../../src/transform/pipeline.ts";
import { createRuntime, publishBaseline } from "../../src/runtime.ts";
import { buildNudgeMessage } from "../../src/prompts/nudge.ts";

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

describe("transient nudge message", () => {
  it("delivers a pending nudge exactly once", () => {
    const runtime = readyRuntimeWithBaseline();
    runtime.pendingNudge = { band: "soft", nudgeKey: "nudge" };

    const first = buildNudgeMessage(runtime) as any;
    expect(first.customType).toBe("pi-dcp.v2.nudge");
    expect(first.content).toBe("[pi-dcp nudge] Before starting the next substantial work unit, use pi-dcp compress for at least one useful older closed range. If the current work is still active, finish only that atomic operation first. Continue without compression only if no safe closed range is visible. Select older, resolved conversation whose work is finished or no longer needed immediately. Keep active work, unresolved questions, exact details still needed, pending tool exchanges, and protected content out of the range. Use contiguous complete protocol units and write a faithful summary.");
    expect(runtime.pendingNudge).toBeUndefined();
    // Deterministic: no timestamp, no session-varying text, so an identical
    // nudge produces identical bytes.
    expect(first.content).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(first.content).not.toMatch(/T\d{2}:\d{2}/);
  });

  it("makes imperative and critical nudges direct action requests", () => {
    const imperativeRuntime = readyRuntimeWithBaseline();
    imperativeRuntime.pendingNudge = { band: "imperative", nudgeKey: "imperative" };
    expect((buildNudgeMessage(imperativeRuntime) as any).content).toContain(
      "Use pi-dcp compress as your next tool call before beginning or continuing non-atomic work.",
    );

    const criticalRuntime = readyRuntimeWithBaseline();
    criticalRuntime.pendingNudge = { band: "critical", nudgeKey: "critical" };
    expect((buildNudgeMessage(criticalRuntime) as any).content).toContain(
      "then use pi-dcp compress before any other work",
    );
  });

  it("uses the semantic reason in turn and iteration nudges", () => {
    const turnRuntime = readyRuntimeWithBaseline();
    turnRuntime.pendingNudge = { band: "soft", kind: "turn", nudgeKey: "turn" };
    expect((buildNudgeMessage(turnRuntime) as any).content).toContain("A substantial work boundary has been reached");

    const iterationRuntime = readyRuntimeWithBaseline();
    iterationRuntime.pendingNudge = { band: "soft", kind: "iteration", nudgeKey: "iteration" };
    expect((buildNudgeMessage(iterationRuntime) as any).content).toContain("many assistant/tool iterations");
  });

  it("emits nothing on an ordinary ready request", () => {
    // The whole point of the redesign: a ready runtime with compressible
    // labels adds NO message to the request. The compressible mNNNN units are
    // already tagged inline, and which of them are still live is a rule in the
    // cached system prompt (prompts/defaults.ts selectionRules), not a
    // per-request user turn on the wire.
    const runtime = readyRuntimeWithBaseline();
    expect(buildNudgeMessage(runtime)).toBeUndefined();
  });

  it("emits nothing when readiness is false, even with a pending nudge", () => {
    const runtime = createRuntime();
    runtime.lastReadiness = { ready: false, reason: "join_ambiguous", generation: 0 };
    runtime.pendingNudge = { band: "soft", nudgeKey: "nudge" };
    expect(buildNudgeMessage(runtime)).toBeUndefined();
    // A nudge tied to a failed/invalidated transform must not survive to a
    // later, successful one - it is re-derived from settled state instead.
    expect(runtime.pendingNudge).toBeUndefined();
  });
});
