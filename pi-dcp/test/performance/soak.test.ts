import { describe, expect, it } from "vitest";
import { registerLifecycle } from "../../src/lifecycle.ts";
import { createRuntime } from "../../src/runtime.ts";

describe("nudge/cache soak", () => {
  it("keeps the transformed prefix stable across repeated turns", async () => {
    const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
    const pi = { on: (name: string, handler: (event: any, ctx: any) => Promise<any>) => { handlers.set(name, handler); } } as any;
    const runtime = createRuntime(pi);
    registerLifecycle(pi, runtime);
    runtime.sessionId = "soak";
    const entries: any[] = [];
    const messages: any[] = [];
    let previousBody: any[] | undefined;
    const started = performance.now();
    for (let turn = 0; turn < 50; turn++) {
      const message = { role: "user", content: `turn ${turn}`, timestamp: turn + 1 };
      messages.push(message);
      entries.push({ type: "message", id: `entry-${turn + 1}`, parentId: turn ? `entry-${turn}` : null, timestamp: new Date(turn + 1).toISOString(), message });
      const ctx = { cwd: "/tmp", model: { provider: "test", id: "model", api: "test", contextWindow: 100_000 }, getContextUsage: () => ({ tokens: null, contextWindow: 100_000 }), sessionManager: { buildContextEntries: () => entries, getLeafId: () => `entry-${turn + 1}` }, ui: { notify: () => undefined } } as any;
      const transformed = await handlers.get("context")?.({ messages: [...messages] }, ctx);
      // No nudge is ever pending in this soak, so pi-dcp must add NO message
      // of its own on any of the 50 turns. This is the invariant the redesign
      // bought: an ordinary request carries zero fabricated turns, so the
      // whole transformed array is a strictly growing, byte-stable prefix and
      // the provider cache breakpoint never has to be relocated off a tail
      // that changes every request (see prompts/nudge.ts).
      const hasNudge = transformed.messages.some((message: any) => message.customType === "pi-dcp.v2.nudge");
      expect(hasNudge).toBe(false);
      const body = transformed.messages;
      if (previousBody) expect(body.slice(0, previousBody.length)).toEqual(previousBody);
      previousBody = body;
    }
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(0);
  });
});
