import type { ReducedState } from "../state/reducer.ts";

const PLACEHOLDER = /\(b(\d{4})\)/g;
export function placeholders(summary: string): string[] { return [...summary.matchAll(PLACEHOLDER)].map((match) => match[0].slice(1, -1)); }
export type ExpansionResult = { ok: true; summary: string; consumedBlockIds: string[]; depth: number } | { ok: false; reason: "placeholder_invalid" | "summary_invalid" };
export function expandNestedSummary(summary: string, selectedBlockIds: readonly string[], state: ReducedState, maxDepth = 8, maxChars = 200000, aliases: ReadonlyMap<string, string> = new Map()): ExpansionResult {
  const selected = new Set(selectedBlockIds); const used: string[] = [];
  const result = expand(summary, state, selected, used, new Set(), 0, maxDepth, aliases);
  if (!result.ok) return result;
  if (new Set(used).size !== used.length || used.some((id) => !selected.has(id))) return { ok: false, reason: "placeholder_invalid" };
  if (selected.size !== used.length) return { ok: false, reason: "placeholder_invalid" };
  if (result.summary.length > maxChars) return { ok: false, reason: "summary_invalid" };
  return { ok: true, summary: result.summary, consumedBlockIds: used, depth: result.depth };
}
function expand(summary: string, state: ReducedState, selected: Set<string>, used: string[], stack: Set<string>, depth: number, maxDepth: number, aliases: ReadonlyMap<string, string>): ExpansionResult {
  if (depth > maxDepth) return { ok: false, reason: "placeholder_invalid" };
  let maxSeen = depth;
  try {
    const replaced = summary.replace(PLACEHOLDER, (_match, digits: string) => {
      const alias = `b${digits}`;
      const blockId = aliases.get(alias) || alias;
      const block = state.blocks.get(blockId);
      if (!block || !selected.has(blockId) || !block.active || stack.has(blockId)) throw new Error("placeholder");
      if (used.includes(blockId)) throw new Error("placeholder");
      used.push(blockId); stack.add(blockId);
      const nested = expand(block.summary, state, selected, used, stack, depth + 1, maxDepth, aliases);
      stack.delete(blockId);
      if (!nested.ok) throw new Error("placeholder");
      // `nested.depth` alone under-counts: `block.summary` is always already
      // fully flattened (expandNestedSummary replaces every placeholder with
      // literal text at creation time, see below), so recursing into it can
      // never find a further `(bNNNN)` match beyond one hop - `nested.depth`
      // therefore always collapses to `depth + 1` no matter how deep `block`
      // itself already was. That silent under-count let a compress call that
      // re-nests an already-nested block (nestedDepth >= 1) build an envelope
      // whose computed depth looked one level shallower than the reducer's
      // authoritative invariant requires (state/reducer.ts:
      // `block.nestedDepth < child.nestedDepth + 1`), so the envelope passed
      // every check here, got persisted, and only then failed to reduce -
      // corrupting the session (2026-08-19 incident). `block.nestedDepth` is
      // the reducer's own already-validated depth for this exact child, and
      // is authoritative regardless of what its flattened text still
      // contains; folding it in here keeps this computation in sync with the
      // invariant it is required to satisfy.
      maxSeen = Math.max(maxSeen, nested.depth, block.nestedDepth + 1);
      return `[DCP nested summary]\n${nested.summary}`;
    });
    return { ok: true, summary: replaced, consumedBlockIds: used, depth: maxSeen };
  } catch { return { ok: false, reason: "placeholder_invalid" }; }
}
