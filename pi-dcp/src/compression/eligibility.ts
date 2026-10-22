import type { ProtocolUnit } from "../identity/types.ts";
import { unitAlias } from "../identity/snapshot.ts";

/**
 * Reasons a unit can never be part of a compression range. Tool-output
 * protection (compress.protectedTools / protectedFilePatterns) is
 * deliberately NOT one of these: a match there is absorbed verbatim into
 * the block summary instead (see appendProtectedToolContent in
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
 * Contiguous compressible mNNNN segments, e.g. ["m0001-m0013", "m0015-m0027"].
 * Replaces the old "first alias - last alias" inventory line, which was
 * misleading whenever any unit inside that span was blocked: the model would
 * be told a span was "valid" when it actually straddled a hard boundary.
 */
export function compressibleSegments(units: readonly EligibilityUnit[], eligibility: EligibilityOptions, from = 0, to = units.length - 1): string[] {
  // `from`/`to` let the error path compute the valid sub-ranges of one
  // requested range ("split it like this") with the same rules as the
  // global inventory, so the two can never disagree.
  const segments: string[] = [];
  let start: number | null = null;
  for (let index = from; index <= to; index++) {
    const ok = isUnitCompressible(units[index], index, eligibility);
    if (ok && start === null) start = index;
    if (!ok && start !== null) {
      segments.push(formatSegment(start, index - 1));
      start = null;
    }
  }
  if (start !== null) segments.push(formatSegment(start, to));
  return segments;
}

function formatSegment(start: number, end: number): string {
  return start === end ? unitAlias(start) : `${unitAlias(start)}-${unitAlias(end)}`;
}
