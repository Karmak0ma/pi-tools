import { describe, expect, it } from "vitest";
import { defaults } from "../../src/config/defaults.ts";
import { emptyState } from "../../src/state/reducer.ts";
import { transformOutgoingContext } from "../../src/transform/pipeline.ts";
import { buildCompressionEnvelope } from "../../src/compression/service.ts";
import { buildErrorText } from "../../src/compression/errors.ts";
import { createRuntime, publishBaseline } from "../../src/runtime.ts";
import { currentHostSessionManager } from "../helpers/current-host.ts";

// Regression for a real session: a compress range was rejected because of
// async subagent results (role `custom`), the error named only the first of
// seven blockers, and the model never retried.

const subagentResult = (n: number) => ({ role: "custom", customType: "subagent-background-result", content: `task-${n} done`, display: true, timestamp: n });

function setup(messages: any[]) {
  const entries = messages.map((message, index) => {
    const base = { id: `entry-${index + 1}`, parentId: index ? `entry-${index}` : null, timestamp: new Date(index + 1).toISOString() };
    return message.role === "custom"
      ? { ...base, type: "custom_message", customType: message.customType, content: message.content, display: message.display }
      : { ...base, type: "message", message };
  });
  const ctx = { cwd: "/tmp", model: { provider: "test", id: "model", api: "test", contextWindow: 10_000 }, getContextUsage: () => ({ tokens: null, contextWindow: 10_000 }), sessionManager: currentHostSessionManager(entries as any, `entry-${entries.length}`) } as any;
  const result = transformOutgoingContext(messages, { ctx, sessionId: "s", generation: 1, state: emptyState(), config: structuredClone(defaults) as any });
  if (!result.snapshot) throw new Error("no snapshot");
  return result.snapshot;
}

const build = (snapshot: any, startId: string, endId: string) => buildCompressionEnvelope({ sessionId: "s", extensionVersion: "t", snapshot, state: emptyState(), params: { topic: "t", content: [{ startId, endId, summary: "done" }] }, model: undefined, toolCallId: "c1" });

describe("blocked units", () => {
  it("compresses a range that contains extension custom messages", () => {
    const snapshot = setup([
      { role: "user", content: "old", timestamp: 1 },
      subagentResult(2),
      { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 3 },
      { role: "user", content: "current", timestamp: 4 },
    ]);
    expect(snapshot.units[1]).toMatchObject({ role: "custom", compressible: true });
    expect(build(snapshot, "m0001", "m0003").ok).toBe(true);
  });

  it("reports every blocker and the exact split ranges", () => {
    const system = { role: "system", content: "host prompt", sections: { host: "guidance" }, timestamp: 2 };
    const snapshot = setup([
      { role: "user", content: "old", timestamp: 1 },
      system,
      { role: "assistant", content: [{ type: "text", text: "a" }], timestamp: 3 },
      { ...system, timestamp: 4 },
      { role: "assistant", content: [{ type: "text", text: "b" }], timestamp: 5 },
      { role: "user", content: "current", timestamp: 6 },
    ]);
    const result = build(snapshot, "m0001", "m0005");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blocked?.map((unit) => [unit.id, unit.cause])).toEqual([["m0002", "protected_message"], ["m0004", "protected_message"]]);

    const runtime = createRuntime();
    publishBaseline(runtime, snapshot);
    runtime.lastReadiness = { ready: true, generation: 1 };
    const text = buildErrorText(runtime, result.reason, { ...result, baseline: snapshot });
    expect(text).toContain("2 units in the requested range(s) cannot be compressed");
    expect(text).toContain("- m0002 (range 0) is a protected message");
    expect(text).toContain("- m0004 (range 0) is a protected message");
    expect(text).toContain("range 0 (m0001-m0005) -> m0001, m0003, m0005");
  });
});
