import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { BranchSummaryEntry, CompactionEntry, CustomMessageEntry, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { fingerprintMessage } from "./fingerprint.ts";
import type { ProjectedMessage } from "./types.ts";

export type ProjectionResult =
  | {
    ok: true;
    messages: ProjectedMessage[];
    /**
     * Entries on the branch that exist in the session file but are
     * deliberately not projected (see `isProviderDroppedAssistant`). Callers
     * that ask "does this entry id still exist on the branch?" - block
     * coverage and block anchors - must treat these as present, otherwise a
     * block created before this rule existed would silently go unavailable
     * and the whole context would expand again.
     */
    unprojectedEntryIds: Set<string>;
  }
  | { ok: false; reason: "projection_unsupported" };

/**
 * Pi keeps incomplete assistant turns in the session file, but pi-ai's
 * `transformMessages` removes every `error` or `aborted` assistant turn before
 * provider dispatch. The removal depends only on stopReason: a turn can retain
 * partial text, reasoning, or tool calls and still disappear from the incoming
 * list DCP receives. Empty assistant turns are also omitted because they carry
 * no provider-visible content.
 *
 * DCP's expected projection must follow that boundary. Otherwise one persisted
 * partial turn permanently makes `joinProjectedMessages` fail closed with
 * `join_ambiguous`, and every later request is sent without compression.
 *
 * Omitting these entries is safe if another Pi path keeps one in the incoming
 * list: the join treats it as an unmatched extra and the pipeline passes it
 * through byte-for-byte. `unprojectedEntryIds` still preserves its identity for
 * legacy block coverage and anchors.
 */
function isProviderDroppedAssistant(entry: SessionEntry): boolean {
  if (entry.type !== "message") return false;
  const message = (entry as SessionMessageEntry).message;
  if (message.role !== "assistant") return false;
  return message.stopReason === "error"
    || message.stopReason === "aborted"
    || (Array.isArray(message.content) && message.content.length === 0);
}

/** Versioned Pi 0.84.1 projection adapter. Keep this local: private Pi internals are not imported. */
export function projectContextEntries(entries: readonly SessionEntry[]): ProjectionResult {
  const messages: ProjectedMessage[] = [];
  const unprojectedEntryIds = new Set<string>();
  for (const entry of entries) {
    if (typeof entry.id !== "string" || !entry.id || typeof entry.timestamp !== "string" || !Number.isFinite(Date.parse(entry.timestamp))) return { ok: false, reason: "projection_unsupported" };
    if (isProviderDroppedAssistant(entry)) { unprojectedEntryIds.add(entry.id); continue; }
    let projected: AgentMessage[];
    switch (entry.type) {
      case "message": projected = [(entry as SessionMessageEntry).message]; break;
      case "custom_message": {
        const custom = entry as CustomMessageEntry;
        projected = [{ role: "custom", customType: custom.customType, content: custom.content, display: custom.display, details: custom.details, timestamp: Date.parse(custom.timestamp) }];
        break;
      }
      case "compaction": {
        const compaction = entry as CompactionEntry;
        projected = [{ role: "compactionSummary", summary: compaction.summary, tokensBefore: compaction.tokensBefore, timestamp: Date.parse(compaction.timestamp) }];
        break;
      }
      case "branch_summary": {
        const branch = entry as BranchSummaryEntry;
        if (!branch.summary) projected = []; else projected = [{ role: "branchSummary", summary: branch.summary, fromId: branch.fromId, timestamp: Date.parse(branch.timestamp) }];
        break;
      }
      case "custom": case "thinking_level_change": case "model_change": case "label": case "session_info": projected = []; break;
      default: return { ok: false, reason: "projection_unsupported" };
    }
    for (const message of projected) if (!isValidProjectedMessage(message)) return { ok: false, reason: "projection_unsupported" };
    projected.forEach((message, projection) => messages.push({
      key: { kind: "entry", entryId: entry.id, projection }, message,
      fingerprint: fingerprintMessage(message), toolCallIds: toolIds(message),
    }));
  }
  return { ok: true, messages, unprojectedEntryIds };
}

function isValidProjectedMessage(message: AgentMessage): boolean {
  if (!message || typeof message !== "object" || typeof message.role !== "string") return false;
  if (message.role === "user") return typeof message.content === "string" || (Array.isArray(message.content) && message.content.every((part) => part && typeof part === "object" && ((part as { type?: string }).type === "text" ? typeof (part as { text?: unknown }).text === "string" : (part as { type?: string }).type === "image" && typeof (part as { data?: unknown }).data === "string" && typeof (part as { mimeType?: unknown }).mimeType === "string")));
  if (message.role === "assistant") return Array.isArray(message.content) && message.content.every((part) => part && typeof part === "object" && ((part as { type?: string }).type === "text" && typeof (part as { text?: unknown }).text === "string" || (part as { type?: string }).type === "thinking" && typeof (part as { thinking?: unknown }).thinking === "string" || (part as { type?: string }).type === "toolCall" && typeof (part as { id?: unknown }).id === "string" && typeof (part as { name?: unknown }).name === "string" && (part as { arguments?: unknown }).arguments !== undefined));
  if (message.role === "toolResult") return typeof message.toolCallId === "string" && typeof message.toolName === "string" && Array.isArray(message.content);
  // Pi sends shell history through extension context handlers in this durable
  // shape. Its later convertToLlm step owns both text conversion and the
  // excludeFromContext decision, so DCP validates but never normalizes it.
  if (message.role === "bashExecution") return typeof message.command === "string"
    && typeof message.output === "string"
    // Pi's declared type uses undefined, but its runtime converter explicitly
    // accepts null as the other "no exit status" representation.
    && (message.exitCode === undefined || message.exitCode === null || typeof message.exitCode === "number")
    && typeof message.cancelled === "boolean"
    && typeof message.truncated === "boolean"
    && (message.fullOutputPath === undefined || typeof message.fullOutputPath === "string")
    && (message.excludeFromContext === undefined || typeof message.excludeFromContext === "boolean")
    && typeof message.timestamp === "number";
  if (message.role === "custom") return typeof message.customType === "string" && (typeof message.content === "string" || Array.isArray(message.content));
  if (message.role === "compactionSummary") return typeof message.summary === "string";
  if (message.role === "branchSummary") return typeof message.summary === "string" && typeof message.fromId === "string";
  return false;
}
function toolIds(message: AgentMessage): string[] {
  if (message.role !== "assistant") return message.role === "toolResult" ? [message.toolCallId] : [];
  return message.content.filter((part): part is Extract<typeof part, { type: "toolCall" }> => part.type === "toolCall").map((part) => part.id);
}
