/**
 * Task manager contract: the properties that make tasks independent of the
 * tool call that started them. A fake backend stands in for real children;
 * each spawned child stays running until the test finishes it or its task
 * signal aborts it (the same contract both real backends follow).
 */
import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SubagentBackend, SubagentHandle, SubagentSpec } from "./backends.js";
import { ChildExtensionUIBroker } from "./extension-ui-broker.js";
import type { ChildRunResult } from "./runner.js";
import { SubagentTaskManager, type TaskChange, type TaskStartContext } from "./task-manager.js";
import { SubagentTracker } from "./tracker.js";
import { type AgentConfig, emptyUsage } from "./types.js";

interface FakeChild {
  spec: SubagentSpec;
  finish(output: string, sessionFile?: string, sessionBytes?: number): void;
}

function fakeBackend(live = false) {
  const children: FakeChild[] = [];
  const resume = vi.fn(async (spec: SubagentSpec): Promise<SubagentHandle> => backend.spawn(spec));
  const backend: SubagentBackend = {
    async spawn(spec) {
      let resolveResult!: (result: ChildRunResult) => void;
      const result = new Promise<ChildRunResult>((resolve) => (resolveResult = resolve));
      const base = { exitCode: 0, usage: emptyUsage(), toolCalls: [] };
      spec.signal?.addEventListener("abort", () =>
        resolveResult({ ...base, lifecycle: "closed", finalOutput: "", stopReason: "aborted" }),
      );
      children.push({
        spec,
        finish: (output, sessionFile, sessionBytes) => resolveResult({ ...base, lifecycle: "completed", finalOutput: output, stopReason: "stop", sessionFile, sessionBytes }),
      });
      return { result, control: { sendMessage: async () => {}, abort: () => {} }, resume: live ? resume : undefined };
    },
  };
  return { backend, children, resume };
}

const agent: AgentConfig = { name: "explore", description: "", tools: ["read"], systemPrompt: "", source: "builtin" };

function context(): TaskStartContext {
  return {
    agents: [agent],
    registry: { resolve: () => undefined, getParentModel: () => ({ provider: "p", id: "m" }) },
    availableModels: [],
    parentActiveToolNames: ["read"],
    toolResolutionOptions: {},
    cwd: process.cwd(),
    uiContext: undefined,
  };
}

function setup(maxConcurrent = 2, live = false) {
  const tracker = new SubagentTracker();
  const { backend, children, resume } = fakeBackend(live);
  const manager = new SubagentTaskManager({
    tracker,
    backend,
    maxConcurrent,
    createBroker: () => new ChildExtensionUIBroker(),
    createPresenter: () => ({ present: async () => ({ kind: "cancelled" }) }),
  });
  return { tracker, manager, children, resume };
}

/** Let queued microtasks (slot hand-off, spawn) run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const task = (text: string) => ({ agent: "explore", task: text });

describe("SubagentTaskManager", () => {
  it("limits live children across separate start() calls, in FIFO order", async () => {
    const { manager, children } = setup(2);
    const first = manager.start([task("a"), task("b")], context());
    const second = manager.start([task("c")], context());
    await settle();

    // A per-call limit would have started "c" too.
    expect(children.map((c) => c.spec.taskText)).toEqual(["a", "b"]);

    children[0].finish("A");
    await settle();
    expect(children.map((c) => c.spec.taskText)).toEqual(["a", "b", "c"]);

    children[1].finish("B");
    children[2].finish("C");
    const results = await manager.wait([...second, ...first]);
    expect(results.map((r) => r.finalOutput)).toEqual(["C", "A", "B"]);
    expect(results.every((r) => !r.failed)).toBe(true);
  });

  it("cancels a queued task before it spawns and a running task through its own signal", async () => {
    const { manager, tracker, children } = setup(1);
    const [running, queued] = manager.start([task("a"), task("b")], context());
    await settle();

    manager.cancel([queued]);
    // The queued task closes at once, without waiting for a free slot.
    await settle();
    expect(tracker.get(queued)?.status).toBe("aborted");
    manager.cancel([running]);
    const [runningResult, queuedResult] = await manager.wait([running, queued]);

    expect(children.map((c) => c.spec.taskText)).toEqual(["a"]);
    expect(runningResult).toMatchObject({
      failed: true,
      lifecycle: "closed",
      stopReason: "aborted",
      errorMessage: "Cancelled by the parent",
      cancelledByParent: true,
    });
    expect(queuedResult).toMatchObject({
      failed: true,
      lifecycle: "closed",
      errorMessage: "Cancelled by the parent",
      cancelledByParent: true,
    });
  });

  it("keeps running after the starter stops listening and notifies every observer", async () => {
    const { manager, tracker, children } = setup();
    const changes: TaskChange[] = [];
    manager.onChange((change) => changes.push(change));
    // A caller that subscribes and leaves (like a tool call that returned).
    const unsubscribe = manager.onChange(() => {});
    const [id] = manager.start([task("a")], context());
    unsubscribe();
    await settle();

    children[0].spec.onEvent?.({ type: "agent_start" });
    children[0].finish("done");
    const [result] = await manager.wait([id]);

    expect(result.finalOutput).toBe("done");
    expect(tracker.get(id)?.status).toBe("completed");
    expect(changes.some((c) => c.taskId === id && c.urgency === "immediate")).toBe(true);
  });

  it("fails an unknown agent on its own without affecting the rest of the batch", async () => {
    const { manager, children } = setup();
    const ids = manager.start([{ agent: "nope", task: "x" }, task("a")], context());
    await settle();
    children[0].finish("A");

    const [unknown, known] = await manager.wait(ids);
    expect(unknown.failed).toBe(true);
    expect(unknown.errorMessage).toContain('Agent "nope" not found');
    expect(known.finalOutput).toBe("A");
  });

  // A follow-up must inherit the child's resolved configuration and frozen
  // history, not re-resolve current parent settings or overwrite old results.
  it("continues completed context with independent ids and exclusive conversation ownership", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "continuation-test-"));
    const sessionFile = path.join(dir, "session.jsonl");
    const history = fs.readFileSync(new URL("./fixtures/real-pi-session.jsonl", import.meta.url), "utf8");
    fs.writeFileSync(sessionFile, history);
    const { manager, children, tracker, resume } = setup(1, true);
    try {
      const [first] = manager.start([task("first")], context());
      expect(() => manager.continue(first, "too early", undefined)).toThrow(/completed/i);
      await settle();
      // The pane may append again before the completion promise reaches the
      // manager. Only the monitor's completed-entry prefix belongs to first.
      fs.appendFileSync(sessionFile, "later user activity\n");
      children[0].finish("original", sessionFile, Buffer.byteLength(history));
      // Cancellation after the authoritative completion must not erase its
      // saved context while still returning a successful task to the caller.
      manager.cancel([first]);
      expect((await manager.wait([first]))[0].lifecycle).toBe("completed");
      const second = manager.continue(first, "follow-up", undefined);
      expect(second).not.toBe(first);
      expect(() => manager.continue(first, "overlap", undefined)).toThrow(/busy/i);
      await settle();
      expect(children[1].spec).toMatchObject({
        agentName: children[0].spec.agentName,
        resolvedModel: children[0].spec.resolvedModel,
        resolvedTools: children[0].spec.resolvedTools,
        resolvedCwd: children[0].spec.resolvedCwd,
        taskText: "follow-up",
      });
      // The adapter must pass fresh request callbacks to the backend's live
      // capability. Calling spawn instead would silently open a second pane.
      expect(resume).toHaveBeenCalledOnce();
      expect(children[1].spec.signal).not.toBe(children[0].spec.signal);
      expect(fs.readFileSync(children[1].spec.continueFrom!, "utf8")).toBe(history);
      children[1].finish("follow-up result", sessionFile);
      const [oldResult, newResult] = await manager.wait([first, second]);
      expect([oldResult.finalOutput, newResult.finalOutput]).toEqual(["original", "follow-up result"]);
      // Use the newest successful id: silently using an ancestor loses the
      // follow-up exchange and would look like a context-preserving resume.
      expect(() => manager.continue(first, "stale", undefined)).toThrow(/latest/i);
      const third = manager.continue(second, "cancel me", undefined);
      manager.cancel([third]);
      expect((await manager.wait([third]))[0].cancelledByParent).toBe(true);
      const retry = manager.continue(second, "retry", undefined);
      manager.cancel([retry]);
      await manager.wait([retry]);
      // Hold reset after its kill pass. New work here would escape cleanup
      // and keep running after the manager drops its tracking records.
      let releaseReset!: () => void;
      const resetGate = new Promise<void>((resolve) => { releaseReset = resolve; });
      const killAll = tracker.killAll.bind(tracker);
      tracker.killAll = async () => { await killAll(); await resetGate; };
      const resetting = manager.resetSession();
      try {
        await settle();
        expect(manager.resetSession()).toBe(resetting);
        expect(() => manager.continue(second, "during reset", undefined)).toThrow(/reset/i);
        expect(() => manager.start([task("during reset")], context())).toThrow(/reset/i);
      } finally {
        releaseReset();
        await resetting;
        tracker.killAll = killAll;
      }
      expect(() => manager.continue(second, "old session", undefined)).toThrow(/unknown/i);
    } finally {
      await manager.resetSession();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resetSession aborts queued tasks and drops all state", async () => {
    const { manager, tracker, children } = setup(1);
    const ids = manager.start([task("a"), task("b")], context());
    await settle();

    await manager.resetSession();
    expect(tracker.instances.size).toBe(0);
    await expect(manager.wait(ids)).rejects.toThrow(/Unknown subagent task id/);
    await settle();
    expect(children.map((c) => c.spec.taskText)).toEqual(["a"]);
  });
});
