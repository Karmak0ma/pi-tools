import { describe, expect, it } from "vitest";
import { registerLifecycle } from "../../src/lifecycle.ts";
import { createRuntime } from "../../src/runtime.ts";

describe("status/cache soak", () => {
  it("keeps the transformed prefix stable across repeated turns", async () => {
    const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
    const pi = { on: (name: string, handler: (event: any, ctx: any) => Promise<any>) => { handlers.set(name, handler); } } as any;
    const runtime = createRuntime(pi);
    registerLifecycle(pi, runtime);
    runtime.sessionId = "soak";
    const entries: any[] = [];
    const messages: any[] = [];
    let previous: any[] | undefined;
    const started = performance.now();
    for (let turn = 0; turn < 50; turn++) {
      const message = { role: "user", content: `turn ${turn}`, timestamp: turn + 1 };
      messages.push(message);
      entries.push({ type: "message", id: `entry-${turn + 1}`, parentId: turn ? `entry-${turn}` : null, timestamp: new Date(turn + 1).toISOString(), message });
      const ctx = { cwd: "/tmp", model: { provider: "test", id: "model", api: "test", contextWindow: 100_000 }, getContextUsage: () => ({ tokens: null, contextWindow: 100_000 }), sessionManager: { buildContextEntries: () => entries, getLeafId: () => `entry-${turn + 1}` }, ui: { notify: () => undefined } } as any;
      const transformed = await handlers.get("context")?.({ messages: [...messages] }, ctx);
      expect(transformed.messages.at(-1).customType).toBe("pi-dcp.v2.status");
      if (previous) expect(transformed.messages.slice(0, previous.length - 1)).toEqual(previous.slice(0, -1));
      previous = transformed.messages;
    }
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(0);
  });
});
