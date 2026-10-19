/** Exercise the real Pi adapter: manager-only tests cannot catch lost async
 * notifications, missing blocking ids or unregistered failure handling. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import extension from "./index.js";
import * as backends from "./backends.js";
import * as agents from "./agents.js";
import * as resolver from "./resolver.js";
import { emptyUsage } from "./types.js";

describe("subagent continuation tool", () => {
  it("returns usable ids and delivers blocking, async and fallback follow-ups", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "continuation-tool-"));
    const source = path.join(dir, "session.jsonl");
    fs.copyFileSync(new URL("./fixtures/real-pi-session.jsonl", import.meta.url), source);
    const specs: backends.SubagentSpec[] = [];
    vi.spyOn(backends, "createBackend").mockReturnValue({
      async spawn(spec) {
        specs.push(spec);
        return {
          result: Promise.resolve({
            exitCode: 0, lifecycle: "completed", stopReason: "stop",
            finalOutput: `answer ${specs.length}`, usage: emptyUsage(), toolCalls: [], sessionFile: source,
          }),
        };
      },
    });
    vi.spyOn(agents, "discoverAgents").mockReturnValue({
      agents: [{ name: "worker", description: "", source: "builtin", systemPrompt: "", tools: ["read"] }],
      projectAgentsDir: null, userAgentsDir: dir,
    });
    vi.spyOn(resolver, "buildToolResolutionOptions").mockReturnValue({});
    const tools = new Map<string, any>();
    const hooks = new Map<string, any>();
    const sendMessage = vi.fn();
    extension({
      registerTool: (tool: any) => tools.set(tool.name, tool),
      on: (event: string, fn: any) => hooks.set(event, fn),
      registerShortcut: () => {},
      getActiveTools: () => ["read"],
      sendMessage,
    } as any);
    const ctx = {
      cwd: dir, mode: "tui", sessionManager: { getSessionDir: () => dir },
      model: { provider: "test", id: "model" }, modelRegistry: { getAvailable: async () => [] },
    };
    const call = (name: string, params: any, context = ctx) =>
      tools.get(name).execute("test-call", params, undefined, undefined, context);
    try {
      const first = await call("subagent", { tasks: [{ agent: "worker", task: "first" }], async: true });
      const [firstId] = first.details.taskIds;
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
      const second = await call("subagent_continue", { taskId: firstId, task: "second" });
      const [secondId] = second.details.taskIds;
      expect(secondId).not.toBe(firstId);
      expect(second.content[0].text).toContain(secondId);
      expect(second.content[0].text).toContain("answer 2");
      expect(specs[1].continueFrom).toBeDefined();
      expect(specs[1].continueFrom).not.toBe(source);
      expect(fs.readFileSync(specs[1].continueFrom!, "utf8")).toBe(fs.readFileSync(source, "utf8"));

      const third = await call("subagent_continue", { taskId: secondId, task: "third", async: true });
      expect(third.details.background).toBe(true);
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
      // The background notification must identify this request, not its
      // ancestor; the parent needs that id for its next follow-up.
      expect(sendMessage.mock.calls[1][0].details.taskIds).toEqual(third.details.taskIds);
      expect(sendMessage.mock.calls[1][0].content).toContain("answer 3");
      expect(sendMessage.mock.calls[1][1]).toEqual({ triggerTurn: true, deliverAs: "followUp" });

      const fourth = await call("subagent_continue", {
        taskId: third.details.taskIds[0], task: "fourth", async: true,
      }, { ...ctx, mode: "rpc" });
      expect(fourth.details.background).not.toBe(true);
      expect(fourth.content[0].text).toContain("tasks ran blocking");
      expect(fourth.content[0].text).toContain("answer 4");
      expect(sendMessage).toHaveBeenCalledTimes(2);

      const failed = await call("subagent_continue", { taskId: "unknown", task: "no" });
      expect(failed.details.overallFailed).toBe(true);
      expect(await hooks.get("tool_result")({ toolName: "subagent_continue", details: failed.details })).toEqual({ isError: true });
      expect(specs).toHaveLength(4);
    } finally {
      await hooks.get("session_shutdown")();
      vi.restoreAllMocks();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
