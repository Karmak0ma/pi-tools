import { describe, expect, it } from "vitest";
import { checkFactoryCapabilities } from "../../src/capabilities.ts";
import { registerCompressionTool } from "../../src/compression/tool.ts";
import { createRuntime, setDcpToolActive } from "../../src/runtime.ts";
import { defaults } from "../../src/config/defaults.ts";
import { emptyState } from "../../src/state/reducer.ts";
import { transformOutgoingContext } from "../../src/transform/pipeline.ts";

describe("extension capability gate", () => {
  it("requires the mutation surface before registering behavior", () => { const result = checkFactoryCapabilities({} as any); expect(result.ok).toBe(false); expect(result.missing).toContain("appendEntry"); });

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

  it("inserts a nudge once the context threshold is reached", () => {
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

    expect(result.nudged).toBe(true);
    expect(result.messages.some((item) => item.role === "custom" && item.customType === "pi-dcp.nudge")).toBe(true);
    expect(result.messages.some((item) => item.role === "custom" && item.customType === "pi-dcp.metadata")).toBe(true);
  });
});
