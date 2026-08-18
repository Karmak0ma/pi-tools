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

  it("gates manual compression when readiness is unavailable for a known reason", async () => {
    const sent: string[] = [];
    const notices: string[] = [];
    const pi = { sendUserMessage: (text: string) => { sent.push(text); } } as any;
    const runtime = createRuntime(pi);
    const ctx = { isIdle: () => true, ui: { notify: (text: string) => { notices.push(text); } } } as any;
    await handleDcp("compress", ctx, pi, runtime);
    expect(sent).toEqual([]);
    expect(notices[0]).toContain("compression unavailable");
  });

  it("gates manual compression on a genuine pipeline failure reason", async () => {
    const sent: string[] = [];
    const notices: string[] = [];
    const pi = { sendUserMessage: (text: string) => { sent.push(text); } } as any;
    const runtime = createRuntime(pi);
    runtime.lastReadiness = { ready: false, reason: "join_ambiguous", generation: runtime.generation };
    const ctx = { isIdle: () => true, ui: { notify: (text: string) => { notices.push(text); } } } as any;
    await handleDcp("compress", ctx, pi, runtime);
    expect(sent).toEqual([]);
    expect(notices[0]).toContain("join_ambiguous");
  });

  it("does not gate manual compression on the neutral pre-turn state_invalidated reason", async () => {
    // state_invalidated only means "no context transform has run since the
    // last reset" — it is the default right after session start/resume, not
    // evidence of a broken pipeline. The manual command must let the request
    // through so the upcoming turn's own context transform can establish
    // (or fail) readiness for real.
    const sent: string[] = [];
    const notices: string[] = [];
    const pi = { sendUserMessage: (text: string, options?: unknown) => { sent.push(text); } } as any;
    const runtime = createRuntime(pi);
    runtime.lastReadiness = { ready: false, reason: "state_invalidated", generation: runtime.generation };
    const ctx = { isIdle: () => true, ui: { notify: (text: string) => { notices.push(text); } } } as any;
    await handleDcp("compress", ctx, pi, runtime);
    expect(sent).toHaveLength(1);
    expect(notices).toEqual([]);
  });

  it("turns /dcp compress into a real model-visible user request", async () => {
    const sent: Array<{ text: string; options: unknown }> = [];
    const pi = {
      sendUserMessage: (text: string, options?: unknown) => { sent.push({ text, options }); },
    } as any;
    const runtime = createRuntime(pi);
    runtime.lastReadiness = { ready: true, generation: runtime.generation };
    const ctx = {
      isIdle: () => true,
      ui: { notify: () => undefined },
    } as any;

    await handleDcp("compress preserve decisions", ctx, pi, runtime);

    expect(sent).toEqual([{
      text: "Perform exactly one pi-dcp compression pass now.\n\nChoose one or more older, resolved ranges from the visible conversation only. Use only current visible mNNNN or bNNNN labels; do not inspect the session file and do not invent IDs. Keep the latest user intent, active work, unresolved questions, pending tool exchanges, and protected content out of the selected range. Write an exhaustive technical summary preserving decisions, constraints, paths, findings, and verification evidence. If no safe visible labels are available, do not call compress and report that compression is unavailable. Focus: preserve decisions",
      options: undefined,
    }]);
  });
});
