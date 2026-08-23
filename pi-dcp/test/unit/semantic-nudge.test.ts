import { describe, expect, it } from "vitest";
import { defaults, type EffectiveConfig } from "../../src/config/defaults.ts";
import { emptyState } from "../../src/state/reducer.ts";
import { createRuntime, noteSuccessfulCompression } from "../../src/runtime.ts";
import { buildProtocolUnits } from "../../src/identity/protocol.ts";
import { projectContextEntries } from "../../src/identity/project.ts";
import { estimatePotentialSavings, evaluateSemanticNudge } from "../../src/transform/semantic-nudge.ts";

function config(): EffectiveConfig {
  return structuredClone(defaults) as unknown as EffectiveConfig;
}

function indexFor(messages: any[]) {
  const entries = messages.map((message, index) => ({
    type: "message",
    id: `entry-${index + 1}`,
    parentId: index ? `entry-${index}` : null,
    timestamp: new Date(index + 1).toISOString(),
    message,
  }));
  const projection = projectContextEntries(entries as any);
  if (!projection.ok) throw new Error(projection.reason);
  const index = buildProtocolUnits(projection.messages);
  if (!("units" in index)) throw new Error(index.reason);
  return index;
}

describe("semantic compression nudges", () => {
  it("uses the recommended defaults", () => {
    expect(defaults.nudge.turnNudgeFrequency).toBe(5);
    expect(defaults.nudge.iterationNudgeThreshold).toBe(15);
    expect(defaults.nudge.minPotentialSavingsTokens).toBe(32000);
  });

  it("counts only eligible visible source and applies the summary reserve", () => {
    const index = indexFor([
      { role: "user", content: "old request", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "x".repeat(64000) }], api: "test", provider: "test", model: "model", stopReason: "stop", timestamp: 2 },
      { role: "user", content: "current request", timestamp: 3 },
    ]);
    const potential = estimatePotentialSavings(index, emptyState(), config(), "/tmp");

    expect(potential.candidateUnits).toBe(2);
    expect(potential.candidateSegments).toBe(1);
    expect(potential.sourceTokens).toBeGreaterThanOrEqual(16000);
    expect(potential.protectedSourceTokens).toBe(0);
    expect(potential.estimatedSavingsTokens).toBe(Math.floor(potential.sourceTokens * 0.75));
  });

  it("does not count configured protected tool output as removable savings", () => {
    const index = indexFor([
      { role: "user", content: "old request", timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "out.txt" } }], api: "test", provider: "test", model: "model", stopReason: "toolUse", timestamp: 2 },
      { role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "x".repeat(64000) }], isError: false, timestamp: 3 },
      { role: "user", content: "current request", timestamp: 4 },
    ]);
    const settings = config();
    settings.compress.protectedTools = ["read"];
    const potential = estimatePotentialSavings(index, emptyState(), settings, "/tmp");

    expect(potential.protectedSourceTokens).toBeGreaterThan(0);
    expect(potential.estimatedSavingsTokens).toBeLessThan(Math.floor(potential.sourceTokens * 0.75));
  });

  it("resets semantic counters after successful compression", () => {
    const runtime = createRuntime();
    runtime.semanticUserTurnsSinceCompression = 5;
    runtime.semanticIterationsSinceUserTurn = 15;
    runtime.semanticUserTurnsSinceNudge = 5;
    runtime.semanticIterationsSinceNudge = 15;
    runtime.pendingNudge = { band: "soft", kind: "turn", nudgeKey: "nudge" };

    noteSuccessfulCompression(runtime);

    expect(runtime.semanticUserTurnsSinceCompression).toBe(0);
    expect(runtime.semanticIterationsSinceUserTurn).toBe(0);
    expect(runtime.semanticUserTurnsSinceNudge).toBe(0);
    expect(runtime.semanticIterationsSinceNudge).toBe(0);
    expect(runtime.pendingNudge).toBeUndefined();
  });

  it("does not schedule below the potential-savings floor", () => {
    const result = evaluateSemanticNudge({
      userTurnsSinceCompression: 5,
      iterationsSinceUserTurn: 15,
      userTurnsSinceNudge: 5,
      iterationsSinceNudge: 15,
    }, 31999, config());

    expect(result.reason).toBe("potential_savings_below_minimum");
    expect(result.decision).toBeUndefined();
  });

  it("prefers a completed turn boundary over the iteration trigger", () => {
    const result = evaluateSemanticNudge({
      userTurnsSinceCompression: 5,
      iterationsSinceUserTurn: 15,
      userTurnsSinceNudge: 5,
      iterationsSinceNudge: 15,
    }, 32000, config());

    expect(result.decision).toMatchObject({ kind: "turn", type: "soft" });
  });

  it("uses the iteration trigger for a long task without new user input", () => {
    const result = evaluateSemanticNudge({
      userTurnsSinceCompression: 1,
      iterationsSinceUserTurn: 15,
      userTurnsSinceNudge: 1,
      iterationsSinceNudge: 15,
    }, 32000, config());

    expect(result.decision).toMatchObject({ kind: "iteration", type: "soft" });
  });

  it("enforces separate cooldowns for turn and iteration reminders", () => {
    const result = evaluateSemanticNudge({
      userTurnsSinceCompression: 10,
      iterationsSinceUserTurn: 30,
      userTurnsSinceNudge: 4,
      iterationsSinceNudge: 14,
    }, 32000, config());

    expect(result.reason).toBe("semantic_interval_not_elapsed");
    expect(result.decision).toBeUndefined();
  });
});
