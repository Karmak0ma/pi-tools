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
import { type ModelRegistry, buildToolResolutionOptions } from "./resolver.js";
import { buildMultiTaskToolResult } from "./multi-task-result.js";
import { createBackend } from "./backends.js";
import { ChildExtensionUIBroker } from "./extension-ui-broker.js";
import { ExtensionUIDialogPresenter } from "./extension-ui-presenter.js";
import { SubagentTaskManager } from "./task-manager.js";
import { Throttle } from "./throttle.js";
import { SubagentTracker, setInstanceStatus } from "./tracker.js";
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
});

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
    manager.broker.cancelOwner(instance.id, "abort");
    instance.control?.abort();
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
    if (event.toolName !== "subagent") return;
    const details = event.details as PersistedSubagentToolDetails | undefined;
    if (!details?.overallFailed) return;
    return { isError: true };
  });

  // ─── Session Lifecycle ───────────────────────────────────────────────────

  const disposeSessionRuntime = async () => {
    if (tuiManager.isActive) tuiManager.exit();
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

      return buildToolResult(results, toolCallId, getParentSessionPath(ctx, "getSessionFile"));
    },

    renderCall(args, theme, _context) {
      return renderCall(args, theme);
    },

    renderResult(result, options, theme, _context) {
      return renderResult(result, options, theme);
    },
  });
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
  if (results.length === 1) {
    const r = results[0];
    const isFailed = successCount === 0;
    let outputText = r.finalOutput || "";
    // Surface the failure reason for the parent agent
    if (isFailed && r.errorMessage) {
      outputText = outputText ? `${outputText}\n\nError: ${r.errorMessage}` : `Error: ${r.errorMessage}`;
      if (r.stderrPreview) {
        outputText += `\nstderr: ${r.stderrPreview}`;
      }
    }
    if (!outputText) outputText = "(no output)";
    return {
      content: [{ type: "text" as const, text: outputText }],
      details: {
        mode: "tasks",
        taskCount: 1,
        summaries: results,
        overallFailed: isFailed,
      } as PersistedSubagentToolDetails,
    };
  }

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
