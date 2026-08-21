import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkContextCapabilities, checkFactoryCapabilities } from "../../src/capabilities.ts";
import { bindCompressionProvenance, registerCompressionTool } from "../../src/compression/tool.ts";
import { clearBaselines, createRuntime, publishBaseline, setDcpToolActive } from "../../src/runtime.ts";
import { defaults } from "../../src/config/defaults.ts";
import { emptyState } from "../../src/state/reducer.ts";
import { transformOutgoingContext } from "../../src/transform/pipeline.ts";
import { registerLifecycle } from "../../src/lifecycle.ts";
import { sha256 } from "../../src/util/hash.ts";

describe("extension capability gate", () => {
  it("requires the mutation surface before registering behavior", () => { const result = checkFactoryCapabilities({} as any); expect(result.ok).toBe(false); expect(result.missing).toContain("appendEntry"); });

  it("does not require confirmation UI to keep allow-mode compression available", () => {
    const result = checkContextCapabilities({
      sessionManager: { getLeafId: () => null, getBranch: () => [], buildContextEntries: () => [] },
      getContextUsage: () => undefined,
      isProjectTrusted: () => true,
      isIdle: () => true,
      ui: { notify: () => undefined },
    } as any);

    expect(result.ok).toBe(true);
    expect(result.missing).not.toContain("ui.confirm");
  });

  it("registers compress without calling runtime-only inspection APIs", () => {
    const registered: Array<{ name: string; promptGuidelines?: string[] }> = [];
    const pi = {
      // Pi throws from action methods during extension loading. This regression
      // guard models the real startup contract that previously disabled all DCP
      // lifecycle hooks before the tool could be registered.
      getAllTools: () => { throw new Error("Extension runtime not initialized"); },
      registerTool: (tool: { name: string; promptGuidelines?: string[] }) => { registered.push(tool); },
    } as any;

    const runtime = createRuntime(pi);
    registerCompressionTool(pi, runtime);

    expect(registered.map((tool) => tool.name)).toEqual(["compress"]);
    expect(registered[0]?.promptGuidelines?.every((guideline) => guideline.includes("compress"))).toBe(true);
    expect(runtime.valid).toBe(true);
  });

  it("activates compress without removing other extensions' tools", () => {
    let active = ["read", "todo"];
    const pi = {
      getActiveTools: () => [...active],
      setActiveTools: (names: string[]) => { active = names; },
    } as any;

    setDcpToolActive(pi, true);
    expect(active).toEqual(["read", "todo", "compress"]);

    // Repeated session starts must not duplicate the schema name.
    setDcpToolActive(pi, true);
    expect(active).toEqual(["read", "todo", "compress"]);
  });

  it("reactivates compress on session_start even if the host previously dropped it from the active set", async () => {
    // Regression: the host only auto-activates a genuinely new tool name when
    // rebuilding its tool registry (e.g. on /reload); a name it has already
    // seen once is not re-added on its own. If a prior process ever excluded
    // "compress" from the active set (a denied/invalid session, a stale
    // capability failure, ...), it must come back on the next session_start,
    // not stay silently unexposed to the model.
    const handlers = new Map<string, (event: any, ctx: any) => unknown>();
    let active = ["read", "todo"];
    const pi = {
      on: (name: string, handler: (event: any, ctx: any) => unknown) => { handlers.set(name, handler); },
      getActiveTools: () => [...active],
      setActiveTools: (names: string[]) => { active = names; },
    } as any;
    const runtime = createRuntime(pi);
    registerLifecycle(pi, runtime);
    const ctx = {
      cwd: "/tmp",
      isProjectTrusted: () => true,
      isIdle: () => true,
      getContextUsage: () => undefined,
      ui: { notify: () => undefined },
      sessionManager: {
        getSessionId: () => "session-1",
        getSessionFile: () => undefined,
        getLeafId: () => null,
        getBranch: () => [],
        buildContextEntries: () => [],
      },
    } as any;

    await handlers.get("session_start")?.({}, ctx);

    expect(runtime.valid).toBe(true);
    expect(active).toContain("compress");
  });

  it.each([
    { name: "early host binding", bindBeforeExecute: true, assistantCopies: 0, succeeds: true },
    { name: "persisted host binding", bindBeforeExecute: true, assistantCopies: 1, succeeds: true },
    { name: "execute-time persisted recovery", bindBeforeExecute: false, assistantCopies: 1, succeeds: true },
    { name: "missing provenance", bindBeforeExecute: false, assistantCopies: 0, succeeds: false },
    { name: "duplicate persisted provenance", bindBeforeExecute: false, assistantCopies: 2, succeeds: false },
    { name: "optional topic", bindBeforeExecute: true, assistantCopies: 0, succeeds: true, omitTopic: true },
  ])("handles compression through $name", async ({ bindBeforeExecute, assistantCopies, succeeds, omitTopic = false }) => {
    const messages = [
      { role: "user", content: "old completed work", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "the old work is complete" }], api: "openai-completions", provider: "openai", model: "model", stopReason: "stop", timestamp: 2 },
      { role: "user", content: "current request", timestamp: 3 },
    ] as any[];
    const entries = messages.map((message, index) => ({ type: "message", id: `entry-${index + 1}`, parentId: index ? `entry-${index}` : null, timestamp: new Date(index + 1).toISOString(), message }));
    let leafId = "entry-3";
    let registered: any;
    const statsDir = await mkdtemp(join(tmpdir(), "pi-dcp-compress-test-"));
    const previousStatsDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = statsDir;
    try {
      const pi = {
        registerTool: (tool: any) => { registered = tool; },
        appendEntry: () => undefined,
        sendMessage: () => undefined,
      } as any;
      const runtime = createRuntime(pi);
      runtime.sessionId = "session-1";
      runtime.generation = 1;
      const ctx = {
        cwd: "/tmp",
        hasUI: false,
        model: { provider: "openai", id: "model", api: "openai-completions", contextWindow: 128_000 },
        getContextUsage: () => ({ tokens: null, contextWindow: 128_000 }),
        ui: { notify: () => undefined, confirm: async () => true },
        sessionManager: {
          buildContextEntries: () => entries,
          getLeafId: () => leafId,
        },
      } as any;
      registerCompressionTool(pi, runtime);
      const transformed = transformOutgoingContext(messages, { ctx, sessionId: runtime.sessionId, generation: runtime.generation, state: emptyState(), config: structuredClone(defaults) as any });
      expect(transformed.snapshot).toBeDefined();
      publishBaseline(runtime, transformed.snapshot!);
      runtime.index = transformed.index;
      runtime.reduced = transformed.state;
      const toolCallId = "compress-call";
      const compressionParams = omitTopic
        ? { content: [{ startId: "m0001", endId: "m0002", summary: "old work was completed and verified" }] }
        : { topic: "old work", content: [{ startId: "m0001", endId: "m0002", summary: "old work was completed and verified" }] };
      // Pi's direct tool hook can run while SessionManager still ends at the
      // request baseline. It remains required for that old ordering, while
      // execute can safely recover a uniquely persisted call if event delivery
      // was missed during reload or asynchronous event draining.
      if (bindBeforeExecute) {
        await bindCompressionProvenance(toolCallId, ctx, runtime);
        expect(runtime.compressionProvenance.get(toolCallId)).toBe(transformed.snapshot);
      }
      for (let copy = 0; copy < assistantCopies; copy++) {
        const entryId = `entry-${4 + copy}`;
        entries.push({ type: "message", id: entryId, parentId: leafId, timestamp: new Date(4 + copy).toISOString(), message: { role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "compress", arguments: compressionParams }], api: "openai-completions", provider: "openai", model: "model", stopReason: "toolUse", timestamp: 4 + copy } } as any);
        leafId = entryId;
      }
      const result = await registered.execute(toolCallId, compressionParams, undefined, undefined, ctx);
      if (succeeds) {
        expect(result.content[0].text).toContain("pi-dcp compressed 1 range(s)");
        expect(result.details.reason).toBeUndefined();
      } else {
        expect(result.content[0].text).toContain("compression_unavailable (extension_disabled)");
        expect(result.content[0].text).toContain("No aliases were published");
        expect(result.details).toMatchObject({ reason: "compression_unavailable", stage: "extension_disabled" });
      }
    } finally {
      if (previousStatsDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousStatsDir;
      await rm(statsDir, { recursive: true, force: true });
    }
  });

  it("never persists a compression envelope the reducer would reject (regression: 2026-08-19 permanent block)", async () => {
    // A rejected envelope must fail closed *before* pi.appendEntry, not
    // after: reconstructFromBranch replays the full persisted branch
    // unconditionally on every resume and restart, so anything appended
    // then rejected corrupts the session forever (compression/tool.ts
    // comment above the dry run explains why). This forces exactly that
    // disagreement without depending on any specific bug: a requestKey the
    // real compress call is about to write is pre-seeded with a mismatched
    // payload hash, which is precisely the condition reduceEnvelope's own
    // idempotency check treats as state_conflict.
    const messages = [
      { role: "user", content: "old completed work", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "the old work is complete" }], api: "openai-completions", provider: "openai", model: "model", stopReason: "stop", timestamp: 2 },
      { role: "user", content: "current request", timestamp: 3 },
    ] as any[];
    const entries = messages.map((message, index) => ({ type: "message", id: `entry-${index + 1}`, parentId: index ? `entry-${index}` : null, timestamp: new Date(index + 1).toISOString(), message }));
    let registered: any;
    const appended: unknown[] = [];
    const statsDir = await mkdtemp(join(tmpdir(), "pi-dcp-fail-closed-test-"));
    const previousStatsDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = statsDir;
    try {
      const pi = {
        registerTool: (tool: any) => { registered = tool; },
        appendEntry: (_customType: string, data: unknown) => { appended.push(data); },
        sendMessage: () => undefined,
      } as any;
      const runtime = createRuntime(pi);
      runtime.sessionId = "session-1";
      runtime.generation = 1;
      const ctx = {
        cwd: "/tmp",
        hasUI: false,
        model: { provider: "openai", id: "model", api: "openai-completions", contextWindow: 128_000 },
        getContextUsage: () => ({ tokens: null, contextWindow: 128_000 }),
        ui: { notify: () => undefined, confirm: async () => true },
        sessionManager: {
          buildContextEntries: () => entries,
          getLeafId: () => "entry-3",
        },
      } as any;
      registerCompressionTool(pi, runtime);
      const transformed = transformOutgoingContext(messages, { ctx, sessionId: runtime.sessionId, generation: runtime.generation, state: emptyState(), config: structuredClone(defaults) as any });
      expect(transformed.snapshot).toBeDefined();
      publishBaseline(runtime, transformed.snapshot!);
      runtime.index = transformed.index;
      runtime.reduced = transformed.state;

      const toolCallId = "compress-call";
      const compressionParams = { topic: "old work", content: [{ startId: "m0001", endId: "m0002", summary: "old work was completed and verified" }] };
      await bindCompressionProvenance(toolCallId, ctx, runtime);

      // Pre-seed the exact requestKey this call is about to compute (same
      // formula as compression/service.ts) with a payload hash that cannot
      // match what buildCompressionEnvelope actually builds - simulating a
      // conflicting entry already present on the branch.
      const requestKey = sha256(`${runtime.sessionId}\0${toolCallId}\0${transformed.snapshot!.hash}`);
      runtime.reduced.requestKeys.set(requestKey, "mismatched-payload-hash");

      const result = await registered.execute(toolCallId, compressionParams, undefined, undefined, ctx);

      expect(result.content[0].text).toContain("pi-dcp: state_conflict");
      expect(result.details).toMatchObject({ reason: "state_conflict" });
      // The whole point: nothing was ever written to the branch, and the live
      // runtime state was never swapped for the rejected dry run.
      expect(appended).toHaveLength(0);
      expect(runtime.reduced.corruptReason).toBeUndefined();
      expect(runtime.generation).toBe(1);

      // The session is not blocked: a normal compress call on a fresh
      // tool-call ID (no colliding requestKey) still succeeds right after.
      const retryEntries = [...entries, { type: "message", id: "entry-4", parentId: "entry-3", timestamp: new Date(4).toISOString(), message: { role: "assistant", content: [{ type: "toolCall", id: "compress-retry", name: "compress", arguments: compressionParams }], api: "openai-completions", provider: "openai", model: "model", stopReason: "toolUse", timestamp: 4 } }];
      entries.push(retryEntries.at(-1)!);
      const retryResult = await registered.execute("compress-retry", compressionParams, undefined, undefined, ctx);
      expect(retryResult.content[0].text).toContain("pi-dcp compressed 1 range(s)");
      expect(appended).toHaveLength(1);
    } finally {
      if (previousStatsDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousStatsDir;
      await rm(statsDir, { recursive: true, force: true });
    }
  });

  it("materializes an automatic nudge on the next agent request", async () => {
    const handlers = new Map<string, (event: any, ctx: any) => unknown>();
    const runtime = createRuntime();
    runtime.generation = 7;
    runtime.reduced.nudges.set("nudge-1", {
      type: "nudge.requested",
      nudgeKey: "nudge-1",
      band: "imperative",
      branchAnchor: "entry-1",
      configGeneration: 7,
      requestedByOpId: "operation-1",
    });
    registerLifecycle({
      on: (name: string, handler: (event: any, ctx: any) => unknown) => { handlers.set(name, handler); },
    } as any, runtime);

    const result = await handlers.get("before_agent_start")?.({ systemPrompt: "base" }, {
      sessionManager: { getBranch: () => [] },
    }) as any;

    expect(result.message).toBeUndefined();
    expect(result.systemPrompt).toContain("Never invent labels");
  });

  it("delivers a nudge after settled pruning advances the runtime generation", async () => {
    const handlers = new Map<string, (event: any, ctx: any) => unknown>();
    const entries = [
      { type: "message", id: "user-1", parentId: null, timestamp: new Date(1).toISOString(), message: { role: "user", content: "first request", timestamp: 1 } },
      { type: "message", id: "assistant-1", parentId: "user-1", timestamp: new Date(2).toISOString(), message: { role: "assistant", content: [{ type: "toolCall", id: "read-old", name: "read", arguments: { path: "/tmp/example" } }], api: "test", provider: "test", model: "model", stopReason: "toolUse", timestamp: 2 } },
      { type: "message", id: "result-1", parentId: "assistant-1", timestamp: new Date(3).toISOString(), message: { role: "toolResult", toolCallId: "read-old", toolName: "read", content: [{ type: "text", text: "old output" }], isError: false, timestamp: 3 } },
      { type: "message", id: "user-2", parentId: "result-1", timestamp: new Date(4).toISOString(), message: { role: "user", content: "second request", timestamp: 4 } },
      { type: "message", id: "assistant-2", parentId: "user-2", timestamp: new Date(5).toISOString(), message: { role: "assistant", content: [{ type: "toolCall", id: "read-new", name: "read", arguments: { path: "/tmp/example" } }], api: "test", provider: "test", model: "model", stopReason: "toolUse", timestamp: 5 } },
      { type: "message", id: "result-2", parentId: "assistant-2", timestamp: new Date(6).toISOString(), message: { role: "toolResult", toolCallId: "read-new", toolName: "read", content: [{ type: "text", text: "new output" }], isError: false, timestamp: 6 } },
      { type: "message", id: "user-3", parentId: "result-2", timestamp: new Date(7).toISOString(), message: { role: "user", content: "current request", timestamp: 7 } },
    ] as any[];
    const appended: any[] = [];
    const statsDir = await mkdtemp(join(tmpdir(), "pi-dcp-nudge-test-"));
    const previousStatsDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = statsDir;
    try {
      const runtime = createRuntime();
      runtime.sessionId = "session-1";
      runtime.generation = 1;
      const pi = {
        appendEntry: (_customType: string, data: unknown) => { appended.push(data); },
        on: (name: string, handler: (event: any, ctx: any) => unknown) => { handlers.set(name, handler); },
      } as any;
      const ctx = {
        cwd: "/tmp",
        model: { provider: "test", id: "model", api: "test", contextWindow: 1_000 },
        getContextUsage: () => ({ tokens: 500, contextWindow: 1_000 }),
        sessionManager: {
          getBranch: () => entries,
          buildContextEntries: () => entries,
          getLeafId: () => "user-3",
        },
      } as any;
      registerLifecycle(pi, runtime);
      runtime.lastReadiness = { ready: true, generation: runtime.generation };

      await handlers.get("agent_settled")?.({}, ctx);

      expect(appended.some((envelope) => envelope.operation?.type === "tools.pruned")).toBe(true);
      expect(runtime.generation).toBe(2);
      const nudge = [...runtime.reduced.nudges.values()][0];
      expect(nudge?.configGeneration).toBe(runtime.generation);

      const result = await handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx) as any;
      expect(result.message).toBeUndefined();
      expect(runtime.pendingNudge?.nudgeKey).toBe(nudge?.nudgeKey);
    } finally {
      if (previousStatsDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousStatsDir;
      await rm(statsDir, { recursive: true, force: true });
    }
  });

  it("schedules a turn nudge below the context threshold when useful savings exist", async () => {
    const handlers = new Map<string, (event: any, ctx: any) => unknown>();
    const entries = [
      { type: "message", id: "user-1", parentId: null, timestamp: new Date(1).toISOString(), message: { role: "user", content: "old request", timestamp: 1 } },
      { type: "message", id: "assistant-1", parentId: "user-1", timestamp: new Date(2).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "x".repeat(64000) }], api: "test", provider: "test", model: "model", stopReason: "stop", timestamp: 2 } },
      { type: "message", id: "user-2", parentId: "assistant-1", timestamp: new Date(3).toISOString(), message: { role: "user", content: "current request", timestamp: 3 } },
    ] as any[];
    const appended: any[] = [];
    const runtime = createRuntime();
    runtime.sessionId = "session-semantic";
    runtime.generation = 1;
    runtime.semanticUserTurnsSinceCompression = 5;
    runtime.semanticIterationsSinceUserTurn = 1;
    runtime.semanticUserTurnsSinceNudge = 5;
    runtime.semanticIterationsSinceNudge = 1;
    runtime.lastSeenUserUnitKey = "user-2";
    const pi = {
      appendEntry: (_customType: string, data: unknown) => { appended.push(data); },
      on: (name: string, handler: (event: any, ctx: any) => unknown) => { handlers.set(name, handler); },
    } as any;
    const ctx = {
      cwd: "/tmp",
      model: { provider: "test", id: "model", api: "test", contextWindow: 100_000 },
      getContextUsage: () => ({ tokens: 1_000, contextWindow: 100_000 }),
      sessionManager: {
        getBranch: () => entries,
        buildContextEntries: () => entries,
        getLeafId: () => "user-2",
      },
    } as any;
    registerLifecycle(pi, runtime);
    runtime.lastReadiness = { ready: true, generation: runtime.generation };

    await handlers.get("agent_settled")?.({}, ctx);

    const nudge = appended.find((envelope) => envelope.operation?.type === "nudge.requested");
    expect(nudge?.operation).toMatchObject({ kind: "turn", band: "soft" });
    expect(runtime.lastNudgeEvaluation?.decision).toMatchObject({ kind: "turn", type: "soft" });
    expect(runtime.pendingNudge).toMatchObject({ kind: "turn", band: "soft" });
  });

  it("does not schedule semantic nudges when the context transform is unavailable", async () => {
    const handlers = new Map<string, (event: any, ctx: any) => unknown>();
    const entries = [
      { type: "message", id: "user-1", parentId: null, timestamp: new Date(1).toISOString(), message: { role: "user", content: "old request", timestamp: 1 } },
      { type: "message", id: "assistant-1", parentId: "user-1", timestamp: new Date(2).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "x".repeat(64000) }], api: "test", provider: "test", model: "model", stopReason: "stop", timestamp: 2 } },
      { type: "message", id: "user-2", parentId: "assistant-1", timestamp: new Date(3).toISOString(), message: { role: "user", content: "current request", timestamp: 3 } },
    ] as any[];
    const appended: any[] = [];
    const runtime = createRuntime();
    runtime.sessionId = "session-ambiguous";
    runtime.generation = 1;
    runtime.semanticUserTurnsSinceCompression = 5;
    runtime.semanticIterationsSinceUserTurn = 15;
    runtime.semanticUserTurnsSinceNudge = 5;
    runtime.semanticIterationsSinceNudge = 15;
    runtime.lastReadiness = { ready: false, reason: "join_ambiguous", generation: 1 };
    const pi = {
      appendEntry: (_customType: string, data: unknown) => { appended.push(data); },
      on: (name: string, handler: (event: any, ctx: any) => unknown) => { handlers.set(name, handler); },
    } as any;
    const ctx = {
      cwd: "/tmp",
      model: { provider: "test", id: "model", api: "test", contextWindow: 100_000 },
      getContextUsage: () => ({ tokens: 1_000, contextWindow: 100_000 }),
      sessionManager: {
        getBranch: () => entries,
        buildContextEntries: () => entries,
        getLeafId: () => "user-2",
      },
    } as any;
    registerLifecycle(pi, runtime);

    await handlers.get("agent_settled")?.({}, ctx);

    expect(appended.some((envelope) => envelope.operation?.type === "nudge.requested")).toBe(false);
  });

  it("reports compression_unavailable, not baseline_unavailable, when readiness is stale for the current generation", async () => {
    // onSettled deliberately leaves lastReadiness.ready untouched when a
    // settled pruning mutation bumps runtime.generation (nudge delivery in
    // that same cycle relies on the pre-bump ready flag). The compress tool
    // must still detect that staleness itself by comparing generations,
    // rather than trusting a "ready: true" that no longer matches reality.
    const messages = [
      { role: "user", content: "old completed work", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "the old work is complete" }], api: "openai-completions", provider: "openai", model: "model", stopReason: "stop", timestamp: 2 },
      { role: "user", content: "current request", timestamp: 3 },
    ] as any[];
    const entries = messages.map((message, index) => ({ type: "message", id: `entry-${index + 1}`, parentId: index ? `entry-${index}` : null, timestamp: new Date(index + 1).toISOString(), message }));
    let registered: any;
    const statsDir = await mkdtemp(join(tmpdir(), "pi-dcp-stale-readiness-test-"));
    const previousStatsDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = statsDir;
    try {
      const pi = {
        registerTool: (tool: any) => { registered = tool; },
        appendEntry: () => undefined,
      } as any;
      const runtime = createRuntime(pi);
      runtime.sessionId = "session-1";
      runtime.generation = 1;
      const ctx = {
        cwd: "/tmp",
        hasUI: false,
        model: { provider: "openai", id: "model", api: "openai-completions", contextWindow: 128_000 },
        getContextUsage: () => ({ tokens: null, contextWindow: 128_000 }),
        ui: { notify: () => undefined, confirm: async () => true },
        sessionManager: {
          buildContextEntries: () => entries,
          getLeafId: () => "entry-3",
        },
      } as any;
      registerCompressionTool(pi, runtime);
      const transformed = transformOutgoingContext(messages, { ctx, sessionId: runtime.sessionId, generation: runtime.generation, state: emptyState(), config: structuredClone(defaults) as any });
      expect(transformed.snapshot).toBeDefined();
      publishBaseline(runtime, transformed.snapshot!);
      runtime.index = transformed.index;
      runtime.reduced = transformed.state;
      runtime.lastReadiness = { ready: true, adapterId: "openai-completions", generation: runtime.generation };

      // Simulate the settled-time pruning mutation: generation advances and
      // baselines are cleared, but lastReadiness is left as-is (still true,
      // still tagged with the old generation).
      runtime.generation++;
      clearBaselines(runtime);

      const toolCallId = "compress-call";
      const result = await registered.execute(toolCallId, { topic: "old work", content: [{ startId: "m0001", endId: "m0002", summary: "old work was completed and verified" }] }, undefined, undefined, ctx);

      expect(result.content[0].text).toContain("compression_unavailable (state_invalidated)");
      expect(result.details).toMatchObject({ reason: "compression_unavailable", stage: "state_invalidated" });
    } finally {
      if (previousStatsDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousStatsDir;
      await rm(statsDir, { recursive: true, force: true });
    }
  });

  it("injects no nudge message when the runtime is invalid", async () => {
    // A not-ready runtime has no labels to publish, so the nudge line is
    // omitted entirely rather than broadcasting an "unavailable" reason every
    // turn - its absence is itself the signal (SYSTEM_GUIDANCE: "do not call
    // compress if no labels are visible"). A compress call attempted anyway
    // still gets a normal, explanatory tool-call failure from compression/tool.ts.
    const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
    const runtime = createRuntime();
    const pi = { on: (name: string, handler: (event: any, ctx: any) => Promise<any>) => { handlers.set(name, handler); } } as any;
    registerLifecycle(pi, runtime);
    runtime.valid = false;
    runtime.lastReadiness = { ready: false, reason: "capability_missing", generation: runtime.generation };
    const ctx = { model: { provider: "test", id: "model", api: "test", contextWindow: 1000 }, getContextUsage: () => ({ tokens: null, contextWindow: 1000 }), sessionManager: { buildContextEntries: () => [], getLeafId: () => null } } as any;

    const result = await handlers.get("context")?.({ messages: [{ role: "user", content: "hi", timestamp: 1 } as any] }, ctx) as any;

    const nudge = result.messages.find((message: any) => message.role === "custom" && message.customType === "pi-dcp.v2.nudge");
    expect(nudge).toBeUndefined();
  });

  it("records and deduplicates loud transform failures", async () => {
    const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
    const notices: string[] = [];
    const diagnostics: any[] = [];
    const runtime = createRuntime();
    runtime.logger = { diagnostic: (diagnostic: any) => diagnostics.push(diagnostic) };
    const pi = { on: (name: string, handler: (event: any, ctx: any) => Promise<any>) => { handlers.set(name, handler); } } as any;
    registerLifecycle(pi, runtime);
    const ctx = { ui: { notify: (text: string) => notices.push(text) }, model: { provider: "test", id: "model", api: "test", contextWindow: 1000 }, getContextUsage: () => ({ tokens: null, contextWindow: 1000 }), sessionManager: { buildContextEntries: () => [{ type: "unknown", id: "bad", parentId: null, timestamp: new Date(1).toISOString() }], getLeafId: () => null } } as any;
    await handlers.get("context")?.({ messages: [] }, ctx);
    await handlers.get("context")?.({ messages: [] }, ctx);
    expect(runtime.lastReadiness).toMatchObject({ ready: false, reason: "projection_unsupported" });
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toMatchObject({ reason: "projection_unsupported" });
    expect(notices).toEqual(["pi-dcp: context transform disabled: projection_unsupported"]);
  });

  it("does not inject transient nudges during context transformation", () => {
    const message = { role: "user", content: "A sufficiently established conversation", timestamp: 1 } as const;
    const entry = { type: "message", id: "message-1", parentId: null, timestamp: new Date(1).toISOString(), message };
    const config = structuredClone(defaults);
    const ctx = {
      model: { provider: "test", id: "model", api: "test", contextWindow: 1_000 },
      getContextUsage: () => ({ tokens: 400, contextWindow: 1_000 }),
      sessionManager: {
        buildContextEntries: () => [entry],
        getLeafId: () => "message-1",
      },
    } as any;

    const result = transformOutgoingContext([message] as any, {
      ctx,
      sessionId: "session-1",
      generation: 1,
      state: emptyState(),
      config,
      turnCount: 1,
    });

    expect(result.nudged).toBeUndefined();
    expect(result.messages.some((item) => item.role === "custom" && item.customType === "pi-dcp.nudge")).toBe(false);
    expect(result.messages.some((item) => item.role === "custom" && item.customType === "pi-dcp.metadata")).toBe(false);
    expect(result.messages.some((item) => item.role === "custom" && item.customType === "pi-dcp.v2.unit")).toBe(false);
    expect(result.messages.some((item) => item.role === "user" && String(item.content).includes("pi-dcp-message-id"))).toBe(true);
  });
});
