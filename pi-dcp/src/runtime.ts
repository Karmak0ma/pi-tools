import type { ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BaselineSnapshot, CanonicalIndex, ModelKey } from "./identity/types.ts";
import { AsyncMutex } from "./util/async-mutex.ts";
import { defaults, type EffectiveConfig } from "./config/defaults.ts";
import { emptyState, type ReducedState } from "./state/reducer.ts";
import { createLogger, type Logger } from "./observability/logger.ts";
import type { NudgeEvaluation } from "./transform/metadata.ts";

export interface BaselineRegistry {
  byAssistantParent: Map<string | null, BaselineSnapshot[]>;
  byProjectionHash: Map<string, BaselineSnapshot>;
  byHash: Map<string, BaselineSnapshot>;
  order: BaselineSnapshot[];
  pinned: Set<string>;
  maxEntries: number;
}

export function createBaselineRegistry(maxEntries = 64): BaselineRegistry {
  return { byAssistantParent: new Map(), byProjectionHash: new Map(), byHash: new Map(), order: [], pinned: new Set(), maxEntries };
}

export interface DcpRuntime {
  valid: boolean;
  sessionId: string;
  sessionFile?: string;
  branchLeafId: string | null;
  generation: number;
  config: EffectiveConfig;
  configPaths: string[];
  reduced: ReducedState;
  index?: CanonicalIndex;
  baselines: BaselineRegistry;
  /**
   * Host-observed compress calls keyed by tool-call ID. Pi 0.84.1 invokes
   * `tool_call` directly from the agent before its asynchronous message event
   * has necessarily persisted the producing assistant entry. Keeping this
   * short-lived binding lets execution use the host event as provenance
   * without weakening authorization to model-supplied aliases alone.
   */
  compressionProvenance: Map<string, BaselineSnapshot>;
  mutex: AsyncMutex;
  pendingManual?: { focus?: string; createdAt: number };
  lastTransform?: {
    changed: boolean;
    estimatedTokens: number;
    savingsTokens?: number;
    changedPrefix?: number;
    confidence: "reported" | "heuristic";
    reason?: string;
  };
  lastReadiness?: {
    ready: boolean;
    reason?: string;
    adapterId?: string;
    generation: number;
  };
  lastModel?: ModelKey;
  lastSettledSuffixHash?: string;
  turnCount: number;
  lastNudgeTurn?: number;
  lastNudgeEvaluation?: NudgeEvaluation;
  warnedReasonCodes: Set<string>;
  /**
   * The reason the last request had to be sent raw, or undefined while the
   * transform is working. A silent fallback is expensive - it sends the whole
   * uncompressed history on every later request - so it must never again be
   * observable only as a bigger bill.
   */
  fallbackReason?: string;
  /**
   * A chat notice waiting to be written to the session. It is produced inside
   * the `context` hook but can only be delivered from `agent_settled`: mid-turn
   * insertion would place a custom message between an assistant tool call and
   * its tool results and break protocol ordering.
   */
  pendingFallbackNotice?: string;
  mutationBlocked: boolean;
  logger: Logger;
  pi?: ExtensionAPI;
  pendingNudge?: { band: "soft" | "imperative" | "critical"; nudgeKey: string };
}

export function createRuntime(pi?: ExtensionAPI): DcpRuntime {
  return {
    valid: true,
    sessionId: "",
    branchLeafId: null,
    generation: 0,
    config: structuredClone(defaults) as unknown as EffectiveConfig,
    configPaths: [],
    reduced: emptyState(),
    baselines: createBaselineRegistry(),
    compressionProvenance: new Map(),
    mutex: new AsyncMutex(),
    turnCount: 0,
    lastReadiness: { ready: false, reason: "extension_disabled", generation: 0 },
    warnedReasonCodes: new Set(),
    mutationBlocked: false,
    logger: createLogger("0.2.0"),
    pi,
  };
}

export function baselineMatches(a: BaselineSnapshot, b: BaselineSnapshot): boolean {
  return a.hash === b.hash
    && a.key.branchIdentity === b.key.branchIdentity
    && a.key.leafId === b.key.leafId
    && a.key.provider === b.key.provider
    && a.key.modelId === b.key.modelId
    && a.key.api === b.key.api
    && a.key.contextWindow === b.key.contextWindow
    && a.key.generation === b.key.generation
    && a.key.configSafetyHash === b.key.configSafetyHash
    && a.key.projectionHash === b.key.projectionHash
    && a.key.dcpTransformHash === b.key.dcpTransformHash;
}

export function publishBaseline(runtime: DcpRuntime, candidate: BaselineSnapshot): BaselineSnapshot {
  const existing = runtime.baselines.byHash.get(candidate.hash);
  if (existing && baselineMatches(existing, candidate)) return existing;
  runtime.baselines.byHash.set(candidate.hash, candidate);
  runtime.baselines.byProjectionHash.set(candidate.key.projectionHash, candidate);
  const parent = candidate.leafId;
  const list = runtime.baselines.byAssistantParent.get(parent) || [];
  list.push(candidate);
  runtime.baselines.byAssistantParent.set(parent, list);
  runtime.baselines.order.push(candidate);
  while (runtime.baselines.order.length > runtime.baselines.maxEntries) {
    const evictIndex = runtime.baselines.order.findIndex((item) => !runtime.baselines.pinned.has(item.hash));
    if (evictIndex < 0) break;
    const [evicted] = runtime.baselines.order.splice(evictIndex, 1);
    if (!evicted) break;
    if (runtime.baselines.byHash.get(evicted.hash) === evicted) runtime.baselines.byHash.delete(evicted.hash);
    if (runtime.baselines.byProjectionHash.get(evicted.key.projectionHash) === evicted) runtime.baselines.byProjectionHash.delete(evicted.key.projectionHash);
    const parents = runtime.baselines.byAssistantParent.get(evicted.leafId);
    if (parents) {
      const remaining = parents.filter((item) => item !== evicted);
      if (remaining.length) runtime.baselines.byAssistantParent.set(evicted.leafId, remaining);
      else runtime.baselines.byAssistantParent.delete(evicted.leafId);
    }
  }
  return candidate;
}

export function pinBaseline(runtime: DcpRuntime, baseline: BaselineSnapshot): void { runtime.baselines.pinned.add(baseline.hash); }
export function unpinBaseline(runtime: DcpRuntime, baseline: BaselineSnapshot): void { runtime.baselines.pinned.delete(baseline.hash); }

export function latestBaseline(runtime: DcpRuntime): BaselineSnapshot | undefined { return runtime.baselines.order.at(-1); }

export function findBaselineForParent(runtime: DcpRuntime, parentId: string | null, current: { model: ModelKey; generation: number; configHash: string }): BaselineSnapshot | undefined {
  const candidates = runtime.baselines.byAssistantParent.get(parentId) || [];
  return [...candidates].reverse().find((baseline) =>
    baseline.key.generation === current.generation
    && baseline.key.configSafetyHash === current.configHash
    && baseline.model.provider === current.model.provider
    && baseline.model.id === current.model.id
    && baseline.model.api === current.model.api
    && baseline.model.contextWindow === current.model.contextWindow,
  );
}

export function clearBaselines(runtime: DcpRuntime): void {
  runtime.baselines = createBaselineRegistry(runtime.baselines.maxEntries);
  runtime.compressionProvenance.clear();
  runtime.index = undefined;
}

export function invalidateSnapshot(runtime: DcpRuntime, increment = true): void {
  clearBaselines(runtime);
  if (increment) runtime.generation++;
  runtime.lastReadiness = { ready: false, reason: "state_invalidated", generation: runtime.generation };
}

export function disableRuntime(runtime: DcpRuntime, reason: string): void {
  runtime.valid = false;
  clearBaselines(runtime);
  runtime.lastReadiness = { ready: false, reason, generation: runtime.generation };
  runtime.warnedReasonCodes.add(reason);
  runtime.logger.diagnostic({ reason: reason as any });
}

export function currentToolNames(pi: ExtensionAPI): string[] { return [...new Set(pi.getActiveTools())]; }
export function setDcpToolActive(pi: ExtensionAPI, active: boolean): void {
  const names = currentToolNames(pi).filter((name) => name !== "compress");
  if (active) names.push("compress");
  pi.setActiveTools(names);
}
export function runtimeSessionIdentity(ctx: ExtensionContext): { sessionId: string; leafId: string | null; sessionFile?: string } {
  return { sessionId: ctx.sessionManager.getSessionId(), leafId: ctx.sessionManager.getLeafId(), sessionFile: ctx.sessionManager.getSessionFile() };
}
