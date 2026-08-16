import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkContextCapabilities, checkFactoryCapabilities } from "../../src/capabilities.ts";
import { bindCompressionProvenance, registerCompressionTool } from "../../src/compression/tool.ts";
import { createRuntime, publishBaseline, setDcpToolActive } from "../../src/runtime.ts";
import { defaults } from "../../src/config/defaults.ts";
import { emptyState } from "../../src/state/reducer.ts";
import { transformOutgoingContext } from "../../src/transform/pipeline.ts";
import { registerLifecycle } from "../../src/lifecycle.ts";

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

  it.each([
    { name: "early host binding", bindBeforeExecute: true, assistantCopies: 0, succeeds: true },
    { name: "persisted host binding", bindBeforeExecute: true, assistantCopies: 1, succeeds: true },
    { name: "execute-time persisted recovery", bindBeforeExecute: false, assistantCopies: 1, succeeds: true },
    { name: "missing provenance", bindBeforeExecute: false, assistantCopies: 0, succeeds: false },
    { name: "duplicate persisted provenance", bindBeforeExecute: false, assistantCopies: 2, succeeds: false },
  ])("handles compression through $name", async ({ bindBeforeExecute, assistantCopies, succeeds }) => {
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
        entries.push({ type: "message", id: entryId, parentId: leafId, timestamp: new Date(4 + copy).toISOString(), message: { role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "compress", arguments: { topic: "old work", content: [{ startId: "m0001", endId: "m0002", summary: "old work was completed and verified" }] } }], api: "openai-completions", provider: "openai", model: "model", stopReason: "toolUse", timestamp: 4 + copy } } as any);
        leafId = entryId;
      }
      const result = await registered.execute(toolCallId, { topic: "old work", content: [{ startId: "m0001", endId: "m0002", summary: "old work was completed and verified" }] }, undefined, undefined, ctx);
      if (succeeds) {
        expect(result.content[0].text).toContain("pi-dcp compressed 1 range(s)");
        expect(result.details.reason).toBeUndefined();
      } else {
        expect(result.content[0].text).toContain("baseline_unavailable (assistant_provenance_missing)");
        expect(result.details).toMatchObject({ reason: "baseline_unavailable", stage: "assistant_provenance_missing" });
      }
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

    expect(result.message).toMatchObject({
      customType: "pi-dcp.v2.nudge",
      display: false,
      details: { nudgeKey: "nudge-1", band: "imperative", configGeneration: 7 },
    });
    expect(result.message.content).toContain("compress");
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

      await handlers.get("agent_settled")?.({}, ctx);

      expect(appended.some((envelope) => envelope.operation?.type === "tools.pruned")).toBe(true);
      expect(runtime.generation).toBe(2);
      const nudge = [...runtime.reduced.nudges.values()][0];
      expect(nudge?.configGeneration).toBe(runtime.generation);

      const result = await handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx) as any;
      expect(result.message).toMatchObject({
        customType: "pi-dcp.v2.nudge",
        display: false,
        details: { nudgeKey: nudge?.nudgeKey, band: "soft", configGeneration: 2 },
      });
    } finally {
      if (previousStatsDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousStatsDir;
      await rm(statsDir, { recursive: true, force: true });
    }
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
    expect(result.messages.some((item) => item.role === "custom" && item.customType === "pi-dcp.v2.unit")).toBe(true);
  });
});
