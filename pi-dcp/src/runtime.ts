import type { ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ContextSnapshot, CanonicalIndex } from "./identity/types.ts";
import { AsyncMutex } from "./util/async-mutex.ts";
import { defaults, type EffectiveConfig } from "./config/defaults.ts";
import { emptyState, type ReducedState } from "./state/reducer.ts";
import { createLogger, type Logger } from "./observability/logger.ts";
import type { NudgeEvaluation } from "./transform/metadata.ts";

export interface DcpRuntime {
  valid: boolean; sessionId: string; sessionFile?: string; branchLeafId: string | null; generation: number;
  config: EffectiveConfig; configPaths: string[]; reduced: ReducedState; index?: CanonicalIndex; snapshot?: ContextSnapshot;
  mutex: AsyncMutex; pendingManual?: { nonce: string; focus?: string; createdAt: number }; manualAuthorization?: { nonce: string; expiresAt: number }; lastTransform?: { changed: boolean; estimatedTokens: number; savingsTokens?: number; changedPrefix?: number; confidence: "reported" | "heuristic"; reason?: string };
  lastSettledSuffixHash?: string; turnCount: number; lastNudgeTurn?: number; lastNudgeEvaluation?: NudgeEvaluation; warnedReasonCodes: Set<string>; mutationBlocked: boolean; logger: Logger; pi?: ExtensionAPI;
}
export function createRuntime(pi?: ExtensionAPI): DcpRuntime { return { valid: true, sessionId: "", branchLeafId: null, generation: 0, config: structuredClone(defaults) as unknown as EffectiveConfig, configPaths: [], reduced: emptyState(), mutex: new AsyncMutex(), turnCount: 0, warnedReasonCodes: new Set(), mutationBlocked: false, logger: createLogger("0.1.0"), pi }; }
export function invalidateSnapshot(runtime: DcpRuntime, increment = true): void { runtime.snapshot = undefined; if (increment) runtime.generation++; }
export function disableRuntime(runtime: DcpRuntime, reason: string): void { runtime.valid = false; runtime.snapshot = undefined; runtime.warnedReasonCodes.add(reason); }
export function currentToolNames(pi: ExtensionAPI): string[] { return [...new Set(pi.getActiveTools())]; }
export function setDcpToolActive(pi: ExtensionAPI, active: boolean): void { const names = currentToolNames(pi).filter((name) => name !== "compress"); if (active) names.push("compress"); pi.setActiveTools(names); }
export function runtimeSessionIdentity(ctx: ExtensionContext): { sessionId: string; leafId: string | null; sessionFile?: string } { return { sessionId: ctx.sessionManager.getSessionId(), leafId: ctx.sessionManager.getLeafId(), sessionFile: ctx.sessionManager.getSessionFile() }; }
