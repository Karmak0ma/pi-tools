/**
 * Subagent Extension — Entry Point
 *
 * Delegates tasks to specialized subagents with isolated context windows.
 * Each task runs as a separate pi subprocess.
 *
 * Adapted from the official pi subagent example.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { discoverAgents, findAgent, formatAgentList } from "./agents.js";
import { resolveChildExtensions } from "./child-extensions.js";
import { renderCall, renderResult } from "./render.js";
import { type ModelRegistry, resolveCwd, resolveModel, resolveTools } from "./resolver.js";
import { mapWithConcurrencyLimit, runChild } from "./runner.js";
import { ChildExtensionUIBroker } from "./extension-ui-broker.js";
import { ExtensionUIDialogPresenter } from "./extension-ui-presenter.js";
import { SubagentTracker, createInstance, type RuntimeSubagentInstance } from "./tracker.js";
import {
  type LiveSubagentToolDetails,
  type LiveTaskSummary,
  MAX_CONCURRENT,
  MAX_TOTAL_TASKS,
  type PersistedSubagentToolDetails,
  type PersistedTaskSummary,
  type TaskItem,
  type TaskStatus,
  THINKING_LEVELS,
  contextTokensFromUsage,
  emptyUsage,
  isTaskFailed,
} from "./types.js";
import { SubagentTuiManager } from "./tui.js";
import type { ActiveChildToolCall } from "./rpc-extension-ui.js";
export { INSPECTOR_VISIBILITY_CHANNEL } from "./tui.js";
export type { InspectorVisibilityEvent } from "./tui.js";

// ─── Tool Schema ─────────────────────────────────────────────────────────────

const TaskItemSchema = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Detailed task for the agent" }),
  model: Type.Optional(
    Type.String({
      description:
        'Optional model override. Accepted forms: exact "provider/model-id" or exact unique bare model-id. If omitted, build inherits the parent session model, explore uses openai-codex/gpt-5.6-luna with low thinking effort, and custom agents may use a model from frontmatter. Fuzzy aliases are not allowed.',
    }),
  ),
  cwd: Type.Optional(Type.String({ description: "Working directory override" })),
  thinking: Type.Optional(
    Type.Union(
      THINKING_LEVELS.map((level) => Type.Literal(level)),
      {
        description:
          'Optional thinking effort level for the subagent. Values: "off", "minimal", "low", "medium", "high", "xhigh". If omitted, uses the model\'s default thinking level.',
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

export default function (pi: ExtensionAPI) {
  const tracker = new SubagentTracker();
  let broker: ChildExtensionUIBroker;
  let tuiManager: SubagentTuiManager;
  let abortInstanceForManager: (instance: RuntimeSubagentInstance) => void = () => {};

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

  const createBroker = (): ChildExtensionUIBroker => new ChildExtensionUIBroker({
    onDiagnostic: reportBrokerDiagnostic,
    onPendingCountChange(instanceId, count) {
      const instance = tracker.get(instanceId);
      if (!instance) return;
      instance.pendingUIRequestCount = count;
      if (tuiManager.isActive) tuiManager.requestRender();
    },
  });

  broker = createBroker();
  tuiManager = new SubagentTuiManager(tracker, (instance) => abortInstanceForManager(instance));

  abortInstanceForManager = (instance) => {
    if (instance.status !== "running") return;
    broker.cancelOwner(instance.id, "abort");
    instance.control?.abort();
    instance.status = "aborted";
    instance.summary.status = "aborted";
    instance.summary.isPartial = false;
    tuiManager.requestRender();
  };

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
    const oldBroker = broker;
    await oldBroker.dispose();
    if (tuiManager.isActive) tuiManager.exit();
    await tracker.killAll();
    tracker.clear();
    // A session replacement must not inherit callbacks closed over the old
    // broker. New executions use this fresh session-scoped broker.
    broker = createBroker();
  };

  pi.on("session_shutdown", async (_event, _ctx) => {
    await disposeSessionRuntime();
  });

  pi.on("session_before_switch", async (_event, _ctx) => {
    await disposeSessionRuntime();
  });

  // ─── TUI Shortcuts / Commands (Phase 3) ──────────────────────────────────

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
      `Only set tasks[i].model when the user explicitly asks for a different model. If model is omitted, build inherits the parent session model, explore uses openai-codex/gpt-5.6-luna with low thinking effort, and custom agents may use a model from their frontmatter.`,
      `Only set tasks[i].thinking when the user explicitly asks for a different thinking effort level. Values: "off", "minimal", "low", "medium", "high", "xhigh". If omitted, the child uses the model's default thinking level.`,
      `When using subagent, provide highly detailed task descriptions so the agent can work autonomously. Specify what to return. Example: { "tasks": [{ "agent": "explore", "task": "Research auth-related source files. Report paths and open questions. Do not edit files." }, { "agent": "explore", "task": "Research auth-related tests. Report coverage gaps. Do not edit files." }] }`,
    ],
    parameters: SubagentParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const tasks = params.tasks as TaskItem[];
      // Capture the broker for this invocation. A session switch can replace
      // the extension-level broker while stale child callbacks are still
      // unwinding; those callbacks must never reach the fresh broker.
      const executionBroker = broker;

      // Validate task count
      if (tasks.length > MAX_TOTAL_TASKS) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Too many tasks (${tasks.length}). Maximum is ${MAX_TOTAL_TASKS}. Please reduce batch size.`,
            },
          ],
          details: {
            mode: "tasks",
            taskCount: tasks.length,
            summaries: [],
            overallFailed: true,
          } as PersistedSubagentToolDetails,
        };
      }

      // Discover agents
      const discovery = discoverAgents(ctx.cwd);
      const agents = discovery.agents;
      const availableModels = await ctx.modelRegistry.getAvailable();

      // Build model registry adapter from documented public APIs.
      const registry: ModelRegistry = {
        resolve(modelStr: string) {
          // Resolve only against currently available models.
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
          const parentProvider = ctx.model?.provider;
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
          const model = ctx.model;
          if (model?.provider && model?.id) {
            return { provider: model.provider, id: model.id };
          }
          return undefined;
        },
      };

      // Get parent active tool names for inheritance from documented ExtensionAPI method.
      const parentActiveToolNames = pi.getActiveTools();

      // Generate unique task IDs and create tracker instances immediately
      const batchId = tracker.nextBatchId();
      const taskInstances = tasks.map((task, index) => {
        const id = `task-${Date.now()}-${index}`;
        const agent = findAgent(agents, task.agent);
        const instance = createInstance({
          id,
          batchId,
          agent: task.agent,
          source: agent?.source || "builtin",
          task: task.task,
          cwd: ctx.cwd,
          model: undefined,
        });
        tracker.add(instance);
        return { id, task, instance };
      });

      const taskIds = taskInstances.map(({ id }) => id);

      // Create throttled updater for this execution
      const updater = new ThrottledUpdater(onUpdate, tracker, taskInstances.length, taskIds, tuiManager);

      // Emit initial update showing all tasks as queued
      updater.immediate();

      // Pre-validate all tasks
      const validationErrors: Array<{ index: number; error: string }> = [];

      for (let i = 0; i < taskInstances.length; i++) {
        const { task } = taskInstances[i];
        const agent = findAgent(agents, task.agent);
        if (!agent) {
          validationErrors.push({
            index: i,
            error: `Agent "${task.agent}" not found. Available agents:\n${formatAgentList(agents)}`,
          });
        }
      }

      if (validationErrors.length === taskInstances.length) {
        // All tasks failed validation
        return {
          content: [
            {
              type: "text" as const,
              text: validationErrors.map((e) => `Task ${e.index + 1}: ${e.error}`).join("\n\n"),
            },
          ],
          details: {
            mode: "tasks",
            taskCount: taskInstances.length,
            summaries: [],
            overallFailed: true,
          } as PersistedSubagentToolDetails,
        };
      }

      // Execute tasks with concurrency control. One listener covers the whole
      // batch because the tool signal can abort several child processes at
      // once; register it before runChild adds its own listener.
      const cancelInvocation = () => {
        for (const { instance } of taskInstances) {
          executionBroker.cancelOwner(instance.id, "abort");
        }
      };
      if (signal) signal.addEventListener("abort", cancelInvocation, { once: true });

      let results: PersistedTaskSummary[];
      try {
        results = await mapWithConcurrencyLimit(
          taskInstances,
          MAX_CONCURRENT,
          async ({ id, task, instance }, index) => {
          // Check if abort was signaled before starting this queued task
          if (signal?.aborted) {
            tracker.updateStatus(id, "aborted", { errorMessage: "Aborted before start" });
            updater.immediate();
            return makeErrorSummaryFromInstance(instance, "Aborted before start");
          }

          const agent = findAgent(agents, task.agent);
          if (!agent) {
            // Pre-validated failure
            const err = validationErrors.find((e) => e.index === index);
            const errorMsg = err?.error || "Agent not found";
            tracker.updateStatus(id, "error", { errorMessage: errorMsg });
            updater.immediate();
            return makeErrorSummary(id, task, errorMsg);
          }

          // Instance already created during pre-allocation
          instance.source = agent.source;
          instance.summary.source = agent.source;

          // Resolve model
          const modelResult = resolveModel(task, agent, registry);
          instance.warnings.push(...modelResult.warnings);
          instance.summary.warnings = [...instance.warnings];

          if (!modelResult.model) {
            tracker.updateStatus(id, "error", {
              errorMessage: "No model available",
            });
            updater.immediate();
            return makeErrorSummaryFromInstance(instance, "No model available");
          }
          instance.model = modelResult.model;
          instance.summary.model = modelResult.model;
          // Resolve the same model metadata used by the parent registry so the
          // inspector can show context capacity before the first response.
          const modelParts = modelResult.model.split("/");
          const resolvedModel = availableModels.find(
            (availableModel) =>
              availableModel.provider === modelParts[0] &&
              availableModel.id === modelParts.slice(1).join("/"),
          );
          instance.contextWindow = resolvedModel?.contextWindow;

          // Resolve tools
          const toolResult = resolveTools(agent, parentActiveToolNames);
          instance.warnings.push(...toolResult.warnings);
          instance.summary.warnings = [...instance.warnings];

          if (toolResult.error) {
            tracker.updateStatus(id, "error", { errorMessage: toolResult.error });
            updater.immediate();
            return makeErrorSummaryFromInstance(instance, toolResult.error);
          }

          // Resolve cwd
          const cwdResult = resolveCwd(task, ctx.cwd);
          if (cwdResult.error) {
            tracker.updateStatus(id, "error", { errorMessage: cwdResult.error });
            updater.immediate();
            return makeErrorSummaryFromInstance(instance, cwdResult.error);
          }
          instance.cwd = cwdResult.cwd;
          instance.summary.cwd = cwdResult.cwd;
          instance.thinking = task.thinking ?? agent.thinking;
          instance.tools = [...toolResult.tools];

          // Mark as running
          tracker.updateStatus(id, "running");

          // Emit streaming update (immediate — status transition)
          updater.immediate();

          // Run child process
          try {
            const childExtensions = resolveChildExtensions();
            const childResult = await runChild({
              resolvedModel: modelResult.model,
              resolvedTools: toolResult.tools,
              resolvedCwd: cwdResult.cwd,
              agentName: agent.name,
              agentPrompt: agent.systemPrompt,
              taskText: task.task,
              thinking: instance.thinking,
              childExtensionPaths: childExtensions.paths,
              signal,
              onEvent(event) {
                instance.events.push(event);

                // The RPC request has no toolCallId. Keep a runtime snapshot
                // of every active call so the broker can show all available
                // context without claiming a false correlation. Assistant
                // messages are processed before the child enters its tool hook,
                // so this also covers the dialog's pre-execution window.
                const activeToolCallChanged = trackActiveChildToolCalls(instance.activeToolCalls, event);
                if (activeToolCallChanged && event.type !== "message_end" && event.type !== "agent_settled") {
                  updater.immediate();
                }

                if (event.type === "agent_start") {
                  tracker.updateStatus(id, "running", { isPartial: true, errorMessage: undefined });
                  updater.immediate();
                }

                // Update live summary for streaming text. The same callback
                // remains attached after the first turn so inspector messages
                // can update the existing transcript as well.
                if (event.type === "message_start" && event.message?.role === "assistant") {
                  instance.summary.isPartial = true;
                }
                if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
                  instance.summary.isPartial = true;
                  instance.summary.latestOutput += event.assistantMessageEvent.delta ?? "";
                  updater.throttled();
                }
                if (event.type === "message_end" && event.message?.role === "assistant") {
                  const msg = event.message;
                  updateLiveUsage(instance, msg);
                  let messageText = "";
                  if (Array.isArray(msg.content)) {
                    for (const part of msg.content) {
                      if (part.type === "text") messageText += (messageText ? "\n" : "") + part.text;
                      if (part.type === "toolCall") {
                        const argsStr = JSON.stringify(part.arguments || {});
                        instance.summary.toolCalls.push({
                          name: part.name,
                          argsPreview: argsStr.length > 80 ? argsStr.slice(0, 80) + "..." : argsStr,
                        });
                      }
                    }
                  }
                  if (messageText) instance.summary.latestOutput = messageText;
                  instance.summary.isPartial = false;
                  updater.immediate();
                }
                if (event.type === "agent_settled") {
                  tracker.updateStatus(id, "completed", { isPartial: false });
                  updater.immediate();
                }
              },
              onExtensionUIRequest(request, channel) {
                const owner = {
                  instanceId: instance.id,
                  agent: instance.agent,
                  task: instance.task,
                  cwd: instance.cwd,
                };
                const presenter = new ExtensionUIDialogPresenter(ctx, {
                  isInspectorActive: () => tuiManager.isActive,
                  isInspectorOverlayFocused: () => tuiManager.isOverlayFocusedVisible,
                  focusInspectorOverlayForDialog: () => tuiManager.focusInspectorOverlayForDialog(),
                  onDiagnostic: (message) => reportBrokerDiagnostic(message, owner),
                });
                executionBroker.enqueue({
                  owner,
                  request,
                  channel,
                  presenter,
                  activeToolCalls: Array.from(instance.activeToolCalls.values()),
                });
                instance.pendingUIRequestCount = executionBroker.getOwnerPendingCount(instance.id);
                updater.immediate();
              },
              onStderr(data) {
                instance.stderr += data;
                instance.summary.stderrPreview = instance.stderr.slice(0, 500);
                updater.throttled();
              },
              onProcessReady(proc, control) {
                instance.process = proc;
                instance.control = control;
              },
              onProcessExit(code) {
                executionBroker.cancelOwner(instance.id, "exit");
                instance.activeToolCalls.clear();
                instance.pendingUIRequestCount = 0;
                instance.process = undefined;
                instance.control = undefined;
                if (instance.status === "running") {
                  tracker.updateStatus(id, code === 0 ? "completed" : "error", code === 0 ? undefined : {
                    errorMessage: instance.summary.errorMessage || `Subagent exited with code ${code ?? 1}`,
                    isPartial: false,
                  });
                  updater.immediate();
                }
              },
            });

            // Update instance with results
            instance.summary.usage = childResult.usage;
            instance.summary.latestOutput = childResult.finalOutput;
            instance.summary.toolCalls = childResult.toolCalls;
            instance.summary.stopReason = childResult.stopReason;
            instance.summary.errorMessage = childResult.errorMessage;
            instance.summary.model = childResult.model || instance.model;

            const isError = childResult.exitCode !== 0 || isTaskFailed(childResult);

            if (isError) {
              tracker.updateStatus(id, childResult.stopReason === "aborted" ? "aborted" : "error");
            } else {
              tracker.updateStatus(id, "completed");
            }

            // Emit update after completion (immediate — status transition)
            updater.immediate();

            return makePersistedSummary(instance);
          } catch (err: any) {
            tracker.updateStatus(id, "error", {
              errorMessage: err.message || "Unknown error",
            });
            updater.immediate();
            return makeErrorSummaryFromInstance(instance, err.message || "Unknown error");
          } finally {
            // runChild closes the RPC child after the agent settles; the
            // process/control references are cleared by onProcessExit.
          }
          },
        );
      } finally {
        signal?.removeEventListener("abort", cancelInvocation);
      }

      // Flush any pending throttled updates before building final result
      updater.flush();

      // Build final result
      const successCount = results.filter((r) => !isTaskFailed(r)).length;

      // Single-task: lean output
      if (results.length === 1) {
        const r = results[0];
        const isFailed = successCount === 0;
        let outputText = r.finalOutput || "";
        // Surface the failure reason for the parent agent
        if (isFailed && r.errorMessage) {
          outputText = outputText
            ? `${outputText}\n\nError: ${r.errorMessage}`
            : `Error: ${r.errorMessage}`;
          if (r.stderrPreview) {
            outputText += `\nstderr: ${r.stderrPreview}`;
          }
        }
        if (!outputText) outputText = "(no output)";
        return {
          content: [{ type: "text", text: outputText }],
          details: {
            mode: "tasks",
            taskCount: 1,
            summaries: results,
            overallFailed: isFailed,
          } as PersistedSubagentToolDetails,
        };
      }

      // Multi-task: structured, parent-readable output
      const taskSections = results.map((r) => {
        const failed = isTaskFailed(r);
        const status = failed ? "failed" : "completed";
        const parts: string[] = [`[${r.agent}] ${status}`];
        if (r.errorMessage) parts.push(`Error: ${r.errorMessage}`);
        if (r.finalOutput) {
          const output = r.finalOutput.length > 4000 ? `${r.finalOutput.slice(0, 4000)}\n... (truncated)` : r.finalOutput;
          parts.push(output);
        } else if (!r.errorMessage) {
          parts.push("(no output)");
        }
        if (r.stderrPreview) {
          parts.push(`stderr: ${r.stderrPreview}`);
        }
        return parts.join("\n\n");
      });

      return {
        content: [
          {
            type: "text",
            text: `Tasks: ${successCount}/${results.length} succeeded\n\n${taskSections.join("\n\n---\n\n")}`,
          },
        ],
        details: {
          mode: "tasks",
          taskCount: results.length,
          summaries: results,
          overallFailed: successCount === 0,
        } as PersistedSubagentToolDetails,
      };
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

/**
 * Track both the assistant's announced call and the executor's later snapshot
 * in one map. The shared id makes the executor update replace the provisional
 * entry instead of making the modal show duplicate calls.
 *
 * Arguments are deliberately kept only in this runtime map. They are needed
 * for the approval modal, but must not enter persisted summaries, diagnostics,
 * or error text.
 */
export function trackActiveChildToolCalls(
  activeToolCalls: Map<string, ActiveChildToolCall>,
  event: any,
): boolean {
  let changed = false;

  // Current RPC streaming events do not carry a cumulative assistant message.
  // toolcall_end is the first streaming event with the complete ToolCall shape.
  if (event.type === "message_update" && event.assistantMessageEvent?.type === "toolcall_end") {
    changed = announceActiveChildToolCall(activeToolCalls, event.assistantMessageEvent.toolCall) || changed;
  }

  // message_end is authoritative and carries ToolCall fields as id/name/
  // arguments, not the tool_execution_* fields used by the executor.
  if (event.type === "message_end" && event.message?.role === "assistant" && Array.isArray(event.message.content)) {
    for (const part of event.message.content) {
      if (part?.type === "toolCall") {
        changed = announceActiveChildToolCall(activeToolCalls, part) || changed;
      }
    }
  }

  // The executor's event is authoritative when it arrives. Preserve the
  // announcement timestamp so FIFO presentation order does not jump when the
  // same call is upgraded in place.
  if (event.type === "tool_execution_start" && event.toolCallId) {
    const toolCallId = String(event.toolCallId);
    const previous = activeToolCalls.get(toolCallId);
    activeToolCalls.set(toolCallId, {
      toolCallId,
      toolName: String(event.toolName || previous?.toolName || "unknown"),
      args: event.args ?? event.arguments ?? previous?.args,
      startedAt: previous?.startedAt ?? Date.now(),
    });
    changed = true;
  }

  if (event.type === "tool_execution_end" && event.toolCallId) {
    changed = activeToolCalls.delete(String(event.toolCallId)) || changed;
  }

  if (event.type === "tool_result_end") {
    const fallbackToolCallId = event.toolCallId || event.message?.toolCallId;
    if (fallbackToolCallId) {
      changed = activeToolCalls.delete(String(fallbackToolCallId)) || changed;
    }
  }

  if (event.type === "agent_end" || event.type === "agent_settled") {
    // A guardrail can block an announced call before execution events exist.
    // Clear at the end of that agent run as a terminal fallback; process exit
    // cleanup remains the protection for an aborted child that emits no end.
    if (activeToolCalls.size > 0) {
      activeToolCalls.clear();
      changed = true;
    }
  }

  return changed;
}

function announceActiveChildToolCall(
  activeToolCalls: Map<string, ActiveChildToolCall>,
  part: any,
): boolean {
  if (
    part?.type !== "toolCall" ||
    typeof part.id !== "string" ||
    part.id.length === 0 ||
    typeof part.name !== "string" ||
    part.name.length === 0
  ) {
    return false;
  }

  const previous = activeToolCalls.get(part.id);
  activeToolCalls.set(part.id, {
    toolCallId: part.id,
    toolName: part.name,
    args: part.arguments ?? {},
    startedAt: previous?.startedAt ?? Date.now(),
  });
  return true;
}

/**
 * Throttled update emitter. Streaming events (text_delta, stderr) are rate-limited
 * to avoid flooding pi's TUI with re-renders. Status transitions and message_end
 * events are emitted immediately.
 */
class ThrottledUpdater {
  private lastEmitTime = 0;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly THROTTLE_MS = 150;

  constructor(
    private onUpdate: ((partial: any) => void) | undefined,
    private tracker: SubagentTracker,
    private totalCount: number,
    private taskIds: string[],
    private tuiManager?: SubagentTuiManager,
  ) {}

  /** Emit immediately — use for status transitions and completion events. */
  immediate(): void {
    this.cancelPending();
    this.lastEmitTime = Date.now();
    this.doEmit();
  }

  /** Throttled emit — use for text_delta and stderr events. */
  throttled(): void {
    const now = Date.now();
    const elapsed = now - this.lastEmitTime;
    if (elapsed >= this.THROTTLE_MS) {
      this.lastEmitTime = now;
      this.doEmit();
    } else if (!this.pendingTimer) {
      this.pendingTimer = setTimeout(() => {
        this.pendingTimer = null;
        this.lastEmitTime = Date.now();
        this.doEmit();
      }, this.THROTTLE_MS - elapsed);
    }
  }

  /** Flush any pending throttled update and clean up. */
  flush(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
      this.doEmit();
    }
  }

  private cancelPending(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
  }

  private doEmit(): void {
    if (!this.onUpdate && !this.tuiManager) return;

    const invocationIds = new Set(this.taskIds);
    const allInstances = this.tracker.getOrdered().filter((i) => invocationIds.has(i.id));
    const doneCount = allInstances.filter(
      (i) => i.status === "completed" || i.status === "error" || i.status === "aborted",
    ).length;
    const runningCount = allInstances.filter((i) => i.status === "running").length;

    const liveSummaries: LiveTaskSummary[] = allInstances.map((i) => ({ ...i.summary }));

    if (this.onUpdate) {
      // When inspector is active, suppress tool-row updates (hidden behind overlay)
      if (!this.tuiManager?.isActive) {
        this.onUpdate({
          content: [
            {
              type: "text",
              text: `Tasks: ${doneCount}/${this.totalCount} done, ${runningCount} running...`,
            },
          ],
          details: {
            mode: "tasks",
            live: true,
            taskCount: this.totalCount,
            summaries: liveSummaries,
          } as LiveSubagentToolDetails,
        });
      }
    }

    // Notify TUI manager to re-render if active
    if (this.tuiManager?.isActive) {
      this.tuiManager.requestRender();
    }
  }
}

/** Legacy wrapper for call sites that don't use the throttled class (validation errors, etc.) */
function emitUpdate(
  onUpdate: ((partial: any) => void) | undefined,
  tracker: SubagentTracker,
  totalCount: number,
  taskIds: string[],
  tuiManager?: SubagentTuiManager,
): void {
  if (!onUpdate && !tuiManager) return;

  const invocationIds = new Set(taskIds);
  const allInstances = tracker.getOrdered().filter((i) => invocationIds.has(i.id));
  const doneCount = allInstances.filter(
    (i) => i.status === "completed" || i.status === "error" || i.status === "aborted",
  ).length;
  const runningCount = allInstances.filter((i) => i.status === "running").length;

  const liveSummaries: LiveTaskSummary[] = allInstances.map((i) => ({ ...i.summary }));

  if (onUpdate) {
    onUpdate({
      content: [
        {
          type: "text",
          text: `Tasks: ${doneCount}/${totalCount} done, ${runningCount} running...`,
        },
      ],
      details: {
        mode: "tasks",
        live: true,
        taskCount: totalCount,
        summaries: liveSummaries,
      } as LiveSubagentToolDetails,
    });
  }

  // Notify TUI manager to re-render if active
  if (tuiManager?.isActive) {
    tuiManager.requestRender();
  }
}

/**
 * Copy usage from each completed assistant response into the live summary.
 *
 * RPC streaming events intentionally omit cumulative partial assistant
 * snapshots, so `message_end` is the earliest authoritative point at which
 * token counts are available. Updating here keeps the inspector current after
 * every model turn instead of waiting for the child process to exit.
 */
function updateLiveUsage(instance: { summary: LiveTaskSummary }, message: any): void {
  const usage = message?.usage;
  if (!usage) return;

  const current = instance.summary.usage;
  current.input += usage.input || 0;
  current.output += usage.output || 0;
  current.cacheRead += usage.cacheRead || 0;
  current.cacheWrite += usage.cacheWrite || 0;
  current.cost += usage.cost?.total || 0;
  current.turns++;

  const contextTokens = contextTokensFromUsage(usage);
  if (contextTokens > 0) current.contextTokens = contextTokens;
}

function makePersistedSummary(instance: {
  agent: string;
  source: string;
  task: string;
  cwd: string;
  model?: string;
  warnings: string[];
  summary: LiveTaskSummary;
  stderr: string;
  status: TaskStatus;
}): PersistedTaskSummary {
  const failed = isTaskFailed({
    status: instance.status,
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
    stopReason: instance.summary.stopReason,
    errorMessage: instance.summary.errorMessage,
    stderrPreview: instance.stderr ? instance.stderr.slice(0, 500) : undefined,
    toolCalls: [...instance.summary.toolCalls],
    finalOutput: instance.summary.latestOutput,
    usage: { ...instance.summary.usage },
    failed,
  };
}

function makeErrorSummary(_id: string, task: TaskItem, error: string): PersistedTaskSummary {
  return {
    agent: task.agent,
    source: "builtin",
    task: task.task,
    cwd: "",
    warnings: [],
    errorMessage: error,
    toolCalls: [],
    finalOutput: "",
    usage: emptyUsage(),
    failed: true,
  };
}

function makeErrorSummaryFromInstance(
  instance: { agent: string; source: string; task: string; cwd: string; warnings: string[]; summary: LiveTaskSummary },
  error: string,
): PersistedTaskSummary {
  return {
    agent: instance.agent,
    source: instance.summary.source,
    task: instance.task,
    cwd: instance.cwd,
    warnings: [...instance.warnings],
    errorMessage: error,
    toolCalls: [...instance.summary.toolCalls],
    finalOutput: instance.summary.latestOutput || "",
    usage: { ...instance.summary.usage },
    failed: true,
  };
}
