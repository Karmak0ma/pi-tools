/**
 * Task manager contract: the properties that make tasks independent of the
 * tool call that started them. A fake backend stands in for real children;
 * each spawned child stays running until the test finishes it or its task
 * signal aborts it (the same contract both real backends follow).
 */
import { describe, expect, it } from "vitest";
import type { SubagentBackend, SubagentSpec } from "./backends.js";
import { ChildExtensionUIBroker } from "./extension-ui-broker.js";
import type { ChildRunResult } from "./runner.js";
import { SubagentTaskManager, type TaskChange, type TaskStartContext } from "./task-manager.js";
import { SubagentTracker } from "./tracker.js";
import { type AgentConfig, emptyUsage } from "./types.js";

interface FakeChild {
  spec: SubagentSpec;
  finish(output: string): void;
}

function fakeBackend() {
  const children: FakeChild[] = [];
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
        finish: (output) => resolveResult({ ...base, lifecycle: "completed", finalOutput: output, stopReason: "stop" }),
      });
      return { result, control: { sendMessage: async () => {}, abort: () => {} } };
    },
  };
  return { backend, children };
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

function setup(maxConcurrent = 2) {
  const tracker = new SubagentTracker();
  const { backend, children } = fakeBackend();
  const manager = new SubagentTaskManager({
    tracker,
    backend,
    maxConcurrent,
    createBroker: () => new ChildExtensionUIBroker(),
    createPresenter: () => ({ present: async () => ({ kind: "cancelled" }) }),
  });
  return { tracker, manager, children };
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
