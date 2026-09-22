import { describe, expect, it } from "vitest";
import { buildSessionProjection } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createRuntime, invalidateSnapshot, noteSuccessfulCompression, type DcpRuntime } from "../../src/runtime.ts";
import { defaults } from "../../src/config/defaults.ts";
import { registerLifecycle } from "../../src/lifecycle.ts";
import { NUDGE_PREFIX } from "../../src/prompts/nudge.ts";
import { LABEL_TAG_NAME } from "../../src/transform/labels.ts";

/**
 * Regression tests for the 2026-09-13 "nudge inserted with mismatching tags"
 * report. A delivered nudge must always agree with the label tags visible in
 * the same request:
 * - position: the nudge is appended after the newest labeled user turn and
 *   never carries a label tag itself (transient, never persisted);
 * - eligibility: soft/imperative context nudges are only created when the
 *   settled index offers compressible content, so the nudge cannot contradict
 *   its own request (every unit BLOCKED or user-protected). The critical band
 *   is exempt by design: recovery pressure at >=90% always fires;
 * - cooldown: a successful compression arms the soft-band interval exactly
 *   like a delivered nudge does, so the model is not told to compress again
 *   immediately after it just did;
 * - invalidation: a pending nudge is dropped when the snapshot is invalidated
 *   (model switch, compaction, tree changes), because its envelope generation
 *   and token thresholds no longer describe the upcoming request.
 *
 * The FakeHost mirrors the current Pi event order (session_start, turn_start,
 * context, agent_settled) as verified against agent-loop.js and
 * agent-session.js in the host package.
 */

interface Entry { type: string; id: string; parentId: string | null; timestamp: string; message: AgentMessage }

class FakeHost {
  entries: Entry[] = [];
  runtime: DcpRuntime;
  handlers = new Map<string, (event: any, ctx: any) => unknown>();
  appended: any[] = [];

  constructor() {
    this.runtime = createRuntime();
    this.runtime.sessionId = "s";
    const pi = {
      on: (name: string, handler: (event: any, ctx: any) => unknown) => { this.handlers.set(name, handler); },
      appendEntry: (customType: string, data: unknown) => { this.appended.push({ customType, data }); },
      getAllTools: () => [],
      registerTool: () => undefined,
      getActiveTools: () => [],
      setActiveTools: () => undefined,
    } as any;
    registerLifecycle(pi, this.runtime);
    this.runtime.config = structuredClone(defaults) as any;
  }

  ctx(overrides: Record<string, unknown> = {}) {
    const host = this;
    return {
      cwd: "/tmp",
      model: { provider: "t", id: "m", api: "t", contextWindow: 200_000 },
      getContextUsage: () => ({ tokens: 10_000, contextWindow: 200_000 }),
      isProjectTrusted: () => true,
      isIdle: () => true,
      ui: { notify: () => undefined, confirm: async () => true },
      sessionManager: {
        getBranch: () => host.entries,
        buildContextEntries: () => host.entries,
        buildSessionProjection: () => buildSessionProjection(host.entries as any, host.entries.at(-1)?.id),
        getLeafId: () => host.entries.at(-1)?.id ?? null,
        getSessionId: () => "s",
        getSessionFile: () => undefined,
      },
      ...overrides,
    } as any;
  }

  entry(message: AgentMessage): Entry {
    return { type: "message", id: `entry-${this.entries.length + 1}`, parentId: this.entries.at(-1)?.id ?? null, timestamp: new Date(this.entries.length + 1).toISOString(), message };
  }

  push(message: AgentMessage) {
    this.entries.push(this.entry(message));
  }

  async startSession() {
    await this.handlers.get("session_start")?.({ type: "session_start" }, this.ctx());
  }

  async userTurn(text: string) {
    this.push({ role: "user", content: text, timestamp: this.entries.length + 1 } as AgentMessage);
    await this.handlers.get("turn_start")?.({ type: "turn_start" }, this.ctx());
  }

  async request() {
    const handler = this.handlers.get("context")!;
    return (await handler({ type: "context", messages: structuredClone(this.entries.map((e) => e.message)) }, this.ctx())) as { messages: AgentMessage[] };
  }

  async settle(usage?: { tokens: number; contextWindow: number }) {
    await this.handlers.get("agent_settled")?.({ type: "agent_settled" }, this.ctx(usage ? { getContextUsage: () => usage } : {}));
  }

  nudgeMessages(result: { messages: AgentMessage[] }): string[] {
    return result.messages.filter((m: any) => typeof m.content === "string" && m.content.includes(NUDGE_PREFIX)).map((m: any) => m.content);
  }
}

function filler(text: string): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }], api: "t", provider: "t", model: "m", stopReason: "stop", timestamp: 0 } as AgentMessage;
}

function shellExchange(i: number): [AgentMessage, AgentMessage] {
  return [
    { role: "user", content: `request ${i} `.repeat(50), timestamp: 0 } as AgentMessage,
    { role: "bashExecution", command: `echo ${i}`, output: "x".repeat(4000), exitCode: 0, cancelled: false, truncated: false, timestamp: 0 } as AgentMessage,
  ];
}

describe("nudge/tag consistency", () => {
  it("baseline: a pending nudge lands at the tail, after the newest labeled user turn, and carries no label tag", async () => {
    const host = new FakeHost();
    host.push(filler("old analysis ".repeat(4000)));
    await host.startSession();
    await host.request(); // publish baseline + readiness
    host.runtime.pendingNudge = { band: "imperative", kind: "context", nudgeKey: "k1" };
    await host.userTurn("Investigate");
    const result = await host.request();
    const last = result.messages.at(-1) as any;
    expect(last?.content).toContain(NUDGE_PREFIX);
    // The nudge itself must not wear a protocol label: it is a transient
    // request suffix, not a compressible conversation unit.
    expect(last?.content).not.toContain(`<${LABEL_TAG_NAME}>`);
    // Delivered exactly once: consumed by the transform that shipped it.
    expect(host.runtime.pendingNudge).toBeUndefined();
    expect(host.nudgeMessages(await host.request())).toHaveLength(0);
  });

  it("skips soft and imperative context nudges when nothing is compressible", async () => {
    const host = new FakeHost();
    for (let i = 0; i < 30; i++) {
      const [user, shell] = shellExchange(i);
      host.push(user);
      host.push(shell);
    }
    await host.startSession();
    await host.request(); // publish readiness
    // protectUserMessages makes every user unit unselectable; bashExecution
    // units are permanently BLOCKED. Nothing in the request is selectable.
    (host.runtime.config as any).compress.protectUserMessages = true;
    await host.settle({ tokens: 150_000, contextWindow: 200_000 }); // 75% → imperative band
    expect(host.runtime.lastNudgeEvaluation?.reason).toBe("nothing_compressible");
    expect(host.runtime.lastNudgeEvaluation?.potentialSavingsTokens).toBe(0);
    expect(host.runtime.pendingNudge).toBeUndefined();
    expect(host.appended.some((e) => e.data?.operation?.type === "nudge.requested")).toBe(false);
    // And nothing is delivered on the next request either.
    await host.userTurn("continue");
    expect(host.nudgeMessages(await host.request())).toHaveLength(0);
  });

  it("still schedules the critical band when nothing is compressible", async () => {
    const host = new FakeHost();
    for (let i = 0; i < 30; i++) {
      const [user, shell] = shellExchange(i);
      host.push(user);
      host.push(shell);
    }
    await host.startSession();
    await host.request();
    (host.runtime.config as any).compress.protectUserMessages = true;
    await host.settle({ tokens: 190_000, contextWindow: 200_000 }); // 95% → critical band
    const nudge = [...host.runtime.reduced.nudges.values()][0];
    // reduced.nudges stores the flat nudge.requested operation.
    expect(nudge).toMatchObject({ type: "nudge.requested", band: "critical" });
    expect(host.runtime.pendingNudge).toMatchObject({ band: "critical" });
    await host.userTurn("recover");
    expect(host.nudgeMessages(await host.request())).toHaveLength(1);
  });

  it("arms the soft context cooldown after a successful compression", async () => {
    const host = new FakeHost();
    for (let i = 0; i < 30; i++) {
      host.push({ role: "user", content: `request ${i} `.repeat(50), timestamp: 0 } as AgentMessage);
      host.push(filler("analysis output ".repeat(600)));
    }
    await host.startSession();
    await host.request();
    // The model compressed mid-turn; usage sits between min and max afterwards.
    host.runtime.turnCount = 40;
    noteSuccessfulCompression(host.runtime);
    await host.settle({ tokens: 90_000, contextWindow: 200_000 }); // 45% → soft band
    // Same-turn settle: the compression already served the pressure response.
    expect(host.runtime.lastNudgeEvaluation?.reason).toBe("already_nudged_this_turn");
    expect(host.runtime.pendingNudge).toBeUndefined();
    // Turns 41-44: cooldown still running for the soft band. The merged
    // evaluation may surface the semantic reason here; the contract is that
    // no nudge is created or delivered while the interval runs.
    for (let turn = 41; turn <= 44; turn++) {
      host.runtime.turnCount = turn;
      await host.settle({ tokens: 90_000, contextWindow: 200_000 });
      expect(host.runtime.lastNudgeEvaluation?.decision).toBeUndefined();
      expect(host.runtime.pendingNudge).toBeUndefined();
    }
    // Turn 45: cooldown elapsed, savings exist → the soft nudge fires again.
    host.runtime.turnCount = 45;
    await host.settle({ tokens: 90_000, contextWindow: 200_000 });
    expect(host.runtime.lastNudgeEvaluation?.decision).toMatchObject({ kind: "context", type: "soft" });
    expect(host.runtime.pendingNudge).toBeDefined();
  });

  it("drops a pending nudge when the snapshot is invalidated", async () => {
    const host = new FakeHost();
    host.push(filler("old analysis ".repeat(4000)));
    await host.startSession();
    await host.request(); // ready, generation G
    host.runtime.pendingNudge = { band: "imperative", kind: "context", nudgeKey: "stale-1" };
    const beforeGeneration = host.runtime.generation;
    invalidateSnapshot(host.runtime); // what model_select / before_compact / tree events trigger
    expect(host.runtime.generation).toBe(beforeGeneration + 1);
    expect(host.runtime.pendingNudge).toBeUndefined();
    await host.userTurn("continue after model switch");
    // The fresh request transforms under the new generation and carries no
    // stale nudge; the next settle re-evaluates from scratch.
    expect(host.nudgeMessages(await host.request())).toHaveLength(0);
  });
});