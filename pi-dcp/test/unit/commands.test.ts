import { describe, expect, it } from "vitest";
import { debugCommand } from "../../src/commands/debug.ts";
import { contextCommand } from "../../src/commands/context.ts";
import { createRuntime } from "../../src/runtime.ts";

describe("diagnostic commands", () => {
  it("reports version, model, adapter, and readiness", async () => {
    const notices: string[] = [];
    const runtime = createRuntime();
    runtime.lastModel = { provider: "openai-codex", id: "gpt-5.6-luna", api: "openai-codex-responses", contextWindow: 1000 };
    runtime.lastReadiness = { ready: false, reason: "join_ambiguous", generation: 1 };
    const ctx = { getContextUsage: () => undefined, ui: { notify: (text: string) => notices.push(text) } } as any;
    const pi = { getActiveTools: () => ["read", "compress"] } as any;
    await debugCommand(ctx, pi, runtime);
    await contextCommand(ctx, runtime);
    expect(notices[0]).toContain("runtime version:       0.2.0");
    expect(notices[0]).toContain("openai-codex/gpt-5.6-luna");
    expect(notices[0]).toContain("openai-codex-responses");
    expect(notices[0]).toContain("unavailable (join_ambiguous)");
    expect(notices[0]).toContain("compress tool exposed: yes");
    expect(notices[1]).toContain("compression: unavailable (join_ambiguous)");
  });

  it("reports the compress tool as not exposed when the host's active-tool list excludes it", async () => {
    // Ground truth, independent of what the model may claim: this is what
    // `pi.getActiveTools()` actually reports for the next turn.
    const notices: string[] = [];
    const runtime = createRuntime();
    const ctx = { getContextUsage: () => undefined, ui: { notify: (text: string) => notices.push(text) } } as any;
    const pi = { getActiveTools: () => ["read"] } as any;
    await debugCommand(ctx, pi, runtime);
    expect(notices[0]).toContain("compress tool exposed: no");
  });
});
