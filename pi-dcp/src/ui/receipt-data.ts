import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ProjectedMessage, ProtocolUnit } from "../identity/types.ts";
import { orderedActiveBlocks } from "../identity/snapshot.ts";
import type { ReducedState } from "../state/reducer.ts";
import { estimateTokens } from "../tokens/estimate.ts";

/**
 * Data for the "full" receipt bar: the context the next request will send,
 * in order. The bar draws it left to right, so the user can see how raw
 * history and pi-dcp summaries interleave and how much of the window the
 * fixed system part takes.
 *
 * - system: system prompt, tool and skill definitions. It cannot be
 *   compressed, so it gets its own neutral color.
 * - history: raw conversation that no block covers yet.
 * - summary: one pi-dcp block, or a native Pi compaction/branch summary. Each
 *   block is its own segment so adjacent blocks stay distinct in the bar.
 */
export type ContextSegmentKind = "system" | "history" | "summary";
export interface ContextSegment { kind: ContextSegmentKind; tokens: number; }

/**
 * Upper bound on stored segments. The layout is persisted in the tool result
 * details of every compress call, so a session with hundreds of blocks must
 * not grow each entry without limit. A bar is at most ~60 cells wide, so more
 * segments than this cannot be drawn apart anyway.
 */
const MAX_SEGMENTS = 120;
/** Upper bound on the per-compression history kept in each receipt, for the same reason. */
const MAX_HISTORY = 24;

export interface ContextLayoutInput {
  /** Protocol units of the baseline the call was validated against, in order. */
  units: readonly ProtocolUnit[];
  /** Projected messages of that baseline; units index into this list. */
  entries: readonly ProjectedMessage[];
  /** Reducer state AFTER this call was committed, so the new blocks count as summaries. */
  state: ReducedState;
  /**
   * Measured context size after this call: Pi's reported usage before the
   * call minus this call's estimated savings. The estimated layout is scaled
   * to this total so every style shows the same "used" number.
   */
  targetTokens: number;
  /**
   * Estimate of the system prompt plus tool definitions. Called only when the
   * transcript holds no system message (older Pi versions keep the system
   * prompt outside the transcript). Lazy because it serializes every tool schema.
   */
  systemFallbackTokens: () => number;
}

/**
 * Build the ordered layout, or undefined when it cannot be estimated.
 *
 * Every size is a chars/4 estimate, while the total comes from Pi's provider
 * usage. Scaling keeps the proportions from the estimate and the total from
 * the measurement: the bar is then consistent with the other styles, and a
 * uniform estimation error does not move segment boundaries.
 */
export function buildContextLayout(input: ContextLayoutInput): ContextSegment[] | undefined {
  if (!(input.targetTokens > 0)) return undefined;
  const raw: ContextSegment[] = [];
  const push = (kind: ContextSegmentKind, tokens: number) => {
    if (!(tokens > 0)) return;
    const last = raw.at(-1);
    // Merge runs of raw history or system text: their inner boundaries carry no
    // meaning. Summaries never merge, because each block is one thing the user
    // may want to merge later, and the bar should show how many there are.
    if (last && last.kind === kind && kind !== "summary") last.tokens += tokens;
    else raw.push({ kind, tokens });
  };

  const blockStarts = new Map<number, { end: number; tokens: number }>();
  for (const { block, span } of orderedActiveBlocks(input.units, input.state)) {
    if (span && !blockStarts.has(span.start)) blockStarts.set(span.start, { end: span.end, tokens: block.estimatedSummaryTokens });
  }

  let sawSystem = false;
  for (let index = 0; index < input.units.length; index++) {
    const block = blockStarts.get(index);
    if (block) {
      push("summary", block.tokens);
      index = block.end;
      continue;
    }
    const unit = input.units[index];
    const messages: AgentMessage[] = [];
    for (let projected = unit.startProjectedIndex; projected <= unit.endProjectedIndex; projected++) {
      const entry = input.entries[projected];
      if (entry) messages.push(entry.message);
    }
    const tokens = estimateTokens(messages).total;
    if (unit.role === "system") { sawSystem = true; push("system", tokens); }
    else if (unit.role === "compactionSummary" || unit.role === "branchSummary") push("summary", tokens);
    else push("history", tokens);
  }
  if (!sawSystem) {
    let fallback = 0;
    try { fallback = input.systemFallbackTokens(); } catch { fallback = 0; }
    if (fallback > 0) raw.unshift({ kind: "system", tokens: fallback });
  }

  const estimated = raw.reduce((sum, segment) => sum + segment.tokens, 0);
  if (estimated <= 0) return undefined;
  const factor = input.targetTokens / estimated;
  return capSegments(raw.map((segment) => ({ kind: segment.kind, tokens: Math.round(segment.tokens * factor) })));
}

/**
 * Keep at most MAX_SEGMENTS by merging the oldest summaries and history into
 * one leading history run (after the system part). Recent structure is what
 * the user acts on; very old detail is already invisible at bar resolution.
 */
function capSegments(segments: ContextSegment[]): ContextSegment[] {
  if (segments.length <= MAX_SEGMENTS) return segments;
  const head = segments[0]?.kind === "system" ? [segments[0]] : [];
  const rest = segments.slice(head.length);
  const keep = rest.slice(rest.length - (MAX_SEGMENTS - head.length - 1));
  const folded = rest.slice(0, rest.length - keep.length).reduce((sum, segment) => sum + segment.tokens, 0);
  return [...head, { kind: "history", tokens: folded }, ...keep];
}

/**
 * Estimated savings of each compression in this session, oldest first, the
 * newest last. Reducer runs keep insertion (apply) order. Only the last
 * MAX_HISTORY runs are kept.
 */
export function compressionHistory(state: ReducedState): number[] {
  const history = [...state.runs.values()].map((blockIds) => blockIds.reduce((sum, id) => sum + (state.blocks.get(id)?.estimatedSavingsTokens || 0), 0));
  return history.slice(-MAX_HISTORY);
}

/**
 * Fallback estimate of the system part: system prompt text plus the schemas of
 * the active tools. Pi sends tool schemas next to the system prompt, so both
 * count against the window.
 */
export function estimateSystemTokens(systemPrompt: string, tools: readonly { name: string; description?: string; parameters?: unknown }[]): number {
  const text = systemPrompt + tools.map((tool) => JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters })).join("");
  return Math.ceil(new TextEncoder().encode(text).length / 4);
}
