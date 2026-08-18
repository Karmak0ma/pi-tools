import { describe, expect, it } from "vitest";
import { SYSTEM_GUIDANCE } from "../../src/prompts/defaults.ts";
import { registerCompressionTool } from "../../src/compression/tool.ts";
import { createRuntime } from "../../src/runtime.ts";

describe("compression prompts", () => {
  it("teaches visible labels, complete units, and safe selection", () => {
    expect(SYSTEM_GUIDANCE).toContain("closed");
    expect(SYSTEM_GUIDANCE).toContain("Never invent");
    expect(SYSTEM_GUIDANCE).toContain("do not call compress");
    expect(SYSTEM_GUIDANCE).toContain("inspect the session file");
    expect(SYSTEM_GUIDANCE).toContain("BLOCKED");
    expect(SYSTEM_GUIDANCE).toContain("protocol unit");
    expect(SYSTEM_GUIDANCE).toContain("whole units");
  });

  it("keeps tool guidance aligned with the prompt", () => {
    let registered: any;
    registerCompressionTool({ registerTool: (tool: unknown) => { registered = tool; } } as any, createRuntime());
    expect(registered.description).toContain("Never invent");
    expect(registered.description).toContain("do not call this tool");
    expect(registered.description).toContain("exhaustive");
    expect(registered.description).toContain("user intent");
    expect(registered.description).toContain("(bNNNN)");
    expect(registered.description).toContain("Preflight check");
  });
});
