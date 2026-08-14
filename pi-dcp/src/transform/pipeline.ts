import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { deepClone } from "../util/clone.ts";
import { hashJson } from "../util/hash.ts";
import { buildProtocolUnits } from "../identity/protocol.ts";
import { projectContextEntries } from "../identity/project.ts";
import { joinProjectedMessages } from "../identity/join.ts";
import { createSnapshot, modelKey } from "../identity/snapshot.ts";
import type { ContextSnapshot, CanonicalIndex } from "../identity/types.ts";
import { markAvailability, type ReducedState } from "../state/reducer.ts";
import type { EffectiveConfig } from "../config/defaults.ts";
import { replaceBlocks } from "./blocks.ts";
import { applyPersistedRedactions } from "./tools.ts";
import { evaluateNudge, insertMetadata, nudgeMessage } from "./metadata.ts";
import type { NudgeEvaluation } from "./metadata.ts";
import { validateProtocol } from "./protocol-check.ts";
import { estimateTokens } from "../tokens/estimate.ts";

export interface TransformOptions { ctx: ExtensionContext; sessionId: string; generation: number; state: ReducedState; config: EffectiveConfig; currentSnapshot?: ContextSnapshot; turnCount?: number; lastNudgeTurn?: number; }
export interface TransformResult { messages: AgentMessage[]; snapshot?: ContextSnapshot; index?: CanonicalIndex; state: ReducedState; changed: boolean; estimatedTokens?: number; savingsTokens?: number; changedPrefix?: number; nudged?: boolean; nudge?: NudgeEvaluation; confidence: "reported" | "heuristic"; reason?: string; }
export function transformOutgoingContext(input: readonly AgentMessage[], options: TransformOptions): TransformResult {
  const fallback = deepClone([...input]); const state = options.state;
  if (state.corruptReason) return { messages: fallback, state, changed: false, confidence: "heuristic", reason: state.corruptReason };
  try {
    const entries = options.ctx.sessionManager.buildContextEntries();
    const projection = projectContextEntries(entries);
    if (!projection.ok) return { messages: fallback, state, changed: false, confidence: "heuristic", reason: projection.reason };
    const indexResult = buildProtocolUnits(projection.messages);
    if (!("units" in indexResult)) return { messages: fallback, state, changed: false, confidence: "heuristic", reason: indexResult.reason };
    const join = joinProjectedMessages(projection.messages, input);
    if (!join.ok || input.length !== projection.messages.length) return { messages: fallback, state, changed: false, confidence: "heuristic", reason: join.ok ? "join_ambiguous" : join.reason };
    const availableEntryIds = new Set(projection.messages.map((item) => item.key.entryId));
    const validAnchors = new Set<string>();
    for (const block of state.blocks.values()) { const indexes = indexResult.units.map((unit, index) => block.coverage.effectiveEntryIds.some((entryId) => unit.entryIds.includes(entryId)) ? index : -1).filter((index) => index >= 0); if (indexes.length) validAnchors.add(`${indexResult.units[Math.min(...indexes) - 1]?.entryIds.at(-1) || ""}|${indexResult.units[Math.max(...indexes) + 1]?.entryIds[0] || ""}`); }
    const availableState = markAvailability(state, availableEntryIds, validAnchors);
    const latestUser = Math.max(-1, ...indexResult.units.map((unit, index) => unit.role === "user" ? index : -1));
    for (const block of availableState.blocks.values()) { const indexes = indexResult.units.map((unit, index) => block.coverage.effectiveEntryIds.some((entryId) => unit.entryIds.includes(entryId)) ? index : -1).filter((index) => index >= 0); if (indexes.some((index) => index === latestUser || !indexResult.units[index].compressible)) { block.available = false; block.active = false; } }
    const snapshot = createSnapshot({ sessionId: options.sessionId, leafId: options.ctx.sessionManager.getLeafId(), model: modelKey(options.ctx.model, options.ctx.getContextUsage()?.contextWindow || 0), generation: options.generation, ttlMs: options.config.snapshot.ttlMs, index: indexResult, state: availableState, configHash: hashJson(options.config) });
    const canonicalMessages = projection.messages.map((_item, expectedIndex) => input[join.incomingByExpected[expectedIndex]]);
    const transformed = applyPersistedRedactions(replaceBlocks(canonicalMessages, indexResult.units, snapshot, availableState), availableState);
    const usage = options.ctx.getContextUsage();
    const turnCount = options.turnCount ?? 0; const lastNudgeTurn = options.lastNudgeTurn; const nudgeEvaluation = evaluateNudge(usage?.tokens, options.config, usage?.contextWindow || snapshot.model.contextWindow, lastNudgeTurn === undefined ? Number.POSITIVE_INFINITY : turnCount - lastNudgeTurn, lastNudgeTurn === turnCount, snapshot.model.id); const nudge = nudgeEvaluation.decision;
    const withMetadata = insertMetadata(transformed, snapshot, nudge ? nudgeMessage(nudge.kind, usage?.tokens || 0, nudge.type) : undefined);
    const beforeEstimate = estimateTokens(input).total; const afterEstimate = estimateTokens(withMetadata).total; const changedPrefix = firstChangedMessage(input, withMetadata);
    if (!validateProtocol(withMetadata)) return { messages: fallback, state, changed: false, confidence: "heuristic", reason: "protocol_invalid" };
    return { messages: withMetadata, snapshot, index: indexResult, state: availableState, changed: true, estimatedTokens: afterEstimate, savingsTokens: beforeEstimate - afterEstimate, changedPrefix, nudged: nudge !== undefined, nudge: nudgeEvaluation, confidence: options.ctx.getContextUsage()?.tokens != null ? "reported" : "heuristic" };
  } catch { return { messages: fallback, state, changed: false, confidence: "heuristic", reason: "projection_unsupported" }; }
}
function firstChangedMessage(before: readonly AgentMessage[], after: readonly AgentMessage[]): number { const limit = Math.min(before.length, after.length); for (let index = 0; index < limit; index++) if (JSON.stringify(before[index]) !== JSON.stringify(after[index])) return index; return before.length === after.length ? -1 : limit; }
