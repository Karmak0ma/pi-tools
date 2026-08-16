import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { deepClone } from "../util/clone.ts";
import { hashJson } from "../util/hash.ts";
import { buildProtocolUnits } from "../identity/protocol.ts";
import { projectContextEntries } from "../identity/project.ts";
import { joinProjectedMessages } from "../identity/join.ts";
import { createBaselineSnapshot, modelKey } from "../identity/snapshot.ts";
import type { BaselineSnapshot, CanonicalIndex } from "../identity/types.ts";
import { markAvailability, type ReducedState } from "../state/reducer.ts";
import type { EffectiveConfig } from "../config/defaults.ts";
import { replaceBlocks } from "./blocks.ts";
import { applyPersistedRedactions } from "./tools.ts";
import { validateProtocol } from "./protocol-check.ts";
import { estimateTokens } from "../tokens/estimate.ts";
import { adapterForModel } from "./adapters.ts";
import type { NudgeEvaluation } from "./metadata.ts";

export interface TransformOptions {
  ctx: ExtensionContext;
  sessionId: string;
  generation: number;
  state: ReducedState;
  config: EffectiveConfig;
  turnCount?: number;
  lastNudgeTurn?: number;
  branchIdentity?: string;
}
export interface TransformResult {
  messages: AgentMessage[];
  snapshot?: BaselineSnapshot;
  index?: CanonicalIndex;
  state: ReducedState;
  changed: boolean;
  estimatedTokens?: number;
  savingsTokens?: number;
  changedPrefix?: number;
  nudged?: boolean;
  nudge?: NudgeEvaluation;
  confidence: "reported" | "heuristic";
  reason?: string;
}

/**
 * Transform only canonical history. Persistent nudges are already ordinary
 * custom_message entries by this point; the context hook never inserts them.
 */
export function transformOutgoingContext(input: readonly AgentMessage[], options: TransformOptions): TransformResult {
  const fallback = deepClone([...input]);
  const state = options.state;
  if (state.corruptReason) return { messages: fallback, state, changed: false, confidence: "heuristic", reason: state.corruptReason };
  try {
    const adapter = adapterForModel({ api: options.ctx.model?.api || "unknown" });
    if (!adapter) return failure(fallback, state, "provider_adapter_unsupported");
    const entries = options.ctx.sessionManager.buildContextEntries();
    const projection = projectContextEntries(entries);
    if (!projection.ok) return failure(fallback, state, projection.reason);
    const indexResult = buildProtocolUnits(projection.messages);
    if (!("units" in indexResult)) return failure(fallback, state, indexResult.reason);
    const join = joinProjectedMessages(projection.messages, input);
    if (!join.ok || input.length !== projection.messages.length) return failure(fallback, state, join.ok ? "join_ambiguous" : join.reason);

    const availableEntryIds = new Set(projection.messages.map((item) => item.key.entryId));
    const validAnchors = new Set<string>();
    for (const block of state.blocks.values()) {
      const indexes = indexResult.units
        .map((unit, index) => block.coverage.effectiveEntryIds.some((entryId) => unit.entryIds.includes(entryId)) ? index : -1)
        .filter((index) => index >= 0);
      if (indexes.length) validAnchors.add(`${indexResult.units[Math.min(...indexes) - 1]?.entryIds.at(-1) || ""}|${indexResult.units[Math.max(...indexes) + 1]?.entryIds[0] || ""}`);
    }
    const availableState = reconcileAvailability(markAvailability(state, availableEntryIds, validAnchors), indexResult);
    const model = modelKey(options.ctx.model, options.ctx.getContextUsage()?.contextWindow || 0);
    const snapshot = createBaselineSnapshot({
      sessionId: options.sessionId,
      branchIdentity: options.branchIdentity || options.sessionId,
      leafId: options.ctx.sessionManager.getLeafId(),
      model,
      generation: options.generation,
      index: indexResult,
      state: availableState,
      // This is a safety/config identity, not provider content.
      configHash: hashJson(options.config),
    });
    const canonicalMessages = projection.messages.map((_item, expectedIndex) => input[join.incomingByExpected[expectedIndex]]);
    const transformed = applyPersistedRedactions(replaceBlocks(canonicalMessages, indexResult.units, snapshot, availableState), availableState);
    if (!validateProtocol(transformed)) return failure(fallback, state, "protocol_invalid");
    const wire = adapter.canonicalWire(transformed);
    const wireValidation = adapter.validateWire(wire);
    if (!wireValidation.ok) return failure(fallback, state, "provider_adapter_unsupported");
    const beforeEstimate = estimateTokens(input).total;
    const afterEstimate = estimateTokens(transformed).total;
    return {
      messages: transformed,
      snapshot,
      index: indexResult,
      state: availableState,
      // Local aliases are intentional DCP annotations, even with no active block.
      changed: true,
      estimatedTokens: afterEstimate,
      savingsTokens: beforeEstimate - afterEstimate,
      changedPrefix: firstChangedMessage(input, transformed),
      confidence: options.ctx.getContextUsage()?.tokens != null ? "reported" : "heuristic",
    };
  } catch (error) {
    const reason = error instanceof Error && error.message === "alias_overflow" ? "alias_overflow" : "projection_unsupported";
    return failure(fallback, state, reason);
  }
}

function reconcileAvailability(state: ReducedState, index: CanonicalIndex): ReducedState {
  const next = state;
  const latestUser = Math.max(-1, ...index.units.map((unit, position) => unit.role === "user" ? position : -1));
  for (const block of next.blocks.values()) {
    const indexes = index.units.map((unit, position) => block.coverage.effectiveEntryIds.some((id) => unit.entryIds.includes(id)) ? position : -1).filter((position) => position >= 0);
    if (indexes.some((position) => position === latestUser || !index.units[position].compressible)) {
      block.available = false;
      block.active = false;
    }
  }
  return next;
}

function failure(messages: AgentMessage[], state: ReducedState, reason: string): TransformResult {
  return { messages, state, changed: false, confidence: "heuristic", reason };
}
function firstChangedMessage(before: readonly AgentMessage[], after: readonly AgentMessage[]): number {
  const limit = Math.min(before.length, after.length);
  for (let index = 0; index < limit; index++) if (JSON.stringify(before[index]) !== JSON.stringify(after[index])) return index;
  return before.length === after.length ? -1 : limit;
}
