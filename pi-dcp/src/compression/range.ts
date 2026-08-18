import type { BaselineSnapshot, ProtocolUnit } from "../identity/types.ts";
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
  const indexes = snapshot.units.map((candidate, index) => block.coverage.effectiveEntryIds.some((id) => candidate.entryIds.includes(id)) ? index : -1).filter((index) => index >= 0);
  return indexes.length ? (end ? indexes.at(-1) : indexes[0]) : undefined;
}

function activeBlocksInRange(snapshot: BaselineSnapshot, state: ReducedState, start: number, end: number): { whole: string[]; partial: string[] } {
  const whole: string[] = [];
  const partial: string[] = [];
  for (const [id, block] of state.blocks) {
    if (!block.active || !block.available) continue;
    const indexes = snapshot.units.map((unit, index) => block.coverage.effectiveEntryIds.some((entryId) => unit.entryIds.includes(entryId)) ? index : -1).filter((index) => index >= 0);
    if (!indexes.length) continue;
    const first = Math.min(...indexes);
    const last = Math.max(...indexes);
    if (last < start || first > end) continue;
    if (first >= start && last <= end) whole.push(id);
    else partial.push(id);
  }
  return { whole, partial };
}

export function unitRange(snapshot: BaselineSnapshot, ranges: readonly ResolvedRange[]): ProtocolUnit[] { return ranges.flatMap((range) => snapshot.units.slice(range.start, range.end + 1)); }
