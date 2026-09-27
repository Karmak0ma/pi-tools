/**
 * Subagent Extension — Entry Point
 *
 * Delegates tasks to specialized subagents with isolated context windows.
 * Each task runs as a separate pi subprocess (or Herdr pane).
 *
 * This file is the adapter between Pi and the task manager: it registers the
 * tool, the inspector shortcuts, and the session hooks. Task lifecycles
 * (resolve, spawn, observe, cancel) live in task-manager.ts.
 *
 * Adapted from the official pi subagent example.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { discoverAgents, findAgent, formatAgentList } from "./agents.js";
import { renderCall, renderResult } from "./render.js";
import { Container, Text } from "@earendil-works/pi-tui";
import { type ModelRegistry, buildToolResolutionOptions } from "./resolver.js";
import { buildMultiTaskToolResult, buildSingleTaskToolResult } from "./multi-task-result.js";
import { BackgroundDeliveries, type BackgroundResult } from "./background-deliveries.js";
import { currentNestingDepth } from "./runner.js";
import { createBackend } from "./backends.js";
import { ChildExtensionUIBroker } from "./extension-ui-broker.js";
import { ExtensionUIDialogPresenter } from "./extension-ui-presenter.js";
import { SubagentTaskManager } from "./task-manager.js";
import { Throttle } from "./throttle.js";
import { type RuntimeSubagentInstance, SubagentTracker, setInstanceStatus } from "./tracker.js";
import {
  type LiveSubagentToolDetails,
  type LiveTaskSummary,
  MAX_CONCURRENT,
  MAX_TOTAL_TASKS,
  type PersistedSubagentToolDetails,
  type PersistedTaskSummary,
  type TaskItem,
  THINKING_LEVELS,
  isTaskFailed,
} from "./types.js";
import { SubagentTuiManager } from "./tui.js";
export { INSPECTOR_VISIBILITY_CHANNEL } from "./tui.js";
export type { InspectorVisibilityEvent } from "./tui.js";

// ─── Tool Schema ─────────────────────────────────────────────────────────────

const TaskItemSchema = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Detailed task for the agent" }),
  model: Type.Optional(
    Type.String({
      description:
        'Optional model override. Accepted forms: exact "provider/model-id" or exact unique bare model-id. If omitted, built-in agents use their configured default (or the bundled default), custom agents use their frontmatter model, then the parent model is used as fallback. Fuzzy aliases are not allowed.',
    }),
  ),
  cwd: Type.Optional(Type.String({ description: "Working directory override" })),
  thinking: Type.Optional(
    Type.Union(
      THINKING_LEVELS.map((level) => Type.Literal(level)),
      {
        description:
          'Optional thinking effort level for the subagent. Values: "off", "minimal", "low", "medium", "high", "xhigh", "max". If omitted, built-in agents use their configured or bundled level; custom agents use the model\'s default.',
      },
    ),
  ),
});

const SubagentParams = Type.Object({
  tasks: Type.Array(TaskItemSchema, {
    description: "Array of tasks to delegate. Each runs as a separate subagent process.",
    minItems: 1,
    maxItems: MAX_TOTAL_TASKS,
  }),
  async: Type.Optional(
    Type.Boolean({
      description:
        "Default false (blocking: the call waits and returns the results). true = start the tasks in the background and return their ids at once; the results arrive later as one message when all tasks of this call have finished. See the tool guidelines for when to use it.",
    }),
  ),
});

/** Task id list. Ids are "task-N", as returned by an async subagent call. */
const taskIdsSchema = (description: string) => Type.Array(Type.String(), { description });

const SubagentStatusParams = Type.Object({
  ids: Type.Optional(taskIdsSchema("Task ids to report. Omit to report every task of this session.")),
});

/** Upper bound for subagent_wait, so one call can not block the parent for hours. */
const MAX_WAIT_SECONDS = 1800;
const DEFAULT_WAIT_SECONDS = 300;

const SubagentWaitParams = Type.Object({
  ids: Type.Optional(
    taskIdsSchema("Task ids to wait for. Omit to wait for every background task whose result you have not received yet."),
  ),
  timeoutSeconds: Type.Optional(
    Type.Number({
      description: `Maximum time to wait. Default ${DEFAULT_WAIT_SECONDS}, maximum ${MAX_WAIT_SECONDS}. On timeout you get the finished results plus the status of the rest; the rest keep running.`,
      minimum: 1,
      maximum: MAX_WAIT_SECONDS,
    }),
  ),
});

const SubagentCancelParams = Type.Object({
  ids: Type.Array(Type.String(), { description: 'Task ids to cancel (for example "task-3").', minItems: 1 }),
});

/** customType of the message that pushes background results to the parent. */
export const BACKGROUND_RESULT_MESSAGE = "subagent-background-result";

/**
 * Async mode is offered only where a later push can reach an agent whose
 * answer somebody still reads:
 * - Mode: only the interactive TUI keeps the session alive after the turn.
 *   In print / json mode the process exits when the prompt ends and kills
 *   the background tasks.
 * - Depth: a nested subagent (depth > 0) has a parent that takes the child's
 *   FIRST normal turn end as the task result (both backends do this). With
 *   async, that first turn ends with "started in the background", so the
 *   parent records that as the answer. The real results arrive later and
 *   are lost: the RPC runner has already shut the child down, and on Herdr
 *   the pane is still open but the parent no longer watches it.
 *   The mode check alone does not catch this: Herdr children run as
 *   interactive pi, so their mode is "tui".
 * At the top level (depth 0) nobody collects the turn as a result; the user
 * does, and the push starts a new turn they see.
 * Elsewhere an async request runs blocking and the result says so.
 */
function asyncAvailable(ctx: Pick<ExtensionContext, "mode">): boolean {
  return ctx.mode === "tui" && currentNestingDepth() === 0;
}

// ─── Extension Entry ─────────────────────────────────────────────────────────

/**
 * Read one parent session path without requiring a persistent session manager.
 * In-memory or custom hosts may omit an accessor or reject the lookup; the
 * child backend can still use its temporary-storage fallback in that case.
 */
function getParentSessionPath(
  ctx: Pick<ExtensionContext, "sessionManager">,
  accessor: "getSessionDir" | "getSessionFile",
): string | undefined {
  try {
    return ctx.sessionManager?.[accessor]?.();
  } catch {
    return undefined;
  }
}

export default function (pi: ExtensionAPI) {
  const tracker = new SubagentTracker();
  const deliveries = new BackgroundDeliveries();
  let deliverySequence = 0;
  let tuiManager: SubagentTuiManager;

  const reportBrokerDiagnostic = (message: string, owner?: { instanceId: string }): void => {
    const instance = owner ? tracker.get(owner.instanceId) : undefined;
    if (instance) {
      // Diagnostics are deliberately concise and contain no request text or
      // tool arguments, so they are safe to retain with normal runtime warnings.
      instance.warnings.push(message);
      instance.summary.warnings = [...instance.warnings];
    }
    if (tuiManager.isActive) tuiManager.requestRender();
  };

  // One execution backend per extension runtime. Herdr detection happens once
  // (see selectBackendKind): inside a Herdr workspace subagents spawn as real
  // pi sessions in new panes; otherwise the original RPC runner is used. All
  // session-scoped state (watchers, panes, processes) is disposed through
  // manager.resetSession on shutdown/switch, so nothing is re-created here.
  const manager = new SubagentTaskManager({
    tracker,
    backend: createBackend(),
    maxConcurrent: MAX_CONCURRENT,
    createBroker: () =>
      new ChildExtensionUIBroker({
        onDiagnostic: reportBrokerDiagnostic,
        onPendingCountChange(instanceId, count) {
          const instance = tracker.get(instanceId);
          if (!instance) return;
          instance.pendingUIRequestCount = count;
          if (tuiManager.isActive) tuiManager.requestRender();
        },
      }),
    createPresenter: (uiContext, owner) =>
      new ExtensionUIDialogPresenter(uiContext, {
        isInspectorActive: () => tuiManager.isActive,
        isInspectorOverlayFocused: () => tuiManager.isOverlayFocusedVisible,
        focusInspectorOverlayForDialog: () => tuiManager.focusInspectorOverlayForDialog(),
        onDiagnostic: (message) => reportBrokerDiagnostic(message, owner),
      }),
  });

  // Inspector abort (x key). It aborts through the child's control and marks
  // the task aborted at once, so the inspector reacts before the backend
  // result arrives. The backend result later overwrites these fields.
  tuiManager = new SubagentTuiManager(tracker, (instance) => {
    if (instance.status !== "running") return;
    // Through the manager, not control.abort() directly: the manager's
    // signal is what marks the result "cancelled by the parent" instead of
    // "failed". manager.cancel also cancels the child's pending dialogs.
    manager.cancel([instance.id]);
    setInstanceStatus(instance, "aborted", { lifecycle: "closed", isPartial: false });
    tuiManager.requestRender();
  });

  // The inspector observes every task, whichever call started it, so it
  // subscribes to the manager directly rather than to a tool call's updates.
  const inspectorRefresh = new Throttle(() => {
    if (tuiManager.isActive) tuiManager.requestRender();
  });
  manager.onChange((change) => {
    if (change.urgency === "immediate") inspectorRefresh.immediate();
    else inspectorRefresh.throttled();
  });

  // Mark final tool results as real tool failures when execute recorded an overall failure.
  // Pi runtime only treats thrown errors or tool_result patches as actual isError results.
  pi.on("tool_result", async (event) => {
    // subagent_wait returns the same results as a blocking call, so it gets
    // the same rule: an error only when every returned task failed.
    if (event.toolName !== "subagent" && event.toolName !== "subagent_wait") return;
    const details = event.details as PersistedSubagentToolDetails | undefined;
    if (!details?.overallFailed) return;
    return { isError: true };
  });

  // ─── Session Lifecycle ───────────────────────────────────────────────────

  const disposeSessionRuntime = async () => {
    if (tuiManager.isActive) tuiManager.exit();
    // Before resetSession: killing the tasks settles their results as
    // aborted, and those must not be pushed (the pi object is stale by then).
    deliveries.reset();
    await manager.resetSession();
  };

  pi.on("session_shutdown", async (_event, _ctx) => {
    await disposeSessionRuntime();
  });

  pi.on("session_before_switch", async (_event, _ctx) => {
    await disposeSessionRuntime();
  });

  // ─── TUI Shortcuts / Commands ────────────────────────────────────────────

  const openInspector = async (ctx: any) => {
    if (!tuiManager.isAvailable) {
      if (ctx?.hasUI) ctx.ui.notify("Subagent inspector is unavailable in this mode.", "warning");
      return;
    }
    if (!tuiManager.canActivate()) {
      if (tracker.instances.size === 0 && ctx?.hasUI) {
        ctx.ui.notify("No subagent tasks are available to inspect yet.", "info");
      }
      return;
    }
    await tuiManager.enter(ctx);
  };

  pi.registerShortcut("ctrl+down", {
    description: "Open subagent inspector",
    handler: async (ctx) => {
      await openInspector(ctx);
    },
  });

  pi.registerShortcut("ctrl+up", {
    description: "Close subagent inspector",
    handler: async (_ctx) => {
      if (tuiManager.isActive) tuiManager.exit();
    },
  });

  if (typeof pi.registerCommand === "function") {
    pi.registerCommand("subagents", {
      description: "Open the subagent inspector",
      handler: async (_args, ctx) => {
        await openInspector(ctx);
      },
    });
  }

  // ─── Background results ──────────────────────────────────────────────────

  /**
   * Push the results of one async call to the parent. followUp: a busy
   * parent gets it after its current turn (no interruption of its work); an
   * idle parent starts a new turn with it (triggerTurn).
   */
  const pushBackgroundResults = (results: BackgroundResult[], sessionFile: string | undefined): void => {
    const deliveryId = `delivery-${++deliverySequence}`;
    const taskIds = results.map((r) => r.taskId);
    const built = buildMultiTaskToolResult(results.map((r) => r.summary), {
      toolCallId: deliveryId,
      sessionFile,
      deliveryId,
      taskIds,
    });
    const text = `Background subagent results (${taskIds.join(", ")}):\n\n${built.content[0].text}`;
    try {
      const sent: unknown = pi.sendMessage(
        {
          customType: BACKGROUND_RESULT_MESSAGE,
          content: text,
          display: true,
          details: { ...built.details, taskIds, deliveryId } satisfies PersistedSubagentToolDetails,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
      // The declared type is void, but the runtime returns a promise; do not
      // let a late rejection become an unhandled rejection.
      if (sent instanceof Promise) sent.catch(() => {});
    } catch {
      // Stale pi (session replaced between settle and push). The generation
      // guard in BackgroundDeliveries should prevent this; nothing to do.
    }
  };

  if (typeof pi.registerMessageRenderer === "function") {
    pi.registerMessageRenderer<PersistedSubagentToolDetails>(BACKGROUND_RESULT_MESSAGE, (message, options, theme) => {
      const container = new Container();
      container.addChild(new Text(theme.fg("toolTitle", theme.bold("subagent background results")), 0, 0));
      container.addChild(renderResult({ content: message.content, details: message.details }, options, theme));
      return container;
    });
  }

  // ─── Tool Registration ───────────────────────────────────────────────────

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate tasks to specialized subagents with isolated context windows. Each task runs in a separate process.",
    promptSnippet:
      "Delegate tasks to specialized subagents (explore, build, or custom) with isolated context",
    promptGuidelines: [
      `Use subagent proactively for: independent read-only research, broad codebase reconnaissance, high-volume command output that would clutter the main context, parallel multi-domain investigation where each branch can return a concise summary, and independent review or verification after implementation with the read-only explore agent.`,
      `Do not use subagent for: simple answers, quick targeted edits, latency-sensitive one-step work, tasks needing frequent user back-and-forth, or parallel implementation editing the same files (serialize write-heavy work instead). Do not spawn a build agent just to rename one symbol in a known file; edit it directly.`,
      `Only set tasks[i].model when the user explicitly asks for a different model. If omitted, built-in agents use their configured default (or the bundled default), custom agents may use a model from their frontmatter, and the parent model is the final fallback.`,
      `Only set tasks[i].thinking when the user explicitly asks for a different thinking effort level. Values: "off", "minimal", "low", "medium", "high", "xhigh", "max". If omitted, built-in agents use their configured or bundled level; custom agents use the model's default.`,
      `subagent is BLOCKING by default (async omitted or false): the call waits and returns the results. Keep this default unless there is a clear reason for background work.`,
      `Set async: true only when (a) the user asks for background, parallel or async work, or (b) the user lists several pieces of work and some of them can run independently while you do the others yourself. Use discretion. When you are unsure whether the user wants work to continue in the background, ask the user before choosing async. Do not use async when your next step needs the results; use a blocking call instead.`,
      `After an async call, continue with your other work. The results arrive automatically as one message when all tasks of that call have finished (a new turn starts if you are idle). Do not poll subagent_status in a loop. Use subagent_wait only when you have no other useful work left and need the results; use subagent_status to report progress; use subagent_cancel for tasks that are no longer needed. Async is available only in the interactive TUI at the top level; elsewhere the call runs blocking.`,
      `When using subagent, provide highly detailed task descriptions so the agent can work autonomously. Specify what to return. Example: { "tasks": [{ "agent": "explore", "task": "Research auth-related source files. Report paths and open questions. Do not edit files." }, { "agent": "explore", "task": "Research auth-related tests. Report coverage gaps. Do not edit files." }] }`,
    ],
    parameters: SubagentParams,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const tasks = params.tasks as TaskItem[];

      // Validate task count
      if (tasks.length > MAX_TOTAL_TASKS) {
        return failedToolResult(
          `Too many tasks (${tasks.length}). Maximum is ${MAX_TOTAL_TASKS}. Please reduce batch size.`,
          tasks.length,
        );
      }

      const agents = discoverAgents(ctx.cwd).agents;

      // When no task names a known agent, nothing can run: answer at once and
      // create no tasks. (Partially valid batches run; the manager fails the
      // unknown ones individually with the same message.)
      const unknownAgentErrors = tasks
        .map((task, index) => ({ task, index }))
        .filter(({ task }) => !findAgent(agents, task.agent))
        .map(({ task, index }) => `Task ${index + 1}: Agent "${task.agent}" not found. Available agents:\n${formatAgentList(agents)}`);
      if (unknownAgentErrors.length === tasks.length) {
        return failedToolResult(unknownAgentErrors.join("\n\n"), tasks.length);
      }

      const asyncRequested = params.async === true;
      const runAsync = asyncRequested && asyncAvailable(ctx);
      const sessionFile = getParentSessionPath(ctx, "getSessionFile");

      const availableModels = await ctx.modelRegistry.getAvailable();
      const taskIds = manager.start(tasks, {
        agents,
        registry: createModelRegistry(availableModels, ctx.model),
        availableModels,
        // Parent active tool names, for inheritance.
        parentActiveToolNames: pi.getActiveTools(),
        // Two-key tool model (see ToolResolutionOptions): the settings file
        // decides which extensions are loaded into children, the agent's
        // tools: frontmatter decides which of the available tools are active.
        toolResolutionOptions: buildToolResolutionOptions(pi),
        cwd: ctx.cwd,
        parentSessionDir: getParentSessionPath(ctx, "getSessionDir"),
        uiContext: ctx,
      });

      if (runAsync) {
        // Tasks now belong to the session, not to this call: the tool
        // signal is NOT connected to cancel (the call ends right away).
        deliveries.track(taskIds, manager.wait(taskIds), (results) => pushBackgroundResults(results, sessionFile));
        const listing = taskIds.map((id, index) => `${id} (${tasks[index].agent})`).join(", ");
        return {
          content: [{
            type: "text" as const,
            text: `Started ${taskIds.length} subagent task(s) in the background: ${listing}.\n` +
              `The results will arrive as one message when all of them have finished. Continue with other work. ` +
              `Use subagent_status, subagent_wait or subagent_cancel with these ids if needed.`,
          }],
          details: {
            mode: "tasks",
            taskCount: taskIds.length,
            summaries: [],
            taskIds,
            background: true,
          } as PersistedSubagentToolDetails,
        };
      }

      // Live tool row: show this call's tasks, throttled like the inspector.
      // The row is hidden behind the inspector overlay, so skip it while the
      // inspector is open.
      const invocationIds = new Set(taskIds);
      const rowRefresh = new Throttle(() => {
        if (!onUpdate || tuiManager.isActive) return;
        onUpdate(liveToolUpdate(tracker, taskIds));
      });
      const unsubscribe = manager.onChange((change) => {
        if (!invocationIds.has(change.taskId)) return;
        if (change.urgency === "immediate") rowRefresh.immediate();
        else rowRefresh.throttled();
      });
      rowRefresh.immediate();

      // Blocking call: aborting the tool call (Escape) cancels its tasks.
      const cancelInvocation = () => manager.cancel(taskIds);
      signal?.addEventListener("abort", cancelInvocation, { once: true });
      if (signal?.aborted) cancelInvocation();

      let results: PersistedTaskSummary[];
      try {
        results = await manager.wait(taskIds);
      } finally {
        unsubscribe();
        signal?.removeEventListener("abort", cancelInvocation);
        rowRefresh.flush();
      }

      const result = buildToolResult(results, toolCallId, sessionFile);
      if (asyncRequested) {
        // The model asked for async; tell it why it got results instead.
        result.content[0].text =
          "Note: async is not available in this mode (only the interactive TUI at the top level), so the tasks ran blocking.\n\n" +
          result.content[0].text;
      }
      return result;
    },

    renderCall(args, theme, _context) {
      return renderCall(args, theme);
    },

    renderResult(result, options, theme, _context) {
      return renderResult(result, options, theme);
    },
  });

  // ─── Monitoring tools for async calls ────────────────────────────────────

  /** Split ids into known tasks of this session and unknown ones. */
  const partitionIds = (ids: string[]) => ({
    known: ids.filter((id) => manager.has(id)),
    unknown: ids.filter((id) => !manager.has(id)),
  });

  const unknownIdsNote = (unknown: string[]) =>
    unknown.length > 0
      ? `\nUnknown task ids (never started, or from a previous session): ${unknown.join(", ")}`
      : "";

  pi.registerTool({
    name: "subagent_status",
    label: "Subagent status",
    description:
      "Report the status of subagent tasks of this session (queued, running, completed, error, aborted), without waiting and without their output.",
    promptSnippet: "Check the progress of background subagent tasks",
    parameters: SubagentStatusParams,
    async execute(_toolCallId, params) {
      const ids = params.ids ?? [...tracker.instances.keys()];
      const { known, unknown } = partitionIds(ids);
      const lines = known
        .map((id) => tracker.get(id))
        .filter((instance) => instance !== undefined)
        .map((instance) => formatStatusLine(instance, deliveries));
      const text = (lines.length > 0 ? lines.join("\n") : "No subagent tasks in this session.") + unknownIdsNote(unknown);
      return { content: [{ type: "text" as const, text }], details: undefined };
    },
  });

  pi.registerTool({
    name: "subagent_wait",
    label: "Subagent wait",
    description:
      "Wait until background subagent tasks finish and return their results. Returns early on timeout with the finished results plus the status of the others, which keep running. Aborting this call stops the wait only, not the tasks.",
    promptSnippet: "Wait for background subagent results when no other work is left",
    parameters: SubagentWaitParams,
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const ids = params.ids ?? deliveries.undeliveredIds();
      const { known, unknown } = partitionIds(ids);
      if (known.length === 0) {
        const text = (ids.length === 0 ? "No background subagent results are pending." : "No known task ids to wait for.") +
          unknownIdsNote(unknown);
        return { content: [{ type: "text" as const, text }], details: undefined };
      }

      // Collect results as they settle, then stop at the first of: all
      // settled, timeout, or abort of this tool call.
      const finished = new Map<string, PersistedTaskSummary>();
      const allSettled = Promise.all(
        known.map((id) => manager.wait([id]).then(([summary]) => void finished.set(id, summary))),
      );
      const timeoutSeconds = Math.min(params.timeoutSeconds ?? DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const stop = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutSeconds * 1000);
        onAbort = () => resolve();
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) resolve();
      });
      try {
        await Promise.race([allSettled, stop]);
      } finally {
        clearTimeout(timer);
        if (onAbort) signal?.removeEventListener("abort", onAbort);
      }

      // Snapshot now: a task that settles after this point is left for the
      // push (or a later wait), never reported twice.
      const doneIds = known.filter((id) => finished.has(id));
      const pendingIds = known.filter((id) => !finished.has(id));
      deliveries.markDelivered(doneIds);

      const parts: string[] = [];
      let details: PersistedSubagentToolDetails | undefined;
      if (doneIds.length > 0) {
        const built = buildMultiTaskToolResult(doneIds.map((id) => finished.get(id)!), {
          toolCallId,
          sessionFile: getParentSessionPath(ctx, "getSessionFile"),
          taskIds: doneIds,
        });
        details = { ...built.details, taskIds: doneIds };
        parts.push(built.content[0].text);
      }
      if (pendingIds.length > 0) {
        const reason = signal?.aborted ? "Wait aborted" : `Timed out after ${timeoutSeconds}s`;
        const lines = pendingIds
          .map((id) => tracker.get(id))
          .filter((instance) => instance !== undefined)
          .map((instance) => formatStatusLine(instance, deliveries));
        parts.push(`${reason}; still running (not cancelled):\n${lines.join("\n")}`);
      }
      const text = parts.join("\n\n---\n\n") + unknownIdsNote(unknown);
      return { content: [{ type: "text" as const, text }], details };
    },
    renderResult(result, options, theme, _context) {
      return renderResult(result, options, theme);
    },
  });

  pi.registerTool({
    name: "subagent_cancel",
    label: "Subagent cancel",
    description:
      "Cancel queued or running subagent tasks. Their (aborted) results are reported the usual way: in the pushed message of their async call, or by subagent_wait.",
    promptSnippet: "Cancel background subagent tasks that are no longer needed",
    parameters: SubagentCancelParams,
    async execute(_toolCallId, params) {
      const { known, unknown } = partitionIds(params.ids);
      const active = known.filter((id) => {
        const status = tracker.get(id)?.status;
        return status === "queued" || status === "running";
      });
      manager.cancel(active);
      const alreadyDone = known.filter((id) => !active.includes(id));
      const lines: string[] = [];
      if (active.length > 0) lines.push(`Cancel requested: ${active.join(", ")}`);
      if (alreadyDone.length > 0) lines.push(`Already finished (nothing to cancel): ${alreadyDone.join(", ")}`);
      const text = (lines.length > 0 ? lines.join("\n") : "Nothing to cancel.") + unknownIdsNote(unknown);
      return { content: [{ type: "text" as const, text }], details: undefined };
    },
  });
}

/** One line per task for status reports: id, agent, state, activity, task preview. */
function formatStatusLine(instance: RuntimeSubagentInstance, deliveries: BackgroundDeliveries): string {
  const parts = [`${instance.id} [${instance.agent}] ${instance.status}`];
  const toolCalls = instance.summary.toolCalls.length;
  if (toolCalls > 0) parts.push(`${toolCalls} tool call(s)`);
  if (instance.pendingUIRequestCount > 0) parts.push("waiting for a user dialog");
  if (deliveries.isBackground(instance.id)) {
    parts.push(deliveries.undeliveredIds().includes(instance.id) ? "result not delivered yet" : "result delivered");
  }
  const preview = instance.task.length > 60 ? `${instance.task.slice(0, 60)}...` : instance.task;
  return `${parts.join(" · ")} — "${preview}"`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function failedToolResult(text: string, taskCount: number) {
  return {
    content: [{ type: "text" as const, text }],
    details: {
      mode: "tasks",
      taskCount,
      summaries: [],
      overallFailed: true,
    } as PersistedSubagentToolDetails,
  };
}

/** Snapshot of the given tasks as a partial (live) tool result. */
function liveToolUpdate(tracker: SubagentTracker, taskIds: string[]) {
  const instances = taskIds.map((id) => tracker.get(id)).filter((i) => i !== undefined);
  const doneCount = instances.filter(
    (i) => i.status === "completed" || i.status === "error" || i.status === "aborted",
  ).length;
  const runningCount = instances.filter((i) => i.status === "running").length;
  const liveSummaries: LiveTaskSummary[] = instances.map((i) => ({ ...i.summary }));
  return {
    content: [
      { type: "text" as const, text: `Tasks: ${doneCount}/${taskIds.length} done, ${runningCount} running...` },
    ],
    details: {
      mode: "tasks",
      live: true,
      taskCount: taskIds.length,
      summaries: liveSummaries,
    } as LiveSubagentToolDetails,
  };
}

/** Final tool result for a set of terminal task summaries. */
function buildToolResult(results: PersistedTaskSummary[], toolCallId: string, sessionFile: string | undefined) {
  const successCount = results.filter((r) => !isTaskFailed(r)).length;

  // Single-task: lean output
  if (results.length === 1) return buildSingleTaskToolResult(results[0], successCount === 0);

  // Keep the large-text recovery pointer beside the preview, while preserving
  // complete output strings in details for session-log extraction.
  return buildMultiTaskToolResult(results, { toolCallId, sessionFile });
}

/**
 * Model resolution adapter over the parent's available models, built from
 * documented public APIs. Resolves only against currently available models.
 */
function createModelRegistry(
  availableModels: ReadonlyArray<{ provider: string; id: string }>,
  parentModel: { provider?: string; id?: string } | undefined,
): ModelRegistry {
  return {
    resolve(modelStr: string) {
      if (modelStr.includes("/")) {
        const [provider, ...rest] = modelStr.split("/");
        const id = rest.join("/");
        // Try exact provider/id match first
        const found = availableModels.find((m) => m.provider === provider && m.id === id);
        if (found) return { provider: found.provider, id: found.id };

        // Fallback: the specified provider (e.g. "openai", "anthropic") may not exist
        // as an actual provider if the user has a proxy provider (e.g. "github-copilot")
        // that serves those models. Try matching by model id alone.
        const byId = availableModels.filter((m) => m.id === id);
        if (byId.length === 1) {
          return { provider: byId[0].provider, id: byId[0].id };
        }
        return undefined;
      }

      // For bare model ids, prefer the parent provider when it offers that model.
      const parentProvider = parentModel?.provider;
      if (parentProvider) {
        const providerMatch = availableModels.find((m) => m.provider === parentProvider && m.id === modelStr);
        if (providerMatch) {
          return { provider: providerMatch.provider, id: providerMatch.id };
        }
      }

      // Otherwise require a unique available bare-id match across providers.
      const matches = availableModels.filter((m) => m.id === modelStr);
      if (matches.length === 1) {
        return { provider: matches[0].provider, id: matches[0].id };
      }
      return undefined;
    },
    getParentModel() {
      if (parentModel?.provider && parentModel?.id) {
        return { provider: parentModel.provider, id: parentModel.id };
      }
      return undefined;
    },
  };
}
