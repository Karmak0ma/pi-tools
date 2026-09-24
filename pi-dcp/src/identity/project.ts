import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
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

/** Pi persists these entries for replay, UI, or accounting, but never sends them to the model. */
const NON_CONTEXT_ENTRY_TYPES: ReadonlySet<string> = new Set([
  "custom",
  "thinking_level_change",
  "model_change",
  "label",
  "session_info",
  "usage",
]);

const HOST_ENTRY_TYPES: ReadonlySet<string> = new Set([
  ...NON_CONTEXT_ENTRY_TYPES,
  "context_edit",
  "message",
  "custom_message",
  "compaction",
  "branch_summary",
]);

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
  return isProviderDroppedAssistantMessage((entry as SessionMessageEntry).message);
}

function isProviderDroppedAssistantMessage(value: unknown): boolean {
  if (!isRecord(value) || value.role !== "assistant") return false;
  return value.stopReason === "error"
    || value.stopReason === "aborted"
    // Pi normalizes legacy null assistant content to an empty array before the
    // provider drops the contentless turn. Treat both persisted forms alike.
    || value.content == null
    || (Array.isArray(value.content) && value.content.length === 0);
}

/**
 * Adapt Pi 0.87's provenance-preserving projection without trusting it as a
 * replacement for DCP's identity checks. The host applies branch-local
 * context edits before it returns these entries, so an edit contributes no
 * message of its own and the edited target keeps its original source ID.
 */
export function projectHostSessionProjection(build: () => unknown): ProjectionResult {
  try {
    const raw = build();
    // Pi's current API is synchronous. Consume a future rejected Promise
    // before failing closed so a host signature change cannot create an
    // unhandled rejection outside this synchronous lifecycle boundary.
    if (isPromiseLike(raw)) {
      void raw.then(() => undefined, () => undefined);
      return { ok: false, reason: "projection_unsupported" };
    }
    if (!isRecord(raw) || !Array.isArray(raw.entries) || !Array.isArray(raw.messages)) return { ok: false, reason: "projection_unsupported" };
    const messages: ProjectedMessage[] = [];
    const unprojectedEntryIds = new Set<string>();
    for (const projectedEntry of raw.entries) {
      if (!appendHostProjectedEntry(messages, projectedEntry, unprojectedEntryIds)) return { ok: false, reason: "projection_unsupported" };
    }
    if (!hostMessagesMatch(raw.messages, messages)) return { ok: false, reason: "projection_unsupported" };
    return { ok: true, messages, unprojectedEntryIds };
  } catch {
    return { ok: false, reason: "projection_unsupported" };
  }
}

/** Adapt the certified Pi 0.87 provenance-preserving projection. */
export function projectSessionManager(sessionManager: { buildSessionProjection: () => unknown }): ProjectionResult {
  return projectHostSessionProjection(() => sessionManager.buildSessionProjection());
}

/** Append one validated host entry; false rejects the complete projection. */
function appendHostProjectedEntry(target: ProjectedMessage[], value: unknown, unprojectedEntryIds: Set<string>): boolean {
  if (!isRecord(value) || !isValidSourceEntry(value.sourceEntry) || !Array.isArray(value.messages)) return false;
  const sourceEntry = value.sourceEntry;
  if (isProviderDroppedAssistant(sourceEntry)) {
    // The host projection may still include an errored, aborted, or empty
    // assistant entry even though the provider boundary drops it. Validate the
    // host's shape, then apply DCP's provider-facing omission rule here.
    if (!value.messages.every(isValidProjectedMessage)) return false;
    unprojectedEntryIds.add(sourceEntry.id);
    return true;
  }
  if ((NON_CONTEXT_ENTRY_TYPES.has(sourceEntry.type) || sourceEntry.type === "context_edit") && value.messages.length) return false;
  return appendProjectedMessages(target, sourceEntry.id, value.messages);
}

function hostMessagesMatch(rawMessages: readonly unknown[], projected: readonly ProjectedMessage[]): boolean {
  const providerMessages: AgentMessage[] = [];
  for (const value of rawMessages) {
    if (!isValidProjectedMessage(value)) return false;
    if (!isProviderDroppedAssistantMessage(value)) providerMessages.push(value);
  }
  // Pi builds the flat list as `entries.flatMap(entry => entry.messages)`, so
  // each flat message is normally the same object that appendProjectedMessages
  // already fingerprinted. fingerprintMessage is a pure function of the
  // message, so the same object needs no second hash; this removed one full
  // fingerprint pass per request. A host that builds the list from different
  // objects still gets the full content comparison and fails closed on any
  // difference.
  return providerMessages.length === projected.length
    && providerMessages.every((message, index) => message === projected[index]?.message
      || fingerprintMessage(message) === projected[index]?.fingerprint);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return isRecord(value) && typeof value.then === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isValidSourceEntry(entry: unknown): entry is SessionEntry {
  if (!isRecord(entry)
    || typeof entry.id !== "string"
    || !entry.id
    || typeof entry.timestamp !== "string"
    || !Number.isFinite(Date.parse(entry.timestamp))
    || typeof entry.type !== "string"
    || !HOST_ENTRY_TYPES.has(entry.type)) return false;
  switch (entry.type) {
    case "message": return isRecord(entry.message) && typeof entry.message.role === "string";
    case "custom_message": return "content" in entry && typeof entry.display === "boolean";
    case "compaction": return typeof entry.summary === "string" && typeof entry.firstKeptEntryId === "string" && typeof entry.tokensBefore === "number";
    case "branch_summary": return typeof entry.fromId === "string" && typeof entry.summary === "string";
    case "context_edit": return typeof entry.targetId === "string"
      && (entry.replacement === null || (isRecord(entry.replacement) && (typeof entry.replacement.content === "string" || Array.isArray(entry.replacement.content))));
    default: return true;
  }
}

function appendProjectedMessages(target: ProjectedMessage[], entryId: string, projected: readonly unknown[]): boolean {
  for (const [projection, value] of projected.entries()) {
    const message = value as AgentMessage;
    if (!isValidProjectedMessage(message)) return false;
    target.push({
      key: { kind: "entry", entryId, projection }, message,
      fingerprint: fingerprintMessage(message), toolCallIds: toolIds(message),
    });
  }
  return true;
}

function isValidProjectedMessage(value: unknown): value is AgentMessage {
  if (!value || typeof value !== "object" || typeof (value as { role?: unknown }).role !== "string") return false;
  const message = value as AgentMessage;
  if (message.role === "system") return isValidSystemMessage(message);
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

function isValidSystemMessage(message: Extract<AgentMessage, { role: "system" }>): boolean {
  const contentIsValid = typeof message.content === "string"
    || (Array.isArray(message.content) && message.content.every((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string"));
  const sectionsAreValid = message.sections === undefined
    || (!!message.sections && typeof message.sections === "object" && !Array.isArray(message.sections) && Object.values(message.sections).every((section) => section === null || typeof section === "string"));
  const toolsAddedAreValid = message.toolsAdded === undefined
    || (Array.isArray(message.toolsAdded) && message.toolsAdded.every((tool) => tool && typeof tool === "object" && typeof tool.name === "string" && typeof tool.description === "string" && !!tool.parameters && typeof tool.parameters === "object"));
  const toolsRemovedAreValid = message.toolsRemoved === undefined
    || (Array.isArray(message.toolsRemoved) && message.toolsRemoved.every((tool) => tool && typeof tool === "object" && typeof tool.name === "string"));
  return contentIsValid && sectionsAreValid && toolsAddedAreValid && toolsRemovedAreValid;
}

function toolIds(message: AgentMessage): string[] {
  if (message.role !== "assistant") return message.role === "toolResult" ? [message.toolCallId] : [];
  return message.content.filter((part): part is Extract<typeof part, { type: "toolCall" }> => part.type === "toolCall").map((part) => part.id);
}
