import { isTaskFailed, type PersistedSubagentToolDetails, type PersistedTaskSummary } from "./types.js";

/**
 * Keep concurrent subagent batches from flooding the parent context. The full
 * strings stay in persisted details, and the preview points to that source.
 */
export const MULTI_TASK_OUTPUT_LIMIT = 12_000;

/**
 * Where the full output of a result can be found again in the session log.
 * A normal call stores it in its tool result; a background call's push is a
 * custom message, found by the deliveryId stored in its details.
 */
export interface MultiTaskResultOptions {
  toolCallId: string;
  sessionFile?: string;
  /** Set for a pushed background result (custom_message entry). */
  deliveryId?: string;
  /** Task ids, same order as results. Shown so the parent can match results to ids it got from an async call. */
  taskIds?: string[];
}

export function buildMultiTaskToolResult(
  results: PersistedTaskSummary[],
  options: MultiTaskResultOptions,
): {
  content: [{ type: "text"; text: string }];
  details: PersistedSubagentToolDetails;
} {
  const successCount = results.filter((result) => !isTaskFailed(result)).length;
  const taskSections = results.map((result, taskIndex) => {
    const status = isTaskFailed(result) ? "failed" : "completed";
    const label = options.taskIds?.[taskIndex] ? `${options.taskIds[taskIndex]} · ${result.agent}` : result.agent;
    const parts: string[] = [`[${label}] ${status}`];
    if (result.errorMessage) parts.push(`Error: ${result.errorMessage}`);
    if (result.finalOutput) {
      parts.push(formatFinalOutputPreview(result.finalOutput, taskIndex, options));
    } else if (!result.errorMessage) {
      parts.push("(no output)");
    }
    if (result.stderrPreview) parts.push(`stderr: ${result.stderrPreview}`);
    return parts.join("\n\n");
  });

  return {
    content: [{
      type: "text",
      text: `Tasks: ${successCount}/${results.length} succeeded\n\n${taskSections.join("\n\n---\n\n")}`,
    }],
    details: {
      mode: "tasks",
      taskCount: results.length,
      summaries: results,
      overallFailed: successCount === 0,
    },
  };
}

function formatFinalOutputPreview(
  finalOutput: string,
  taskIndex: number,
  options: MultiTaskResultOptions,
): string {
  if (finalOutput.length <= MULTI_TASK_OUTPUT_LIMIT) return finalOutput;

  // Do not leave a dangling UTF-16 high surrogate at the preview boundary.
  let previewEnd = MULTI_TASK_OUTPUT_LIMIT;
  const lastIncluded = finalOutput.charCodeAt(previewEnd - 1);
  const firstOmitted = finalOutput.charCodeAt(previewEnd);
  if (lastIncluded >= 0xd800 && lastIncluded <= 0xdbff && firstOmitted >= 0xdc00 && firstOmitted <= 0xdfff) {
    previewEnd--;
  }

  const pointer = options.deliveryId
    ? options.sessionFile
      ? `Full output is saved in this session's message details. Run:\n${deliveryLogCommand(options.sessionFile, options.deliveryId, taskIndex)}`
      : `No persistent session file path is available. If this session has a JSONL log, find the custom_message whose details.deliveryId is ${options.deliveryId} and read details.summaries[${taskIndex}].finalOutput.`
    : options.sessionFile
      ? `Full output is saved in this session's tool-result details. Run:\n${sessionLogCommand(options.sessionFile, options.toolCallId, taskIndex)}`
      : `No persistent session file path is available. If this session has a JSONL log, find toolCallId ${options.toolCallId} and read message.details.summaries[${taskIndex}].finalOutput.`;

  return `${finalOutput.slice(0, previewEnd)}\n\n[Output truncated at ${MULTI_TASK_OUTPUT_LIMIT} characters. ${pointer}]`;
}

function sessionLogCommand(sessionFile: string, toolCallId: string, taskIndex: number): string {
  const filter = `select(.type=="message" and .message.role=="toolResult" and .message.toolCallId==$id) | .message.details.summaries[${taskIndex}].finalOutput`;
  return `jq -r --arg id ${shellQuote(toolCallId)} '${filter}' ${shellQuote(sessionFile)}`;
}

function deliveryLogCommand(sessionFile: string, deliveryId: string, taskIndex: number): string {
  const filter = `select(.type=="custom_message" and .details.deliveryId==$id) | .details.summaries[${taskIndex}].finalOutput`;
  return `jq -r --arg id ${shellQuote(deliveryId)} '${filter}' ${shellQuote(sessionFile)}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
