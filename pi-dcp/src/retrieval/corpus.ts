import type { AssistantMessage, ImageContent, TextContent, ToolCall } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ReducedBlock, ReducedState } from "../state/reducer.ts";

/**
 * Read-only, searchable copy of the history that DCP compressed on the
 * current branch.
 *
 * This module is the authorization boundary of `search_compressed`: `read`
 * accepts a ref only when it is in this corpus, and `block` filters use the
 * same scope data. The corpus is derived from `getBranch()` (the ancestors of
 * the current leaf, so sibling branches never enter) and from the reduced
 * state, which lifecycle.ts rebuilds from that same branch. It is rebuilt on
 * each tool call, so it can never be stale relative to either input.
 */

/**
 * Tool whose results are not indexed. A result is a copy of covered content
 * taken at an earlier time. Indexing it would have two bad effects. Every hit
 * would appear twice. Worse, if a later host context_edit redacted an entry,
 * the old copy would still return the redacted text, because the edit targets
 * the entry and not the copy.
 */
export const SEARCH_TOOL_NAME = "search_compressed";

export type SourceKind = "entry" | "summary";

export interface CorpusSource {
  /** Stable reference that `read` accepts: `e:<entryId>` or `s:<blockId>`. */
  ref: string;
  kind: SourceKind;
  /** Topic of the owning block; for an entry, the outermost block covering it. */
  topic: string;
  /** Role or tool, for example `user`, `assistant`, `tool result (bash)`, or `stored summary`. */
  label: string;
  timestamp?: string;
  text: string;
  /**
   * Blocks whose scope contains this source, and so which a `block` filter can
   * select. For an entry these are the blocks whose effective coverage includes
   * it. For a summary they are the blocks that merged it, directly or through a
   * chain, so a filter on a merged-away summary's parent includes its summary.
   */
  scopeBlockIds: string[];
}

/**
 * Covered content that exists but is not returned. Summaries and entries share
 * one map keyed by ref, so `read` and the reason it gives use the same lookup.
 */
export interface UnavailableItem {
  ref: string;
  /**
   * `withheld`: a host context_edit changed an original entry that this content
   * covers. Returning it would bypass that redaction. This applies to an entry
   * and to any summary whose block covers the entry. `missing`: the block covers
   * an entry that is not on this branch, so it is reported, never replaced.
   */
  reason: "withheld" | "missing";
  scopeBlockIds: string[];
}

export interface Corpus {
  /** Entries in branch order, then hidden summaries in block creation order. */
  sources: CorpusSource[];
  byRef: Map<string, CorpusSource>;
  unavailable: Map<string, UnavailableItem>;
}

/**
 * Build the corpus from the current branch and reduced DCP state.
 *
 * Native Pi compaction keeps the old entries as ancestors of the new leaf, so
 * an entry does not need its block to be `available` to be searchable. It only
 * has to be on the branch.
 */
export function buildSearchCorpus(branchEntries: readonly SessionEntry[], state: ReducedState): Corpus {
  // A context_edit is branch-relative and the latest one wins. Any edit that
  // targets an entry on this branch makes that entry's original text unsafe to
  // return, so every edit counts, not only the most recent.
  const editedTargets = new Set<string>();
  for (const entry of branchEntries) {
    if (entry.type === "context_edit") editedTargets.add(entry.targetId);
  }

  // Union over every block. Merged-away, user-decompressed, and unavailable
  // blocks still cover raw entries that the model may need to revisit.
  const coveringByEntry = new Map<string, ReducedBlock[]>();
  for (const block of state.blocks.values()) {
    for (const entryId of block.coverage.effectiveEntryIds) {
      const covering = coveringByEntry.get(entryId);
      if (covering) covering.push(block);
      else coveringByEntry.set(entryId, [block]);
    }
  }

  const sources: CorpusSource[] = [];
  const unavailable = new Map<string, UnavailableItem>();
  const onBranch = new Set<string>();
  for (const entry of branchEntries) {
    const covering = coveringByEntry.get(entry.id);
    if (!covering) continue;
    onBranch.add(entry.id);
    // Extract before the edit check so that an entry with no searchable text,
    // such as a thinking-only turn, is not reported as withheld content.
    const content = extractEntryText(entry);
    if (!content) continue;
    const scopeBlockIds = covering.map((block) => block.blockId);
    if (editedTargets.has(entry.id)) {
      unavailable.set(`e:${entry.id}`, { ref: `e:${entry.id}`, reason: "withheld", scopeBlockIds });
      continue;
    }
    sources.push({
      ref: `e:${entry.id}`,
      kind: "entry",
      topic: cleanTopic(outermost(covering).topic),
      label: content.label,
      timestamp: entry.timestamp,
      text: content.text,
      scopeBlockIds,
    });
  }
  for (const [entryId, covering] of coveringByEntry) {
    if (onBranch.has(entryId)) continue;
    unavailable.set(`e:${entryId}`, { ref: `e:${entryId}`, reason: "missing", scopeBlockIds: covering.map((block) => block.blockId) });
  }

  const mergers = mergerIndex(state);
  for (const block of state.blocks.values()) {
    // A visible summary is already in the model context. Repeating it in
    // search results would only add noise, so only hidden summaries are indexed.
    if (block.active && block.available) continue;
    const ref = `s:${block.blockId}`;
    const scopeBlockIds = mergersOf(block.blockId, mergers);
    // A summary is written from the entries it covers. If a host edit redacted
    // one of them, the summary may still restate the redacted text, so the
    // summary is withheld too. Withholding it is conservative, but it keeps
    // the edit from being bypassed through the stored summary.
    if (block.coverage.effectiveEntryIds.some((entryId) => editedTargets.has(entryId))) {
      unavailable.set(ref, { ref, reason: "withheld", scopeBlockIds });
      continue;
    }
    sources.push({
      ref,
      kind: "summary",
      topic: cleanTopic(block.topic),
      label: "stored summary",
      text: storedSummaryText(block),
      scopeBlockIds,
    });
  }

  return {
    sources,
    byRef: new Map(sources.map((source) => [source.ref, source])),
    unavailable,
  };
}

interface EntryText { label: string; text: string }

/**
 * The original content a model could have read: user text, assistant text,
 * tool calls, tool results, and custom messages.
 *
 * Thinking is excluded: it is private reasoning, not history the user saw.
 * Images are never returned. A placeholder records that an image existed, so
 * a search can still say what was in the message. System messages and Pi
 * bookkeeping are excluded because they are not conversation content.
 */
function extractEntryText(entry: SessionEntry): EntryText | undefined {
  if (entry.type === "custom_message") {
    // pi-dcp's own messages (for example its fallback notices) are not
    // conversation history. Everything else is an extension message the model
    // saw, so it is ordinary history.
    if (entry.customType.startsWith("pi-dcp.")) return undefined;
    return nonEmpty(`custom (${entry.customType})`, renderContent(entry.content));
  }
  if (entry.type !== "message") return undefined;
  const message = entry.message;
  switch (message.role) {
    case "user": return nonEmpty("user", renderContent(message.content));
    case "assistant": return nonEmpty("assistant", renderAssistant(message.content));
    case "toolResult":
      if (message.toolName === SEARCH_TOOL_NAME) return undefined;
      return nonEmpty(`tool result (${message.toolName})`, renderContent(message.content));
    default:
      // System prompts, bash executions, compaction and branch summaries.
      return undefined;
  }
}

function renderContent(content: string | readonly (TextContent | ImageContent)[]): string {
  if (typeof content === "string") return content;
  return content.map((part) => part.type === "text" ? part.text : "[image omitted]").join("\n");
}

function renderAssistant(content: AssistantMessage["content"]): string {
  return content.flatMap((part) => {
    if (part.type === "text") return [part.text];
    if (part.type === "toolCall") return [renderToolCall(part)];
    return [];
  }).join("\n");
}

/**
 * A compress call stores its summaries in the block it creates, and those
 * summaries are indexed there. Its arguments would repeat them. The repeat
 * would re-expose summaries that are hidden or visible, and would skip the
 * withholding rule above. Only the topic is kept, so the call is still findable.
 */
function renderToolCall(part: ToolCall): string {
  if (part.name === "compress") {
    const topic = typeof part.arguments.topic === "string" ? part.arguments.topic : "";
    return `[tool call] compress ${JSON.stringify({ topic })}`;
  }
  return `[tool call] ${part.name} ${JSON.stringify(part.arguments)}`;
}

function nonEmpty(label: string, text: string): EntryText | undefined {
  return text.trim() ? { label, text } : undefined;
}

/**
 * The owning block is the one with the greatest nesting depth. That is the
 * most recent merge, and its topic describes the whole lineage.
 */
function outermost(blocks: readonly ReducedBlock[]): ReducedBlock {
  return blocks.reduce((best, block) => block.nestedDepth > best.nestedDepth ? block : best);
}

/**
 * A stored summary is searched together with its recall cues. A cue names a detail
 * that the summary left out, so a search for that name should also find the
 * summary that recorded it. Blocks without cues are unchanged.
 */
function storedSummaryText(block: ReducedBlock): string {
  return block.recall?.length ? `${block.summary}\n\n${block.recall.join("\n")}` : block.summary;
}

/** Map each block to the blocks that consumed it, so scope can follow merges upward. */
function mergerIndex(state: ReducedState): Map<string, string[]> {
  const mergers = new Map<string, string[]>();
  for (const block of state.blocks.values()) {
    for (const childId of block.consumedBlockIds) {
      const list = mergers.get(childId);
      if (list) list.push(block.blockId);
      else mergers.set(childId, [block.blockId]);
    }
  }
  return mergers;
}

/** Every block that merged this one, directly or through a chain of merges. */
function mergersOf(blockId: string, mergers: ReadonlyMap<string, string[]>): string[] {
  const found = new Set<string>();
  const queue = [...(mergers.get(blockId) ?? [])];
  while (queue.length) {
    const next = queue.shift()!;
    if (found.has(next)) continue;
    found.add(next);
    queue.push(...(mergers.get(next) ?? []));
  }
  return [...found];
}

/** Model-authored topics may contain newlines; a topic is one display line. */
function cleanTopic(topic: string): string {
  return topic.replace(/\s+/g, " ").trim();
}
