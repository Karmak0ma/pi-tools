/**
 * Runtime tracker for subagent instances.
 *
 * Keeps full child JSON events in memory only for the current session.
 * Never persists raw events into tool-result details.
 */

import type { ChildProcess } from "node:child_process";
import {
  type AgentSource,
  type LiveTaskSummary,
  type TaskStatus,
  type TaskUsage,
  type ThinkingLevel,
  emptyUsage,
} from "./types.js";

// ─── Runtime Instance ────────────────────────────────────────────────────────

export interface RuntimeSubagentInstance {
  id: string;
  batchId: number;
  agent: string;
  source: AgentSource;
  task: string;
  cwd: string;
  model?: string;
  thinking?: ThinkingLevel;
  tools: string[];
  warnings: string[];
  events: any[];
  stderr: string;
  status: TaskStatus;
  summary: LiveTaskSummary;
  process?: ChildProcess;
}

// ─── Subagent Tracker ────────────────────────────────────────────────────────

export class SubagentTracker {
  instances: Map<string, RuntimeSubagentInstance> = new Map();
  private _batchCounter = 0;

  /** Get the next batch ID for a new execution invocation. */
  nextBatchId(): number {
    return ++this._batchCounter;
  }

  /** Get the current (latest) batch ID. */
  get currentBatchId(): number {
    return this._batchCounter;
  }

  add(instance: RuntimeSubagentInstance): void {
    this.instances.set(instance.id, instance);
  }

  get(id: string): RuntimeSubagentInstance | undefined {
    return this.instances.get(id);
  }

  getOrdered(): RuntimeSubagentInstance[] {
    return Array.from(this.instances.values());
  }

  getRunning(): RuntimeSubagentInstance[] {
    return this.getOrdered().filter((i) => i.status === "running");
  }

  clear(): void {
    this.instances.clear();
    this._batchCounter = 0;
  }

  killAll(): Promise<void> {
    const runningInstances = Array.from(this.instances.values()).filter(
      (i) => i.status === "running" && i.process,
    );
    if (runningInstances.length === 0) return Promise.resolve();

    return new Promise<void>((resolve) => {
      let remaining = runningInstances.length;
      const done = () => { if (--remaining <= 0) resolve(); };

      for (const instance of runningInstances) {
        const proc = instance.process!;
        let exited = false;
        let resolved = false;

        const doneOnce = () => {
          if (resolved) return;
          resolved = true;
          done();
        };

        const onExit = () => {
          exited = true;
          doneOnce();
        };
        proc.once("close", onExit);
        proc.once("error", onExit);

        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!exited) {
            proc.kill("SIGKILL");
            // Give SIGKILL a moment to land, then resolve regardless
            setTimeout(doneOnce, 500);
          }
        }, 5000);
      }
    });
  }

  /**
   * Update instance status and synchronize its summary.
   */
  updateStatus(id: string, status: TaskStatus, extra?: Partial<LiveTaskSummary>): void {
    const instance = this.instances.get(id);
    if (!instance) return;
    instance.status = status;
    instance.summary.status = status;
    if (extra) {
      Object.assign(instance.summary, extra);
    }
  }
}

/**
 * Create a new RuntimeSubagentInstance with default values.
 */
export function createInstance(opts: {
  id: string;
  batchId?: number;
  agent: string;
  source: AgentSource;
  task: string;
  cwd: string;
  model?: string;
  thinking?: ThinkingLevel;
  tools?: string[];
  warnings?: string[];
}): RuntimeSubagentInstance {
  const summary: LiveTaskSummary = {
    id: opts.id,
    agent: opts.agent,
    source: opts.source,
    task: opts.task,
    cwd: opts.cwd,
    model: opts.model,
    warnings: opts.warnings || [],
    status: "queued",
    isPartial: false,
    toolCalls: [],
    latestOutput: "",
    usage: emptyUsage(),
  };

  return {
    id: opts.id,
    batchId: opts.batchId ?? 0,
    agent: opts.agent,
    source: opts.source,
    task: opts.task,
    cwd: opts.cwd,
    model: opts.model,
    thinking: opts.thinking,
    tools: opts.tools || [],
    warnings: opts.warnings || [],
    events: [],
    stderr: "",
    status: "queued",
    summary,
  };
}
