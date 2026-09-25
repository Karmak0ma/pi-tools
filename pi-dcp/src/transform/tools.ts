import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ReducedState } from "../state/reducer.ts";
import { redactOldErrorArguments } from "../strategies/purge-errors.ts";
import { adapterForQuestion } from "../questions/registry.ts";

const CLEARED = "[Old tool result content cleared by pi-dcp]";
const SUMMARY_MOVED = "[summary text removed by pi-dcp: it is delivered by the compressed block itself]";
/**
 * Apply persisted pruning to outgoing messages, copy-on-write.
 *
 * Only a message that is actually redacted is copied; every other message is
 * returned by reference. The input is never mutated, because the pipeline may
 * still fall back to it unchanged (see transformOutgoingContext). Copying the
 * whole input here cost a full deep clone of every request.
 */
export function applyPersistedRedactions(messages: readonly AgentMessage[], state: ReducedState): AgentMessage[] {
  return messages.map((message) => redactMessage(message, state));
}

function redactMessage(message: AgentMessage, state: ReducedState): AgentMessage {
  if (message.role === "toolResult") {
    return state.toolPrunes.get(message.toolCallId)?.output ? { ...message, content: [{ type: "text", text: CLEARED }] } : message;
  }
  if (message.role !== "assistant") return message;
  let changed = false;
  const content = message.content.map((part) => {
    if (part.type !== "toolCall") return part;
    const redacted = redactToolArguments(part.id, part.name, part.arguments, state);
    if (redacted === part.arguments) return part;
    changed = true;
    return { ...part, arguments: redacted as Record<string, any> };
  });
  return changed ? { ...message, content } : message;
}

/** Returns the same object when nothing applies; every redactor is pure. */
function redactToolArguments(id: string, name: string, argumentsValue: unknown, state: ReducedState): unknown {
  const prune = state.toolPrunes.get(id);
  let result = argumentsValue;
  if (prune?.oldErrorInput) result = redactOldErrorArguments(result);
  if (prune?.questionInput) {
    const adapter = adapterForQuestion(name, result);
    if (adapter) result = adapter.redact(result);
  }
  if (name === "compress" && state.compressToolCallIds?.has(id)) result = redactCompressSummaries(result);
  return result;
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
 * The `summary` KEY IS REMOVED, not blanked. An earlier version substituted a
 * marker sentence as the value, which backfired on 2026-08-19: the model read
 * its own redacted past calls as a worked example of the call format, copied
 * the marker into a real compress call, and stored a block whose entire
 * content was that sentence. A redacted argument must never look like a
 * plausible value for the field it replaces. Omitting the key leaves nothing
 * to imitate, and costs the same number of tokens or fewer.
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
      if (typeof item.summary !== "string") return item;
      const { summary: _dropped, ...withoutSummary } = item;
      return withoutSummary;
    }),
  };
}

export function clearedMarker(): string { return CLEARED; }
export function compressSummaryMarker(): string { return SUMMARY_MOVED; }
