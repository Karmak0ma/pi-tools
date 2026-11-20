import type { BaselineSnapshot, ProtocolUnit } from "../identity/types.ts";
import { blockSpan, unitAlias } from "../identity/snapshot.ts";
import type { ReducedState } from "../state/reducer.ts";
import { activeBlocksInRange, isSingleBlockRewrite } from "./range.ts";

/**
 * Reasons a unit can never be part of a compression range. Tool-output
 * protection (compress.protectedTools / protectedFilePatterns) is
 * deliberately NOT one of these: a match there is absorbed verbatim into
 * the block summary instead (see collectProtectedToolSections in
 * protected.ts), so it never blocks a range. Blocking on tool protection
 * used to turn every `write`/`edit`/`compress` call into a permanent,
 * fragmenting barrier in the middle of history - that coupling was the bug.
 *
 * What remains here are the only reasons content truly cannot be
 * compressed away, independent of any tool it happens to contain:
 * - "not_settled": the unit's messages are not a complete, resolved
 *   protocol exchange (tool call without its results, orphan result).
 * - "protected_message": settled, but its role can never be compressed
 *   (system prompt message, user shell `!` execution, pi-dcp summary; see
 *   makeUnit in identity/protocol.ts). Kept distinct from "not_settled" so
 *   the error does not suggest the unit may become selectable later - it
 *   never will, and a model that believes otherwise tends to give up and
 *   wait instead of splitting the range.
 * - "live_user_turn": the most recent user turn is always still "in
 *   flight" from the model's perspective and must stay verbatim.
 * - "recent_turn_window": inside the configurable `turnProtection` window.
 * - "protect_user_messages_enabled": the operator has turned on
 *   `compress.protectUserMessages`, which keeps every user turn verbatim.
 */
export type UnitBlockReason = "not_settled" | "protected_message" | "live_user_turn" | "recent_turn_window" | "protect_user_messages_enabled";

export interface EligibilityConfig {
  turnProtection?: { enabled: boolean; turns: number };
  protectUserMessages?: boolean;
}

export interface EligibilityOptions {
  lastUserIndex: number;
  protectedUserStart: number;
  protectUserMessages: boolean;
}

/** Compute the shared "which units are user-turn-protected" inputs once per
 * baseline so every caller (label injection, range validation, inventory
 * reporting) agrees on the same live/recent-turn boundaries. */
export function buildEligibility(units: readonly Pick<ProtocolUnit, "role">[], config: EligibilityConfig): EligibilityOptions {
  const lastUserIndex = Math.max(-1, ...units.map((unit, index) => (unit.role === "user" ? index : -1)));
  const protectedUserStart = config.turnProtection?.enabled
    ? Math.max(0, lastUserIndex - config.turnProtection.turns + 1)
    : Number.POSITIVE_INFINITY;
  return { lastUserIndex, protectedUserStart, protectUserMessages: !!config.protectUserMessages };
}

type EligibilityUnit = Pick<ProtocolUnit, "role" | "compressible"> & { settled?: boolean };

export function unitBlockReason(unit: EligibilityUnit, unitIndex: number, eligibility: EligibilityOptions): UnitBlockReason | undefined {
  if (!unit.compressible) return unit.settled === false ? "not_settled" : "protected_message";
  if (unit.role !== "user") return undefined;
  if (eligibility.protectUserMessages) return "protect_user_messages_enabled";
  if (unitIndex === eligibility.lastUserIndex) return "live_user_turn";
  if (unitIndex >= eligibility.protectedUserStart) return "recent_turn_window";
  return undefined;
}

export function isUnitCompressible(unit: EligibilityUnit, unitIndex: number, eligibility: EligibilityOptions): boolean {
  return unitBlockReason(unit, unitIndex, eligibility) === undefined;
}

export function blockReasonText(reason: UnitBlockReason): string {
  switch (reason) {
    case "not_settled": return "is an unfinished tool exchange (a call without all its results)";
    case "protected_message": return `is a protected message (system prompt, user shell "!" command, or pi-dcp summary) and can never be compressed`;
    case "live_user_turn": return "is the current user turn, which always stays live";
    case "recent_turn_window": return "is inside the protected recent-turns window (turnProtection)";
    case "protect_user_messages_enabled": return "is a user message and protectUserMessages is enabled";
  }
}

/**
 * The compressible runs the model may name right now, written as the labels its
 * request shows: "m0001-m0040", "b0003-m0120", "b0005-b0007", or one label for a
 * single unit. This is the only source of the inventory line and of the split
 * suggestions for a rejected range, so the two cannot disagree.
 *
 * Why a visible block is one step of the walk: the model sees a block as one
 * bNNNN, and the units inside it carry no label. A run that touches a block
 * therefore starts or ends on its bNNNN, never on a hidden mNNNN.
 *
 * Why a block that holds an unselectable unit splits the run: any range that
 * includes that unit is refused, and a block cannot be taken apart. The block
 * is left out, and the runs on either side stay separate.
 *
 * Why a run that is one block alone is dropped: a range of that block alone is
 * refused as a single-block rewrite, so offering it would send the model into a
 * retry loop. isSingleBlockRewrite is the tool's own test, so the two agree.
 *
 * Which blocks exist is decided by `state`, the same way the validator decides
 * it. A block the request does not show has no alias in the snapshot. The model
 * cannot name it, and the validator refuses any range that reaches its units, so
 * it is treated as blocked rather than as loose units.
 *
 * `from` and `to` must not cut a block. The inventory passes the whole request.
 * The split path passes a range that resolveCompressionRanges already accepted,
 * and that resolution rejects any range that cuts a block.
 */
export function compressibleRangeLabels(snapshot: BaselineSnapshot, state: ReducedState, eligibility: EligibilityOptions, from = 0, to = snapshot.units.length - 1): string[] {
  const aliasByBlockId = new Map([...snapshot.blockAliases.values()].map((item) => [item.blockId, item.alias]));
  // Same activity test as activeBlocksInRange and aliasBoundary, so the walk sees
  // every block the validator sees, keyed by its first unit.
  const blockAt = new Map<number, { end: number; alias?: string }>();
  for (const [blockId, block] of state.blocks) {
    if (!block.active || !block.available) continue;
    const span = blockSpan(snapshot.units, block);
    if (span) blockAt.set(span.start, { end: span.end, alias: aliasByBlockId.get(blockId) });
  }

  const labels: string[] = [];
  let run: { start: number; end: number; startLabel: string; endLabel: string } | undefined;
  const closeRun = (): void => {
    if (!run) return;
    const consumedBlockIds = activeBlocksInRange(snapshot, state, run.start, run.end).whole;
    if (!isSingleBlockRewrite(snapshot, state, { start: run.start, end: run.end, consumedBlockIds })) {
      labels.push(run.startLabel === run.endLabel ? run.startLabel : `${run.startLabel}-${run.endLabel}`);
    }
    run = undefined;
  };

  // Walk the request one step at a time: a block is one step, every other unit
  // is one step. A block the model cannot name is never offered. A block that
  // runs past `to` cannot be taken whole either. Neither is cut into pieces.
  // Today no caller can reach the second case: resolveCompressionRanges rejects
  // any range that cuts a block before splits are computed. The check stays so
  // that a future caller cannot get a run that quietly leaves the window.
  for (let index = from; index <= to;) {
    const block = blockAt.get(index);
    const end = block?.end ?? index;
    const offerable = block === undefined || (block.alias !== undefined && end <= to);
    if (!offerable || !spanIsCompressible(snapshot.units, index, end, eligibility)) {
      closeRun();
    } else {
      run = {
        start: run?.start ?? index,
        end,
        startLabel: run?.startLabel ?? block?.alias ?? unitAlias(index),
        endLabel: block?.alias ?? unitAlias(end),
      };
    }
    index = end + 1;
  }
  closeRun();
  return labels;
}

function spanIsCompressible(units: readonly EligibilityUnit[], start: number, end: number, eligibility: EligibilityOptions): boolean {
  for (let index = start; index <= end; index++) {
    if (!isUnitCompressible(units[index], index, eligibility)) return false;
  }
  return true;
}
