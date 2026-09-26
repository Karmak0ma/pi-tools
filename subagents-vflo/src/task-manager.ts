/**
 * Session-scoped owner of subagent task lifecycles.
 *
 * Why this exists: the subagent tool's execute() used to resolve, spawn,
 * observe, and finish every child inline, and the child's lifetime was the
 * tool call's lifetime (the tool abort signal was the child's kill switch).
 * No other code could start, observe, wait for, or cancel a task. This class
 * is now the single owner; the tool is a thin adapter over it:
 *
 *   start(tasks, context) -> ids   resolve + spawn under a global limit
 *   wait(ids)                      terminal summaries, in id order
 *   cancel(ids)                    abort queued or running tasks
 *   onChange(listener)             one notification source for every UI
 *   resetSession()                 kill children, drop state, new broker
 *
 * A task's lifetime is owned here, not by a caller: each task has its own
 * AbortController. A blocking caller that wants "abort my call = kill my
 * tasks" connects its own signal to cancel(). This is what allows a task to
 * outlive the call that started it.
 *
 * Concurrency is limited globally (across all calls), not per call. Per-call
 * limiting was effectively global only while calls blocked; with overlapping
 * calls it would multiply the number of live children.
 */

import type { AgentConfig } from "./types.js";
import { findAgent, formatAgentList } from "./agents.js";
import type { SubagentBackend } from "./backends.js";
import type { ChildExtensionUIBroker, ChildUIDialogPresenter, ChildUIRequestOwner } from "./extension-ui-broker.js";
import {
  type ModelRegistry,
  type ToolResolutionOptions,
  resolveCwd,
  resolveModel,
  resolveTools,
} from "./resolver.js";
import { applyChildEvent, type ChangeUrgency } from "./task-events.js";
import { createInstance, setInstanceStatus, type RuntimeSubagentInstance, type SubagentTracker } from "./tracker.js";
import {
  type LiveTaskSummary,
  type PersistedTaskSummary,
  type TaskItem,
  type TaskStatus,
  emptyUsage,
  isTaskFailed,
} from "./types.js";

// ─── Public types ────────────────────────────────────────────────────────────

/**
 * Everything resolved from the parent at the moment tasks are started.
 * Captured once per start() so a task's configuration does not change if the
 * parent later switches model, tools, or cwd.
 */
export interface TaskStartContext {
  agents: AgentConfig[];
  registry: ModelRegistry;
  /** Models known to the parent registry; used for context-window metadata. */
  availableModels: ReadonlyArray<{ provider: string; id: string; contextWindow?: number }>;
  parentActiveToolNames: string[];
  toolResolutionOptions: ToolResolutionOptions;
  cwd: string;
  parentSessionDir?: string;
  /**
   * Host context used to present child extension dialogs in the parent UI.
   * Opaque to the manager; handed to the presenter factory.
   */
  uiContext: unknown;
}

export interface TaskChange {
  taskId: string;
  urgency: Exclude<ChangeUrgency, "none">;
}

export interface TaskManagerDeps {
  tracker: SubagentTracker;
  backend: SubagentBackend;
  maxConcurrent: number;
  /** Creates a fresh broker; called at construction and on every session reset. */
  createBroker: () => ChildExtensionUIBroker;
  /** Builds the presenter that shows one child dialog in the parent UI. */
  createPresenter: (uiContext: unknown, owner: ChildUIRequestOwner) => ChildUIDialogPresenter;
}

// ─── Implementation ──────────────────────────────────────────────────────────

/**
 * Per-task handle kept for the whole session, like the tracker instance it
 * mirrors: wait() and cancel() must work for any task id the session has
 * seen, including after the call that started it returned. Both are dropped
 * together by resetSession(). A record is small (a controller and a settled
 * summary); the tracker's event history is the larger cost.
 */
interface TaskRecord {
  controller: AbortController;
  result: Promise<PersistedTaskSummary>;
}

export class SubagentTaskManager {
  private readonly records = new Map<string, TaskRecord>();
  private readonly listeners = new Set<(change: TaskChange) => void>();
  private readonly slots: Semaphore;
  private _broker: ChildExtensionUIBroker;
  // Runtime-wide and never reset: a per-session counter would let a stale
  // child callback from a replaced session update a new task reusing its id.
  private taskSequence = 0;
  private batchSequence = 0;

  constructor(private readonly deps: TaskManagerDeps) {
    this.slots = new Semaphore(deps.maxConcurrent);
    this._broker = deps.createBroker();
  }

  /** The broker of the current session. Replaced by resetSession(). */
  get broker(): ChildExtensionUIBroker {
    return this._broker;
  }

  /**
   * Register the tasks and start them in the background. Returns the new
   * task ids at once; tasks beyond the global limit wait in FIFO order.
   */
  start(tasks: TaskItem[], context: TaskStartContext): string[] {
    const batchId = ++this.batchSequence;
    // Capture the broker for these tasks. A session switch replaces the
    // manager's broker while stale child callbacks are still unwinding;
    // those callbacks must never reach the fresh broker.
    const broker = this._broker;

    const ids: string[] = [];
    tasks.forEach((task, index) => {
      const id = `task-${++this.taskSequence}`;
      const instance = createInstance({
        id,
        batchId,
        agent: task.agent,
        source: findAgent(context.agents, task.agent)?.source || "builtin",
        task: task.task,
        cwd: context.cwd,
      });
      this.deps.tracker.add(instance);
      const controller = new AbortController();
      const result = this.runTask(instance, task, index, context, broker, controller.signal);
      this.records.set(id, { controller, result });
      ids.push(id);
    });
    return ids;
  }

  /** Whether the id names a task of the current session. */
  has(id: string): boolean {
    return this.records.has(id);
  }

  /**
   * Terminal summaries for the given ids, in the same order. Never rejects
   * for a task failure: failures are summaries with `failed: true`.
   */
  wait(ids: string[]): Promise<PersistedTaskSummary[]> {
    return Promise.all(
      ids.map((id) => {
        const record = this.records.get(id);
        return record ? record.result : Promise.reject(new Error(`Unknown subagent task id: ${id}`));
      }),
    );
  }

  /**
   * Abort queued or running tasks. A queued task never spawns; a running
   * task's backend kills it (RPC process / Herdr pane) and its result
   * settles as aborted. Unknown or already finished ids are ignored.
   */
  cancel(ids: string[]): void {
    for (const id of ids) {
      const record = this.records.get(id);
      if (!record || record.controller.signal.aborted) continue;
      this._broker.cancelOwner(id, "abort");
      record.controller.abort();
    }
  }

  /** Subscribe to task changes. Returns the unsubscribe function. */
  onChange(listener: (change: TaskChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * End the current session's tasks: dispose the broker, kill live children,
   * drop all task state, and start the next session with a fresh broker.
   */
  async resetSession(): Promise<void> {
    const oldBroker = this._broker;
    await oldBroker.dispose();
    // Abort queued tasks first so none of them spawns while live ones are
    // being killed.
    for (const record of this.records.values()) record.controller.abort();
    await this.deps.tracker.killAll();
    this.deps.tracker.clear();
    this.records.clear();
    this._broker = this.deps.createBroker();
  }

  // ─── Task execution ────────────────────────────────────────────────────────

  private notify(taskId: string, urgency: ChangeUrgency): void {
    if (urgency === "none") return;
    for (const listener of this.listeners) listener({ taskId, urgency });
  }

  /** Set a status and notify observers immediately (status transitions). */
  private transition(instance: RuntimeSubagentInstance, status: TaskStatus, extra?: Partial<LiveTaskSummary>): void {
    setInstanceStatus(instance, status, extra);
    this.notify(instance.id, "immediate");
  }

  private async runTask(
    instance: RuntimeSubagentInstance,
    task: TaskItem,
    index: number,
    context: TaskStartContext,
    broker: ChildExtensionUIBroker,
    signal: AbortSignal,
  ): Promise<PersistedTaskSummary> {
    // A task cancelled while queued leaves the queue at once (acquire returns
    // false) so its status changes now, not when some slot frees up later.
    const acquired = await this.slots.acquire(signal);
    if (!acquired) {
      this.transition(instance, "aborted", { lifecycle: "closed", errorMessage: "Aborted before start" });
      return makeErrorSummaryFromInstance(instance, "Aborted before start");
    }
    try {
      return await this.runTaskInSlot(instance, task, index, context, broker, signal);
    } finally {
      this.slots.release();
    }
  }

  private async runTaskInSlot(
    instance: RuntimeSubagentInstance,
    task: TaskItem,
    index: number,
    context: TaskStartContext,
    broker: ChildExtensionUIBroker,
    signal: AbortSignal,
  ): Promise<PersistedTaskSummary> {
    const id = instance.id;

    // Cancelled in the same tick the slot was granted.
    if (signal.aborted) {
      this.transition(instance, "aborted", { lifecycle: "closed", errorMessage: "Aborted before start" });
      return makeErrorSummaryFromInstance(instance, "Aborted before start");
    }

    const agent = findAgent(context.agents, task.agent);
    if (!agent) {
      const errorMsg = `Agent "${task.agent}" not found. Available agents:\n${formatAgentList(context.agents)}`;
      this.transition(instance, "error", { lifecycle: "failed", errorMessage: errorMsg });
      return makeErrorSummaryFromInstance(instance, errorMsg);
    }
    instance.source = agent.source;
    instance.summary.source = agent.source;

    // Resolve model
    const modelResult = resolveModel(task, agent, context.registry);
    instance.warnings.push(...modelResult.warnings);
    instance.summary.warnings = [...instance.warnings];
    if (!modelResult.model) {
      this.transition(instance, "error", { lifecycle: "failed", errorMessage: "No model available" });
      return makeErrorSummaryFromInstance(instance, "No model available");
    }
    instance.model = modelResult.model;
    instance.summary.model = modelResult.model;
    // Resolve the same model metadata used by the parent registry so the
    // inspector can show context capacity before the first response.
    const modelParts = modelResult.model.split("/");
    const resolvedModel = context.availableModels.find(
      (m) => m.provider === modelParts[0] && m.id === modelParts.slice(1).join("/"),
    );
    instance.contextWindow = resolvedModel?.contextWindow;

    // Resolve tools (two-key validation; see ToolResolutionOptions)
    const toolResult = resolveTools(agent, context.parentActiveToolNames, context.toolResolutionOptions);
    instance.warnings.push(...toolResult.warnings);
    instance.summary.warnings = [...instance.warnings];
    if (toolResult.error) {
      this.transition(instance, "error", { lifecycle: "failed", errorMessage: toolResult.error });
      return makeErrorSummaryFromInstance(instance, toolResult.error);
    }

    // Resolve cwd
    const cwdResult = resolveCwd(task, context.cwd);
    if (cwdResult.error) {
      this.transition(instance, "error", { lifecycle: "failed", errorMessage: cwdResult.error });
      return makeErrorSummaryFromInstance(instance, cwdResult.error);
    }
    instance.cwd = cwdResult.cwd;
    instance.summary.cwd = cwdResult.cwd;
    instance.thinking = task.thinking ?? agent.thinking;
    instance.tools = [...toolResult.tools];

    // Mark the delegated task as live. This compatibility status stays
    // `running` even when its current Pi turn later becomes `interrupted`;
    // the separate lifecycle field carries that detail without disabling
    // inspector steering.
    this.transition(instance, "running", { lifecycle: "running" });

    // Run the child through the selected execution backend (Herdr pane or
    // RPC subprocess). Spawn resolves once runtime handles exist;
    // handle.result carries the terminal child semantics.
    try {
      const handle = await this.deps.backend.spawn({
        resolvedModel: modelResult.model,
        resolvedTools: toolResult.tools,
        resolvedCwd: cwdResult.cwd,
        agentName: agent.name,
        agentPrompt: agent.systemPrompt,
        taskText: task.task,
        thinking: instance.thinking,
        childExtensionPaths: context.toolResolutionOptions.childExtensionPaths,
        parentSessionDir: context.parentSessionDir,
        // The task's own lifetime signal (see cancel()), not a tool call's.
        signal,
        // Pane geometry hint (Herdr only): first task of a batch right, the
        // rest stacked down so a concurrent batch cannot shrink the parent
        // pane into a sliver.
        splitDirection: index === 0 ? "right" : "down",
        onEvent: (event) => {
          this.notify(id, applyChildEvent(instance, event));
        },
        onExtensionUIRequest: (request, channel) => {
          const owner = { instanceId: instance.id, agent: instance.agent, task: instance.task, cwd: instance.cwd };
          broker.enqueue({
            owner,
            request,
            channel,
            presenter: this.deps.createPresenter(context.uiContext, owner),
            activeToolCalls: Array.from(instance.activeToolCalls.values()),
          });
          instance.pendingUIRequestCount = broker.getOwnerPendingCount(instance.id);
          this.notify(id, "immediate");
        },
        onStderr: (data) => {
          instance.stderr += data;
          instance.summary.stderrPreview = instance.stderr.slice(0, 500);
          this.notify(id, "throttled");
        },
      });

      // Herdr instances carry no process (the pane hosts the child); control
      // still routes abort/steer through the backend.
      instance.process = handle.process;
      instance.control = handle.control;

      const childResult = await handle.result;
      releaseChildRuntime(broker, instance);

      instance.summary.usage = childResult.usage;
      instance.summary.latestOutput = childResult.finalOutput;
      instance.summary.toolCalls = childResult.toolCalls;
      instance.summary.lifecycle = childResult.lifecycle;
      instance.summary.stopReason = childResult.stopReason;
      instance.summary.errorMessage = childResult.errorMessage;
      instance.summary.model = childResult.model || instance.model;

      // Lifecycle is the logical task contract. A raw process exit code is
      // not enough: the child may close noisily after a valid final stop,
      // while a closed task may have exit code zero.
      const isError = childResult.lifecycle !== "completed" || isTaskFailed(childResult);
      if (isError) {
        this.transition(instance, childResult.stopReason === "aborted" ? "aborted" : "error", {
          lifecycle: childResult.lifecycle,
        });
      } else {
        this.transition(instance, "completed", { lifecycle: "completed" });
      }
      return makePersistedSummary(instance);
    } catch (err: any) {
      // A failed spawn or a backend error. Release anything the child may
      // have registered so no dialog stays queued for a dead task.
      releaseChildRuntime(broker, instance);
      this.transition(instance, "error", { lifecycle: "failed", errorMessage: err?.message || "Unknown error" });
      return makeErrorSummaryFromInstance(instance, err?.message || "Unknown error");
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * FIFO counting semaphore. `release()` hands the slot directly to the next
 * waiter, so a late `acquire()` cannot overtake tasks already queued. An
 * aborted waiter is removed from the queue and never takes a slot.
 */
class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  /** Resolves true when a slot is held, false when `signal` aborted first. */
  acquire(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const grant = () => {
        signal.removeEventListener("abort", onAbort);
        resolve(true);
      };
      const onAbort = () => {
        const position = this.waiters.indexOf(grant);
        if (position >= 0) this.waiters.splice(position, 1);
        resolve(false);
      };
      this.waiters.push(grant);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active--;
  }
}

/**
 * Release a child's runtime handles once its backend result has settled:
 * cancel any dialog still queued for it and drop the steering references.
 */
function releaseChildRuntime(broker: ChildExtensionUIBroker, instance: RuntimeSubagentInstance): void {
  broker.cancelOwner(instance.id, "exit");
  instance.activeToolCalls.clear();
  instance.pendingUIRequestCount = 0;
  instance.process = undefined;
  instance.control = undefined;
}

function makePersistedSummary(instance: RuntimeSubagentInstance): PersistedTaskSummary {
  const failed = isTaskFailed({
    status: instance.status,
    lifecycle: instance.summary.lifecycle,
    stopReason: instance.summary.stopReason,
    errorMessage: instance.summary.errorMessage,
  });
  return {
    agent: instance.agent,
    source: instance.summary.source,
    task: instance.task,
    cwd: instance.cwd,
    model: instance.summary.model || instance.model,
    warnings: [...instance.warnings],
    lifecycle: instance.summary.lifecycle,
    stopReason: instance.summary.stopReason,
    errorMessage: instance.summary.errorMessage,
    stderrPreview: instance.stderr ? instance.stderr.slice(0, 500) : undefined,
    toolCalls: [...instance.summary.toolCalls],
    finalOutput: instance.summary.latestOutput,
    usage: { ...instance.summary.usage },
    failed,
  };
}

function makeErrorSummaryFromInstance(instance: RuntimeSubagentInstance, error: string): PersistedTaskSummary {
  return {
    agent: instance.agent,
    source: instance.summary.source,
    task: instance.task,
    cwd: instance.cwd,
    warnings: [...instance.warnings],
    lifecycle: "failed",
    errorMessage: error,
    toolCalls: [...instance.summary.toolCalls],
    finalOutput: instance.summary.latestOutput || "",
    usage: instance.summary.usage ? { ...instance.summary.usage } : emptyUsage(),
    failed: true,
  };
}
