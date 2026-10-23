import { describe, expect, it, vi } from "vitest";
import { buildSessionProjection } from "@earendil-works/pi-coding-agent";
import { registerLifecycle } from "../../src/lifecycle.ts";
import { registerCompressionTool } from "../../src/compression/tool.ts";
import { createRuntime } from "../../src/runtime.ts";
import { DCP_SYSTEM_SECTION } from "../../src/prompts/defaults.ts";
import { handleDcp } from "../../src/commands/index.ts";

function setup() {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  let active = ["read", "compress", "todo"];
  let tool: any;
  const pi = {
    on: (name: string, handler: any) => handlers.set(name, handler),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active = names; },
    registerTool: (value: any) => { tool = value; },
    appendEntry: vi.fn(), sendMessage: vi.fn(), sendUserMessage: vi.fn(),
  } as any;
  const runtime = createRuntime(pi);
  runtime.config.disabledModels = ["test/disabled"];
  runtime.sessionId = "model-test";
  registerLifecycle(pi, runtime);
  registerCompressionTool(pi, runtime);
  const message = { role: "user", content: "current request", timestamp: 1 };
  const entry = { type: "message", id: "user-1", parentId: null, timestamp: new Date(1).toISOString(), message };
  const ctx = {
    model: { provider: "test", id: "enabled", api: "test", contextWindow: 100_000 },
    cwd: "/tmp", getContextUsage: () => ({ tokens: 95_000, contextWindow: 100_000 }),
    sessionManager: {
      buildSessionProjection: () => buildSessionProjection([entry] as any, "user-1"),
      getLeafId: () => "user-1", getBranch: vi.fn(() => [entry]),
    },
    ui: { notify: vi.fn() },
  } as any;
  const fire = (name: string, event: any = {}) => handlers.get(name)!(event, ctx);
  const select = (id: string) => { ctx.model = { ...ctx.model, id }; return fire("model_select", { model: ctx.model }); };
  return { runtime, pi, ctx, message, fire, select, active: () => active, tool: () => tool };
}

describe("model-specific disable", () => {
  it.each([
    { reason: "threshold", cancel: true },
    { reason: "manual", cancel: false },
    { reason: "overflow", cancel: false },
    { reason: "overflow", willRetry: true, cancel: false },
    { reason: "future-reason", cancel: false },
  ])("handles native $reason compaction (willRetry=$willRetry)", async ({ reason, willRetry, cancel }) => {
    const h = setup();
    await h.fire("context", { messages: [h.message] });
    expect(h.runtime.lastReadiness?.ready).toBe(true);
    h.runtime.pendingNudge = { band: "critical", nudgeKey: "old-request" };
    const generation = h.runtime.generation;
    const reduced = h.runtime.reduced;

    expect(await h.fire("session_before_compact", { reason, willRetry })).toEqual(cancel ? { cancel: true } : undefined);
    expect(h.runtime.generation).toBeGreaterThan(generation);
    expect(h.runtime.lastReadiness?.ready).toBe(false);
    expect(h.runtime.pendingNudge).toBeUndefined();
    expect(h.runtime.reduced).toBe(reduced);
    expect(h.pi.appendEntry).not.toHaveBeenCalled();
  });

  it("uses live model/config/health policy without changing shared Pi settings", async () => {
    const h = setup();
    const threshold = () => h.fire("session_before_compact", { reason: "threshold" });
    expect(await threshold()).toEqual({ cancel: true });
    await h.select("disabled");
    expect(await threshold()).toBeUndefined();
    await h.select("enabled");
    expect(await threshold()).toEqual({ cancel: true });

    // No model event: configuration and health are checked at the hook itself.
    h.runtime.config.enabled = false;
    expect(await threshold()).toBeUndefined();
    h.runtime.config.enabled = true;
    h.runtime.config.disabledModels.push("test/enabled");
    expect(await threshold()).toBeUndefined();
    h.runtime.config.disabledModels = [];
    h.runtime.valid = false;
    expect(await threshold()).toBeUndefined();
    h.runtime.valid = true;
    h.runtime.mutationBlocked = true;
    expect(await threshold()).toBeUndefined();
    h.runtime.mutationBlocked = false;
    h.ctx.model = undefined;
    expect(await threshold()).toBeUndefined();
    // The harness deliberately exposes no settings writer. Routing needs only
    // the public cancellation hook, never a persisted global-setting toggle.
  });

  it("switches from transformed context to raw context and back without losing state", async () => {
    const h = setup();
    const sections: Record<string, string> = { other: "keep" };
    await h.fire("before_agent_start", { systemPromptOptions: { sections } });
    expect(sections[DCP_SYSTEM_SECTION]).toBeTruthy();
    const enabled = await h.fire("context", { messages: [h.message] });
    expect(enabled.messages).not.toEqual([h.message]);
    expect(h.runtime.lastReadiness?.ready).toBe(true);
    const reduced = h.runtime.reduced;
    h.runtime.pendingNudge = { band: "critical", kind: "context", nudgeKey: "pending" };

    await h.select("disabled");
    expect(h.active()).toEqual(["read", "todo"]);
    expect(h.runtime.pendingNudge).toBeUndefined();
    await h.fire("before_agent_start", { systemPromptOptions: { sections } });
    expect(sections).toEqual({ other: "keep" });
    const raw = await h.fire("context", { messages: [h.message] });
    expect(raw.messages).toEqual([h.message]);
    expect(raw.messages[0]).toBe(h.message);
    expect(h.runtime.lastOutgoingContext?.dcpEnabled).toBe(false);
    await h.fire("agent_settled");
    expect(h.ctx.sessionManager.getBranch).not.toHaveBeenCalled();
    expect(h.pi.appendEntry).not.toHaveBeenCalled();
    expect(h.runtime.reduced).toBe(reduced);
    expect(h.runtime.valid).toBe(true);

    await h.select("enabled");
    expect(h.active()).toEqual(["read", "todo", "compress"]);
    await h.fire("before_agent_start", { systemPromptOptions: { sections } });
    expect(sections[DCP_SYSTEM_SECTION]).toBeTruthy();
    await h.fire("context", { messages: [h.message] });
    expect(h.runtime.lastReadiness?.ready).toBe(true);
  });

  it("blocks direct tool calls and manual mutations even if activation was bypassed", async () => {
    const h = setup();
    // Do not emit model_select: execution must enforce the policy itself.
    h.ctx.model.id = "disabled";
    const result = await h.tool().execute("call-1", { content: [{ startId: "m0001", endId: "m0002", summary: "summary" }] }, undefined, undefined, h.ctx);
    expect(result.details).toMatchObject({ reason: "compression_unavailable", stage: "extension_disabled" });
    for (const command of ["compress", "sweep", "manual on", "decompress", "recompress"]) {
      await handleDcp(command, h.ctx, h.pi, h.runtime);
    }
    expect(h.pi.appendEntry).not.toHaveBeenCalled();
    expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
    await handleDcp("status", h.ctx, h.pi, h.runtime);
    expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("pi-dcp disabled"), "info");
  });

  it("does not revive unhealthy runtimes or override deny permission on a model switch", async () => {
    const h = setup();
    h.runtime.valid = false;
    await h.select("enabled");
    expect(h.runtime.valid).toBe(false);
    expect(h.active()).not.toContain("compress");
    h.runtime.valid = true;
    h.runtime.config.compress.permission = "deny";
    await h.select("enabled");
    expect(h.active()).not.toContain("compress");
  });
});
