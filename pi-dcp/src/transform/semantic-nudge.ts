import type { EffectiveConfig } from "../config/defaults.ts";
import type { CanonicalIndex } from "../identity/types.ts";
import { buildEligibility, isUnitCompressible } from "../compression/eligibility.ts";
import { applyPersistedRedactions } from "./tools.ts";
import { compressProtectedMatch } from "../compression/protected.ts";
import type { ReducedState } from "../state/reducer.ts";
import { estimateTokens } from "../tokens/estimate.ts";
import type { NudgeDecision, NudgeEvaluation } from "./metadata.ts";

/**
 * Compression summaries are authored by the model, so their final size is not
 * known when a periodic nudge is scheduled. Reserve one quarter of the
 * currently visible eligible source representation for the future summary.
 * This intentionally makes the guard conservative: a 16k-token eligible
 * range reports about 12k tokens of likely net savings, rather than treating
 * every source token as removable.
 */
export const SUMMARY_RESERVE_RATIO = 0.25;

export interface PotentialSavings {
  sourceTokens: number;
  estimatedSavingsTokens: number;
  candidateUnits: number;
  candidateSegments: number;
  protectedSourceTokens: number;
}

export interface SemanticNudgeCounters {
  userTurnsSinceCompression: number;
  iterationsSinceUserTurn: number;
  userTurnsSinceNudge: number;
  iterationsSinceNudge: number;
}

/**
 * Estimate the useful raw representation that a model could select now.
 *
 * This is deliberately an upper-bound inventory, not an automatic selection:
 * the model still decides which closed range deserves a faithful summary.
 * Permanent protocol barriers, the current/recent protected user turns, and
 * content already represented by an active block are excluded. The estimate
 * uses the same eligibility rules as compression validation and includes DCP's
 * persisted tool redactions so a nudge does not claim savings for bytes that
 * are already removed from the outgoing context. Configured protected tool
 * output is also excluded because compression preserves it verbatim inside the
 * authored summary rather than removing it.
 */
export function estimatePotentialSavings(index: CanonicalIndex, state: ReducedState, config: EffectiveConfig, cwd = "."): PotentialSavings {
  const eligibility = buildEligibility(index.units, {
    turnProtection: config.turnProtection,
    protectUserMessages: config.compress.protectUserMessages,
  });
  const coveredByActiveBlock = new Set(
    [...state.blocks.values()]
      .filter((block) => block.active && block.available)
      .flatMap((block) => block.coverage.effectiveEntryIds),
  );
  const entriesByKey = new Map(index.entries.map((entry) => [`${entry.key.entryId}:${entry.key.projection}`, entry.message]));
  let sourceTokens = 0;
  let protectedSourceTokens = 0;
  let candidateUnits = 0;
  let candidateSegments = 0;
  let inSegment = false;

  for (let unitIndex = 0; unitIndex < index.units.length; unitIndex++) {
    const unit = index.units[unitIndex];
    const covered = unit.entryIds.some((entryId) => coveredByActiveBlock.has(entryId));
    const candidate = isUnitCompressible(unit, unitIndex, eligibility) && !covered;
    if (!candidate) {
      inSegment = false;
      continue;
    }
    if (!inSegment) candidateSegments++;
    inSegment = true;
    candidateUnits++;
    const messages = unit.messageKeys
      .map((key) => entriesByKey.get(`${key.entryId}:${key.projection}`))
      .filter((message): message is NonNullable<typeof message> => message !== undefined);
    const redacted = applyPersistedRedactions(messages, state);
    sourceTokens += estimateTokens(redacted).total;
    const calls = new Map<string, { name: string; arguments: unknown }>();
    for (const message of messages) if (message.role === "assistant") for (const part of message.content) if (part.type === "toolCall") calls.set(part.id, { name: part.name, arguments: part.arguments });
    for (const message of redacted) if (message.role === "toolResult") {
      const call = calls.get(message.toolCallId);
      if (call && compressProtectedMatch(call.name, call.arguments, { cwd, protectedTools: config.compress.protectedTools, protectedFilePatterns: config.protectedFilePatterns }).protected) protectedSourceTokens += estimateTokens([message]).total;
    }
  }

  return {
    sourceTokens,
    estimatedSavingsTokens: Math.max(0, Math.floor(Math.max(0, sourceTokens - protectedSourceTokens) * (1 - SUMMARY_RESERVE_RATIO))),
    candidateUnits,
    candidateSegments,
    protectedSourceTokens,
  };
}

/**
 * Evaluate a periodic semantic reminder. Context pressure is evaluated by
 * metadata.ts and has priority over this result; this function only decides
 * whether a useful closed opportunity justifies a soft turn/iteration nudge.
 */
export function evaluateSemanticNudge(
  counters: SemanticNudgeCounters,
  potentialSavingsTokens: number,
  config: EffectiveConfig,
  alreadyNudgedThisTurn = false,
): NudgeEvaluation {
  const base = {
    tokens: undefined,
    contextWindow: 0,
    min: 0,
    max: 0,
    critical: 0,
    turnsSinceNudge: Number.POSITIVE_INFINITY,
    alreadyNudgedThisTurn,
    potentialSavingsTokens,
    userTurnsSinceCompression: counters.userTurnsSinceCompression,
    iterationsSinceUserTurn: counters.iterationsSinceUserTurn,
    userTurnsSinceNudge: counters.userTurnsSinceNudge,
    iterationsSinceNudge: counters.iterationsSinceNudge,
  };
  if (alreadyNudgedThisTurn) return { ...base, reason: "already_nudged_this_turn" };
  if (potentialSavingsTokens < config.nudge.minPotentialSavingsTokens) return { ...base, reason: "potential_savings_below_minimum" };

  let decision: NudgeDecision | undefined;
  if (counters.userTurnsSinceCompression >= config.nudge.turnNudgeFrequency
    && counters.userTurnsSinceNudge >= config.nudge.turnNudgeFrequency) {
    decision = { kind: "turn", type: "soft", force: "soft" };
  } else if (counters.iterationsSinceUserTurn >= config.nudge.iterationNudgeThreshold
    && counters.iterationsSinceNudge >= config.nudge.iterationNudgeThreshold) {
    decision = { kind: "iteration", type: "soft", force: "soft" };
  }
  return decision ? { ...base, reason: "ready", decision } : { ...base, reason: "semantic_interval_not_elapsed" };
}

