import type { EffectiveConfig } from "../config/defaults.ts";

export type NudgeType = "soft" | "imperative" | "critical";
export type NudgeReason = "ready" | "usage_unavailable" | "already_nudged_this_turn" | "below_minimum" | "interval_not_elapsed";
export interface NudgeDecision { kind: "context"; type: NudgeType; force: "soft" | "strong"; }
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
}

/**
 * Stable model-visible guidance. Exact usage belongs in diagnostics, not in
 * the prompt, because a changing measurement would rewrite the cache prefix.
 */
export function stableNudgeText(type: NudgeType): string {
  const definition = "Select older, resolved conversation whose work is finished or no longer needed immediately. Keep active work, unresolved questions, exact details still needed, pending tool exchanges, and protected content out of the range. Use contiguous complete protocol units and write a faithful summary.";
  if (type === "critical") return `CRITICAL: context recovery is required. Finish only the current atomic operation, then use pi-dcp compress for a safe closed range. ${definition}`;
  if (type === "imperative") return `Use pi-dcp compress now if a safe closed range is available. ${definition}`;
  return `When convenient, use pi-dcp compress for an older closed range. ${definition}`;
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
