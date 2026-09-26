import { describe, expect, it, vi } from "vitest";
import { BackgroundDeliveries } from "./background-deliveries.js";
import { emptyUsage, type PersistedTaskSummary } from "./types.js";

function summary(agent: string): PersistedTaskSummary {
  return {
    agent,
    source: "builtin",
    task: "t",
    cwd: "/tmp",
    warnings: [],
    lifecycle: "closed",
    toolCalls: [],
    finalOutput: `${agent} done`,
    usage: emptyUsage(),
  };
}

/** A promise the test settles by hand, like the manager's wait(). */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Let the push callback (microtasks + one setImmediate) run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

describe("BackgroundDeliveries", () => {
  it("pushes the results of one call once, when all its tasks have finished", async () => {
    const deliveries = new BackgroundDeliveries();
    const results = deferred<PersistedTaskSummary[]>();
    const deliver = vi.fn();
    deliveries.track(["task-1", "task-2"], results.promise, deliver);
    expect(deliveries.undeliveredIds()).toEqual(["task-1", "task-2"]);

    results.resolve([summary("a"), summary("b")]);
    await flush();

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0].map((r: { taskId: string }) => r.taskId)).toEqual(["task-1", "task-2"]);
    expect(deliveries.undeliveredIds()).toEqual([]);
  });

  it("does not push results a wait already pulled, even when both settle together", async () => {
    // subagent_wait awaits the same task promises and registers its callback
    // AFTER track(); the push must still see the wait's markDelivered.
    const deliveries = new BackgroundDeliveries();
    const results = deferred<PersistedTaskSummary[]>();
    const deliver = vi.fn();
    deliveries.track(["task-1", "task-2"], results.promise, deliver);
    results.promise.then(() => deliveries.markDelivered(["task-1"]));

    results.resolve([summary("a"), summary("b")]);
    await flush();

    // Only the task the wait did not report is pushed.
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0].map((r: { taskId: string }) => r.taskId)).toEqual(["task-2"]);

    // When everything was pulled, nothing is pushed at all.
    const second = deferred<PersistedTaskSummary[]>();
    const deliverSecond = vi.fn();
    deliveries.track(["task-3"], second.promise, deliverSecond);
    second.promise.then(() => deliveries.markDelivered(["task-3"]));
    second.resolve([summary("c")]);
    await flush();
    expect(deliverSecond).not.toHaveBeenCalled();
  });

  it("drops pushes of calls started before a session reset", async () => {
    const deliveries = new BackgroundDeliveries();
    const results = deferred<PersistedTaskSummary[]>();
    const deliver = vi.fn();
    deliveries.track(["task-1"], results.promise, deliver);

    deliveries.reset();
    results.resolve([summary("aborted")]);
    await flush();

    expect(deliver).not.toHaveBeenCalled();
    expect(deliveries.undeliveredIds()).toEqual([]);
  });
});
