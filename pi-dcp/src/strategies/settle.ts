import type { CanonicalIndex } from "../identity/types.ts";
import type { ReducedState } from "../state/reducer.ts";
import type { PrunedToolDecision } from "../state/operations.ts";
import { deduplicate, collectToolRecords, latestUserUnitIndex } from "./deduplicate.ts";
import type { ProtectionOptions } from "../compression/protected.ts";
import { questionPruning } from "../questions/registry.ts";

export interface StrategyOptions extends ProtectionOptions {
  deduplication: boolean;
  turnProtection?: { enabled: boolean; turns: number };
  automaticStrategiesAllowed?: boolean;
}
export function evaluateSettledStrategies(index: CanonicalIndex, state: ReducedState, options: StrategyOptions): PrunedToolDecision[] {
  if (options.automaticStrategiesAllowed === false) return [];
  // No automatic old-error-input strategy. It saved about 81 tokens per decision,
  // and each application could drop the signed thinking of later turns (README,
  // "When pruning takes effect"). Old claims from earlier versions still replay.
  const decisions = [
    ...(options.deduplication ? deduplicate(index, options) : []),
    ...questionPruning(index, state.toolPrunes),
  ];
  const seen = new Set<string>();
  const canonicalOrder = new Map(collectToolRecords(index).map((record) => [record.toolCallId, record.unitIndex]));
  // Two exclusions. The current turn is left to /dcp sweep. An automatic claim
  // there would wait for a compression that may never come, while its savings are
  // already counted (stats.ts). A claim on a tool call that an active block already
  // covers has no visible effect, and the block's source estimate already counts
  // those bytes, so the claim would count them twice.
  const currentTurn = latestUserUnitIndex(index);
  const coveredToolCallIds = new Set([...state.blocks.values()].filter((block) => block.active && block.available).flatMap((block) => block.coverage.effectiveToolCallIds));
  return decisions.filter((decision) => {
    const unitIndex = canonicalOrder.get(decision.toolCallId);
    if (unitIndex === undefined || unitIndex > currentTurn) return false;
    if (coveredToolCallIds.has(decision.toolCallId)) return false;
    const key = `${decision.toolCallId}\0${decision.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const existing = state.toolPrunes.get(decision.toolCallId);
    if (existing?.output && (decision.kind === "dedup-output" || decision.kind === "sweep-output")) return false;
    return true;
  }).sort((a, b) => (canonicalOrder.get(a.toolCallId) ?? Number.MAX_SAFE_INTEGER) - (canonicalOrder.get(b.toolCallId) ?? Number.MAX_SAFE_INTEGER) || a.kind.localeCompare(b.kind));
}
