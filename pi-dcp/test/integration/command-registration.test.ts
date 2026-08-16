import { describe, expect, it } from "vitest";
import piDcp from "../../src/index.ts";
import { handleDcp } from "../../src/commands/index.ts";
import { createRuntime } from "../../src/runtime.ts";

describe("command registration", () => {
  it("registers /dcp even when the optional runtime surface is unavailable", () => {
    const commands: string[] = [];
    let options: any;
    piDcp({ registerCommand: (name: string, registered: unknown) => { commands.push(name); options = registered; } } as any);
    expect(commands).toEqual(["dcp"]);
    expect(options.getArgumentCompletions("co")).toEqual([{ value: "context", label: "context", description: "show context usage" }, { value: "compress", label: "compress", description: "request model-authored compression" }]);
  });

  it("registers compress before optional lifecycle capabilities are checked", () => {
    const tools: string[] = [];
    piDcp({
      registerCommand: () => undefined,
      registerTool: (tool: { name: string }) => { tools.push(tool.name); },
    } as any);

    expect(tools).toEqual(["compress"]);
  });

  it("turns /dcp compress into a real model-visible user request", async () => {
    const sent: Array<{ text: string; options: unknown }> = [];
    const pi = {
      sendUserMessage: (text: string, options?: unknown) => { sent.push({ text, options }); },
    } as any;
    const runtime = createRuntime(pi);
    const ctx = {
      isIdle: () => true,
      ui: { notify: () => undefined },
    } as any;

    await handleDcp("compress preserve decisions", ctx, pi, runtime);

    expect(sent).toEqual([{
      text: "Please perform one faithful pi-dcp compression now using the current local aliases. Focus: preserve decisions",
      options: undefined,
    }]);
  });
});
