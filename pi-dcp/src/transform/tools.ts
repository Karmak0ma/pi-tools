import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { deepClone } from "../util/clone.ts";
import type { ReducedState } from "../state/reducer.ts";
import { redactOldErrorArguments } from "../strategies/purge-errors.ts";
import { adapterForQuestion } from "../questions/registry.ts";

const CLEARED = "[Old tool result content cleared by pi-dcp]";
const SUMMARY_MOVED = "[summary text removed by pi-dcp: it is delivered by the compressed block itself]";
export function applyPersistedRedactions(messages: readonly AgentMessage[], state: ReducedState): AgentMessage[] {
  const output = deepClone([...messages]); for (const message of output) {
    if (message.role === "assistant") for (const part of message.content) if (part.type === "toolCall") { const prune = state.toolPrunes.get(part.id); if (prune?.oldErrorInput) part.arguments = redactOldErrorArguments(part.arguments) as Record<string, any>; const question = prune?.questionInput; if (question) { const adapter = adapterForQuestion(part.name, part.arguments); if (adapter) part.arguments = adapter.redact(part.arguments) as Record<string, any>; } if (part.name === "compress" && state.compressToolCallIds?.has(part.id)) part.arguments = redactCompressSummaries(part.arguments) as Record<string, any>; }
    if (message.role === "toolResult") { const prune = state.toolPrunes.get(message.toolCallId); if (prune?.output) message.content = [{ type: "text", text: CLEARED }]; }
  } return output;
}

/**
 * Drop the authored summary text from a successful compress call.
 *
 * The assistant message that calls compress always sits *after* the range it
 * compresses, so no block can ever cover it. Left alone, every summary is
 * charged twice for the rest of the session: once inside these arguments and
 * once in the block replacement that pi-dcp renders. The range labels and the
 * topic are kept because they are small and they tell the model what it did.
 *
 * This runs after the baseline snapshot is built, so it cannot influence
 * projection hashes, unit identity, or the join.
 */
function redactCompressSummaries(argumentsValue: unknown): unknown {
  if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) return argumentsValue;
  const record = argumentsValue as Record<string, unknown>;
  if (!Array.isArray(record.content)) return argumentsValue;
  return {
    ...record,
    content: record.content.map((range) => {
      if (!range || typeof range !== "object" || Array.isArray(range)) return range;
      const item = range as Record<string, unknown>;
      return typeof item.summary === "string" ? { ...item, summary: SUMMARY_MOVED } : item;
    }),
  };
}

export function clearedMarker(): string { return CLEARED; }
export function compressSummaryMarker(): string { return SUMMARY_MOVED; }
