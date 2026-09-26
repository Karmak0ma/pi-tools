/**
 * Bookkeeping for background (async) subagent calls.
 *
 * An async `subagent` call returns at once. Its results must still reach the
 * parent agent exactly once, by one of two paths:
 *
 *   pull  The parent calls `subagent_wait` and receives finished results in
 *         that tool result.
 *   push  When every task of the call has finished, one message is pushed to
 *         the parent (and starts a turn if the parent is idle).
 *
 * Both paths share one "delivered" set, so a result that was pulled is never
 * pushed again. The push lists only the tasks not delivered yet, and is
 * skipped when nothing is left. This keeps results out of the parent context
 * twice, which would waste tokens and confuse the model.
 *
 * Session replacement kills the tasks (see SubagentTaskManager.resetSession);
 * their aborted results must not be pushed into the NEXT session, and the old
 * `pi` object is stale by then anyway. A generation counter drops every
 * delivery that was registered before reset().
 */

import type { PersistedTaskSummary } from "./types.js";

export interface BackgroundResult {
  taskId: string;
  summary: PersistedTaskSummary;
}

/** Push the results of one background call to the parent. */
export type DeliverBackgroundResults = (results: BackgroundResult[]) => void;

export class BackgroundDeliveries {
  private generation = 0;
  private readonly background = new Set<string>();
  private readonly delivered = new Set<string>();

  /**
   * Register one async call. `results` must settle once all of `taskIds` are
   * terminal (the manager's wait()). When it settles, the undelivered results
   * are pushed through `deliver`, once.
   */
  track(taskIds: string[], results: Promise<PersistedTaskSummary[]>, deliver: DeliverBackgroundResults): void {
    const generation = this.generation;
    for (const id of taskIds) this.background.add(id);

    results
      .then(async (summaries) => {
        // A subagent_wait that awaits the same task promises resumes in a
        // later microtask than this callback (it was registered later). Yield
        // one macrotask so such a wait can mark its results delivered first;
        // otherwise the same result would be pulled AND pushed.
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (generation !== this.generation) return;
        const pending = summaries
          .map((summary, index) => ({ taskId: taskIds[index], summary }))
          .filter(({ taskId }) => !this.delivered.has(taskId));
        if (pending.length === 0) return;
        this.markDelivered(pending.map((r) => r.taskId));
        deliver(pending);
      })
      .catch(() => {
        // wait() only rejects for unknown ids, which cannot happen for ids
        // the manager just returned. Nothing useful to report here.
      });
  }

  markDelivered(taskIds: string[]): void {
    for (const id of taskIds) this.delivered.add(id);
  }

  isBackground(taskId: string): boolean {
    return this.background.has(taskId);
  }

  /** Background task ids whose results the parent has not received yet. */
  undeliveredIds(): string[] {
    return [...this.background].filter((id) => !this.delivered.has(id));
  }

  /** Forget everything and drop every pending push (session replacement). */
  reset(): void {
    this.generation++;
    this.background.clear();
    this.delivered.clear();
  }
}
