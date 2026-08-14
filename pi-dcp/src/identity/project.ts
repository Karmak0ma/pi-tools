import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { BranchSummaryEntry, CompactionEntry, CustomMessageEntry, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { fingerprintMessage } from "./fingerprint.ts";
import type { ProjectedMessage } from "./types.ts";

export type ProjectionResult = { ok: true; messages: ProjectedMessage[] } | { ok: false; reason: "projection_unsupported" };

/** Versioned Pi 0.84.1 projection adapter. Keep this local: private Pi internals are not imported. */
export function projectContextEntries(entries: readonly SessionEntry[]): ProjectionResult {
  const messages: ProjectedMessage[] = [];
  for (const entry of entries) {
    if (typeof entry.id !== "string" || !entry.id || typeof entry.timestamp !== "string" || !Number.isFinite(Date.parse(entry.timestamp))) return { ok: false, reason: "projection_unsupported" };
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
  return { ok: true, messages };
}

function isValidProjectedMessage(message: AgentMessage): boolean { if (!message || typeof message !== "object" || typeof message.role !== "string") return false; if (message.role === "user") return typeof message.content === "string" || (Array.isArray(message.content) && message.content.every((part) => part && typeof part === "object" && ((part as { type?: string }).type === "text" ? typeof (part as { text?: unknown }).text === "string" : (part as { type?: string }).type === "image" && typeof (part as { data?: unknown }).data === "string" && typeof (part as { mimeType?: unknown }).mimeType === "string"))); if (message.role === "assistant") return Array.isArray(message.content) && message.content.every((part) => part && typeof part === "object" && ((part as { type?: string }).type === "text" && typeof (part as { text?: unknown }).text === "string" || (part as { type?: string }).type === "thinking" && typeof (part as { thinking?: unknown }).thinking === "string" || (part as { type?: string }).type === "toolCall" && typeof (part as { id?: unknown }).id === "string" && typeof (part as { name?: unknown }).name === "string" && (part as { arguments?: unknown }).arguments !== undefined)); if (message.role === "toolResult") return typeof message.toolCallId === "string" && typeof message.toolName === "string" && Array.isArray(message.content); if (message.role === "custom") return typeof message.customType === "string" && (typeof message.content === "string" || Array.isArray(message.content)); if (message.role === "compactionSummary") return typeof message.summary === "string"; if (message.role === "branchSummary") return typeof message.summary === "string" && typeof message.fromId === "string"; return false; }
function toolIds(message: AgentMessage): string[] {
  if (message.role !== "assistant") return message.role === "toolResult" ? [message.toolCallId] : [];
  return message.content.filter((part): part is Extract<typeof part, { type: "toolCall" }> => part.type === "toolCall").map((part) => part.id);
}
