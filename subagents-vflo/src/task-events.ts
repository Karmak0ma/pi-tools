/**
 * Child event → task state.
 *
 * Every child event (RPC stream or Herdr synthetic session event) is folded
 * into the task's runtime instance by `applyChildEvent`. Before this module
 * existed, this logic lived inline in the subagent tool's execute() closure,
 * so the only code that could interpret a child's events was the tool call
 * that started it. Keeping it here, as one function with no I/O, gives:
 *
 * - one place that owns the status rules (what event moves a task to which
 *   status/lifecycle), testable without spawning processes;
 * - no dependency on a tool call, so a task can outlive the call that started
 *   it (background mode) and still be interpreted the same way.
 *
 * The function mutates the instance in place instead of returning a copy:
 * the inspector and the tool row hold references to the same instance, and
 * the event arrays are large, so copying would cost memory for no benefit.
 */

import type { ActiveChildToolCall } from "./rpc-extension-ui.js";
import { setInstanceStatus, type RuntimeSubagentInstance } from "./tracker.js";
import { type LiveTaskSummary, type SubagentLifecycleState, contextTokensFromUsage } from "./types.js";

/**
 * How urgently observers must be told about a change.
 * - `immediate`: status transitions and message boundaries — show now.
 * - `throttled`: high-rate streaming (text deltas, stderr) — rate-limit.
 * - `none`: the event changed nothing observers display.
 */
export type ChangeUrgency = "immediate" | "throttled" | "none";

/**
 * Fold one child event into the instance and report how urgently observers
 * must be notified.
 */
export function applyChildEvent(instance: RuntimeSubagentInstance, event: any): ChangeUrgency {
  instance.events.push(event);
  let urgency: ChangeUrgency = "none";
  const raise = (next: ChangeUrgency) => {
    if (next === "immediate" || (next === "throttled" && urgency === "none")) urgency = next;
  };

  // The RPC request has no toolCallId. Keep a runtime snapshot of every
  // active call so the broker can show all available context without
  // claiming a false correlation. Assistant messages are processed before
  // the child enters its tool hook, so this also covers the dialog's
  // pre-execution window.
  const activeToolCallChanged = trackActiveChildToolCalls(instance.activeToolCalls, event);
  if (activeToolCallChanged && event.type !== "message_end" && event.type !== "agent_settled") {
    raise("immediate");
  }

  if (event.type === "agent_start") {
    setInstanceStatus(instance, "running", {
      lifecycle: "running",
      isPartial: true,
      errorMessage: undefined,
      stopReason: undefined,
    });
    raise("immediate");
  }

  // Update live summary for streaming text. The same callback remains
  // attached after the first turn so inspector messages can update the
  // existing transcript as well.
  if (event.type === "message_start" && event.message?.role === "assistant") {
    instance.summary.isPartial = true;
  }
  if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
    instance.summary.isPartial = true;
    instance.summary.latestOutput += event.assistantMessageEvent.delta ?? "";
    raise("throttled");
  }
  if (event.type === "message_end" && event.message?.role === "assistant") {
    const msg = event.message;
    updateLiveUsage(instance, msg);
    instance.summary.lifecycle = lifecycleAfterAssistantMessage(instance.summary.lifecycle, msg.stopReason);
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
    // The live view may show an interrupted turn's partial transcript. The
    // terminal result overwrites this field with the final normal stop text
    // before persistence, so incomplete text cannot become the parent result.
    if (messageText) instance.summary.latestOutput = messageText;
    instance.summary.isPartial = false;
    raise("immediate");
  }
  if (event.type === "agent_settled") {
    // `agent_settled` is a Pi turn boundary, not the shared delegated-task
    // terminal signal. Herdr can emit the same shape for a turn that was
    // interrupted, and the RPC backend still performs process-close
    // classification after this event. The awaited handle.result is
    // authoritative.
    setInstanceStatus(instance, "running", { isPartial: false });
    raise("immediate");
  }
  if (event.type === "subagent_turn_aborted") {
    // Herdr: the child's turn was interrupted (Escape in its pane) but the
    // session lives — an interrupted turn is never a completion; the final
    // result decides the outcome.
    setInstanceStatus(instance, "running", {
      lifecycle: "interrupted",
      isPartial: false,
      stopReason: "aborted",
    });
    raise("immediate");
  }

  return urgency;
}

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

/** Map one assistant message boundary to the live delegated-task lifecycle. */
export function lifecycleAfterAssistantMessage(
  current: SubagentLifecycleState,
  stopReason: string | undefined,
): SubagentLifecycleState {
  switch (stopReason) {
    case "aborted":
      return "interrupted";
    case "error":
    case "toolUse":
      return "waiting";
    case "stop":
      return "completed";
    case undefined:
      return "running";
    default:
      return current;
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
