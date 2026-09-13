import type { EffectiveConfig } from "../config/defaults.ts";

export type NudgeType = "soft" | "imperative" | "critical";
export type NudgeKind = "context" | "turn" | "iteration";
// "nothing_compressible" marks a context-pressure decision dropped because the
// request it would ship with offers no compressible protocol unit at all - the
// nudge would contradict its own tags (see lifecycle.ts onSettled gate).
export type NudgeReason = "ready" | "usage_unavailable" | "already_nudged_this_turn" | "below_minimum" | "interval_not_elapsed" | "nothing_compressible" | "potential_savings_below_minimum" | "semantic_interval_not_elapsed";
export interface NudgeDecision { kind: NudgeKind; type: NudgeType; force: "soft" | "strong"; }
export interface NudgeEvaluation {
  decision?: NudgeDecision;
  reason: NudgeReason;
  tokens: number | null | undefined;
  contextWindow: number;
  min: number;
  max: number;
  critical: number;
  turnsSinceNudge: number;
  alreadyNudgedThisTurn: boolean;
  modelId?: string;
  potentialSavingsTokens?: number;
  userTurnsSinceCompression?: number;
  iterationsSinceUserTurn?: number;
  userTurnsSinceNudge?: number;
  iterationsSinceNudge?: number;
}

/**
 * Stable model-visible guidance. Exact usage belongs in diagnostics, not in
 * the prompt, because a changing measurement would rewrite the cache prefix.
 */
export function stableNudgeText(type: NudgeType, kind: NudgeKind = "context"): string {
  const definition = "Select older, resolved conversation whose work is finished or no longer needed immediately. Keep active work, unresolved questions, exact details still needed, pending tool exchanges, and protected content out of the range. Use contiguous complete protocol units and write a faithful summary.";
  if (type === "critical") return `CRITICAL: context recovery is required. Finish the current atomic operation, then use pi-dcp compress before any other work. Compress all useful safe closed ranges available in one pass. Do not begin a new work phase first. ${definition}`;
  if (type === "imperative") return `Use pi-dcp compress as your next tool call before beginning or continuing non-atomic work. Compress at least one useful older closed range. Continue without compression only if no safe closed range is visible. ${definition}`;
  if (kind === "iteration") return `This task has accumulated many assistant/tool iterations. Before continuing the next substantial work unit, use pi-dcp compress for at least one useful older closed range. Continue without compression only if no safe closed range is visible. ${definition}`;
  if (kind === "turn") return `A substantial work boundary has been reached. Before starting the next substantial work unit, use pi-dcp compress for at least one useful older closed range. Continue without compression only if no safe closed range is visible. ${definition}`;
  return `Before starting the next substantial work unit, use pi-dcp compress for at least one useful older closed range. If the current work is still active, finish only that atomic operation first. Continue without compression only if no safe closed range is visible. ${definition}`;
}

export function resolveLimit(limit: number | string, contextWindow: number): number {
  return typeof limit === "number" ? limit : Math.max(1, Math.floor(contextWindow * Number(limit.slice(0, -1)) / 100));
}
export function evaluateNudge(tokens: number | null | undefined, config: EffectiveConfig, contextWindow: number, turnsSinceNudge = Number.POSITIVE_INFINITY, alreadyNudgedThisTurn = false, modelId?: string): NudgeEvaluation {
  const maxSetting = modelId && config.compress.modelMaxLimits[modelId] !== undefined ? config.compress.modelMaxLimits[modelId] : `${config.nudge.maxContextPercent}%`;
  const minSetting = modelId && config.compress.modelMinLimits[modelId] !== undefined ? config.compress.modelMinLimits[modelId] : `${config.nudge.minContextPercent}%`;
  const max = resolveLimit(maxSetting, contextWindow);
  const min = resolveLimit(minSetting, contextWindow);
  const critical = resolveLimit(`${config.nudge.criticalContextPercent}%`, contextWindow);
  const base = { tokens, contextWindow, min, max, critical, turnsSinceNudge, alreadyNudgedThisTurn, modelId };
  if (tokens == null) return { ...base, reason: "usage_unavailable" };
  if (alreadyNudgedThisTurn) return { ...base, reason: "already_nudged_this_turn" };
  if (tokens >= critical) return { ...base, reason: "ready", decision: { kind: "context", type: "critical", force: "strong" } };
  if (tokens >= max) return { ...base, reason: "ready", decision: { kind: "context", type: "imperative", force: "strong" } };
  if (tokens < min) return { ...base, reason: "below_minimum" };
  if (turnsSinceNudge < config.nudge.turnsBetweenNudges) return { ...base, reason: "interval_not_elapsed" };
  return { ...base, reason: "ready", decision: { kind: "context", type: "soft", force: "soft" } };
}
export function shouldNudge(tokens: number | null | undefined, config: EffectiveConfig, contextWindow: number, turnsSinceNudge = Number.POSITIVE_INFINITY, alreadyNudgedThisTurn = false, modelId?: string): NudgeDecision | undefined {
  return evaluateNudge(tokens, config, contextWindow, turnsSinceNudge, alreadyNudgedThisTurn, modelId).decision;
}

/**
 * A context-pressure nudge must not ask the model to compress when the request
 * it ships with offers nothing compressible: every visible label BLOCKED or
 * user-protected makes the instruction contradict its own tags and invites a
 * guaranteed-failing compress call (2026-09-13 nudge/tag mismatch report).
 * Soft and imperative therefore require a nonzero estimated-savings inventory
 * from the settled index; the critical band is exempt by design - at >=90%
 * recovery pressure outranks eligibility bookkeeping. Semantic decisions
 * (turn/iteration) already gate on savings inside evaluateSemanticNudge.
 */
export function gateContextNudgeOnEligibility(evaluation: NudgeEvaluation, potentialSavingsTokens: number): NudgeEvaluation {
  if (evaluation.decision?.kind !== "context" || evaluation.decision.type === "critical" || potentialSavingsTokens > 0) return evaluation;
  return { ...evaluation, decision: undefined, reason: "nothing_compressible" };
}
