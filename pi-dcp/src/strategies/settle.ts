import type { CanonicalIndex } from "../identity/types.ts";
import type { ReducedState } from "../state/reducer.ts";
import type { PrunedToolDecision } from "../state/operations.ts";
import { deduplicate, collectToolRecords } from "./deduplicate.ts";
import { purgeOldErrors } from "./purge-errors.ts";
import type { ProtectionOptions } from "../compression/protected.ts";
import { questionPruning } from "../questions/registry.ts";

export interface StrategyOptions extends ProtectionOptions {
  deduplication: boolean;
  purgeErrors: boolean;
  purgeTurns: number;
  turnProtection?: { enabled: boolean; turns: number };
  automaticStrategiesAllowed?: boolean;
}
export function evaluateSettledStrategies(index: CanonicalIndex, state: ReducedState, options: StrategyOptions): PrunedToolDecision[] {
  if (options.automaticStrategiesAllowed === false) return [];
  const decisions = [
    ...(options.deduplication ? deduplicate(index, options) : []),
    ...(options.purgeErrors ? purgeOldErrors(index, { ...options, turns: options.purgeTurns }) : []),
    ...questionPruning(index, state.toolPrunes),
  ];
  const seen = new Set<string>();
  const canonicalOrder = new Map(collectToolRecords(index).map((record) => [record.toolCallId, record.unitIndex]));
  return decisions.filter((decision) => {
    const key = `${decision.toolCallId}\0${decision.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const existing = state.toolPrunes.get(decision.toolCallId);
    if (existing?.output && (decision.kind === "dedup-output" || decision.kind === "sweep-output")) return false;
    if (existing?.oldErrorInput && decision.kind === "old-error-input") return false;
    return true;
  }).sort((a, b) => (canonicalOrder.get(a.toolCallId) ?? Number.MAX_SAFE_INTEGER) - (canonicalOrder.get(b.toolCallId) ?? Number.MAX_SAFE_INTEGER) || a.kind.localeCompare(b.kind));
}
