import type { BaselineSnapshot, ProtocolUnit } from "../identity/types.ts";
import { blockSpan } from "../identity/snapshot.ts";
import type { ReducedState } from "../state/reducer.ts";

export interface ResolvedRange {
  start: number;
  end: number;
  rangeIndex: number;
  directUnitIndexes: number[];
  consumedBlockIds: string[];
}
export type RangeFailure = {
  ok: false;
  reason: "range_invalid" | "range_overlap" | "block_partial";
  rangeIndex: number;
  id?: string;
};
export type RangeResult = { ok: true; ranges: ResolvedRange[] } | RangeFailure;

export function resolveCompressionRanges(snapshot: BaselineSnapshot, state: ReducedState, ranges: readonly { startId: string; endId: string }[]): RangeResult {
  const resolved: ResolvedRange[] = [];
  for (let rangeIndex = 0; rangeIndex < ranges.length; rangeIndex++) {
    const range = ranges[rangeIndex];
    const start = aliasBoundary(snapshot, state, range.startId, false);
    const end = aliasBoundary(snapshot, state, range.endId, true);
    if (start === undefined) return { ok: false, reason: "range_invalid", rangeIndex, id: range.startId };
    if (end === undefined) return { ok: false, reason: "range_invalid", rangeIndex, id: range.endId };
    if (start > end) return { ok: false, reason: "range_invalid", rangeIndex, id: range.startId };
    const directUnitIndexes = [...Array(end - start + 1)].map((_, offset) => start + offset);
    const selected = activeBlocksInRange(snapshot, state, start, end);
    if (selected.partial.length) return { ok: false, reason: "block_partial", rangeIndex, id: selected.partial[0] };
    resolved.push({ start, end, rangeIndex, directUnitIndexes, consumedBlockIds: selected.whole });
  }
  const ordered = [...resolved].sort((a, b) => a.start - b.start);
  for (let index = 1; index < ordered.length; index++) {
    if (ordered[index].start <= ordered[index - 1].end) return { ok: false, reason: "range_overlap", rangeIndex: ordered[index].rangeIndex };
  }
  return { ok: true, ranges: resolved };
}

function aliasBoundary(snapshot: BaselineSnapshot, state: ReducedState, alias: string, end: boolean): number | undefined {
  const unit = snapshot.unitAliases.get(alias);
  if (unit !== undefined) return unit;
  const blockAlias = snapshot.blockAliases.get(alias);
  if (!blockAlias) return undefined;
  const block = state.blocks.get(blockAlias.blockId);
  if (!block || !block.active || !block.available) return undefined;
  const span = blockSpan(snapshot.units, block);
  return span ? (end ? span.end : span.start) : undefined;
}

/**
 * Active blocks whose units lie inside [start, end]. A block that is only partly
 * inside is reported as partial, and the caller rejects it.
 *
 * Only active blocks are returned, and an active block is always top-level: a
 * block that a later merge consumed is inactive. So a merged block never adds
 * a second, nested entry to `whole`.
 */
export function activeBlocksInRange(snapshot: BaselineSnapshot, state: ReducedState, start: number, end: number): { whole: string[]; partial: string[] } {
  const whole: string[] = [];
  const partial: string[] = [];
  for (const [id, block] of state.blocks) {
    if (!block.active || !block.available) continue;
    const span = blockSpan(snapshot.units, block);
    if (!span) continue;
    if (span.end < start || span.start > end) continue;
    if (span.start >= start && span.end <= end) whole.push(id);
    else partial.push(id);
  }
  return { whole, partial };
}

/**
 * Indexes in [start, end] whose entries are not all covered by the consumed
 * blocks. A unit with ANY entry outside the blocks is raw, even when it only
 * partly overlaps a block. Such a unit is real content that a rewrite would add.
 */
export function rawUnitIndexes(snapshot: BaselineSnapshot, state: ReducedState, range: Pick<ResolvedRange, "start" | "end" | "consumedBlockIds">): number[] {
  const covered = new Set(range.consumedBlockIds.flatMap((id) => state.blocks.get(id)?.coverage.effectiveEntryIds ?? []));
  const raw: number[] = [];
  for (let index = range.start; index <= range.end; index++) {
    const entryIds = snapshot.units[index].entryIds;
    // An empty unit has no entry that a block could cover, so it counts as raw.
    const inside = entryIds.length > 0 && entryIds.every((id) => covered.has(id));
    if (!inside) raw.push(index);
  }
  return raw;
}

/**
 * A range that consumes exactly one block and no raw unit only rewrites that
 * block, and it adds nothing. A rewrite like this is refused. The same test
 * decides which split segments are offered on a retry, so the two rules cannot drift.
 */
export function isSingleBlockRewrite(snapshot: BaselineSnapshot, state: ReducedState, range: Pick<ResolvedRange, "start" | "end" | "consumedBlockIds">): boolean {
  return range.consumedBlockIds.length === 1 && rawUnitIndexes(snapshot, state, range).length === 0;
}

export function unitRange(snapshot: BaselineSnapshot, ranges: readonly ResolvedRange[]): ProtocolUnit[] { return ranges.flatMap((range) => snapshot.units.slice(range.start, range.end + 1)); }
