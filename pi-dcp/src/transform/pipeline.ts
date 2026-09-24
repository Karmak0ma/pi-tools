import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { deepClone } from "../util/clone.ts";
import { hashJson } from "../util/hash.ts";
import { buildProtocolUnits } from "../identity/protocol.ts";
import { projectSessionManager, type ProjectionResult } from "../identity/project.ts";
import { describeJoinMismatch, joinProjectedMessages, type JoinMismatch } from "../identity/join.ts";
import { createBaselineSnapshot, modelKey } from "../identity/snapshot.ts";
import type { BaselineSnapshot, CanonicalIndex, ProjectedMessage } from "../identity/types.ts";
import { markAvailability, type ReducedState } from "../state/reducer.ts";
import type { EffectiveConfig } from "../config/defaults.ts";
import { injectInlineLabels } from "./labels.ts";
import { replaceBlocksWithOrigins } from "./blocks.ts";
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
  /**
   * Join diagnostics for `/dcp debug`. Present whenever the transform reached
   * the join: on success it counts pass-through extras; on a failed join it
   * also counts session messages missing from the incoming context.
   */
  join?: JoinMismatch;
}

/**
 * Transform only canonical history. A transient nudge is appended by the
 * lifecycle after this function so it never affects joining or baselines.
 */
export function transformOutgoingContext(input: readonly AgentMessage[], options: TransformOptions): TransformResult {
  const fallback = deepClone([...input]);
  const state = options.state;
  if (state.corruptReason) return failure(fallback, state, state.corruptReason);
  try {
    // The generic adapter is intentionally never undefined. Protocol and wire
    // validation below remain the fail-closed safety net for malformed output.
    const adapter = adapterForModel({ api: options.ctx.model?.api || "unknown" });
    const joined = resolveProjectionAndJoin(input, options.ctx);
    if (!joined.ok) return { ...failure(fallback, state, joined.reason), join: joined.mismatch };
    const { projection, incomingByFullIndex, canonicalMessages } = joined;
    const matched = incomingByFullIndex.filter((incomingIndex) => incomingIndex >= 0).length;
    const join: JoinMismatch = { missingExpected: 0, unexpectedIncoming: input.length - matched };
    const indexResult = buildProtocolUnits(projection.messages);
    if (!("units" in indexResult)) return failure(fallback, state, indexResult.reason);

    const availableEntryIds = new Set(projection.messages.map((item) => item.key.entryId));
    const validAnchors = new Map<string, { beforeEntryId?: string; afterEntryId?: string }>();
    for (const block of state.blocks.values()) {
      const indexes = indexResult.units
        .map((unit, index) => block.coverage.effectiveEntryIds.some((entryId) => unit.entryIds.includes(entryId)) ? index : -1)
        .filter((index) => index >= 0);
      if (indexes.length) validAnchors.set(block.blockId, {
        beforeEntryId: indexResult.units[Math.min(...indexes) - 1]?.entryIds.at(-1),
        afterEntryId: indexResult.units[Math.max(...indexes) + 1]?.entryIds[0],
      });
    }
    const availableState = reconcileAvailability(markAvailability(state, availableEntryIds, validAnchors, projection.unprojectedEntryIds), indexResult);
    const model = modelKey(options.ctx.model, options.ctx.getContextUsage()?.contextWindow || 0);
    const snapshot = createBaselineSnapshot({
      sessionId: options.sessionId,
      branchIdentity: options.branchIdentity || options.sessionId,
      leafId: options.ctx.sessionManager.getLeafId(),
      model,
      generation: options.generation,
      index: indexResult,
      state: availableState,
      configHash: hashJson(options.config),
    });

    // Redact and label source messages before block replacement. A replacement
    // then receives its own bNNNN tag, while injected extras are merged later
    // without ever being inspected or mutated by DCP. Labels only reflect
    // settledness now - tool-output protection no longer blocks a unit (it
    // is absorbed into the compressed summary instead, see
    // appendProtectedToolContent in compression/protected.ts), and the
    // turn-relative eligibility rules (live turn, turnProtection window,
    // protectUserMessages) stay out of inline labels on purpose - see the
    // comment in labels.ts on why baking them in would break prompt-cache
    // prefix stability.
    const labeled = injectInlineLabels(applyPersistedRedactions(canonicalMessages, availableState), indexResult.units, snapshot);
    const rendered = replaceBlocksWithOrigins(labeled, indexResult.units, snapshot, availableState);
    const transformed = mergeProjectedOutput(input, incomingByFullIndex, rendered.byProjectedIndex);
    if (!validateProtocol(transformed)) return { ...failure(fallback, state, "protocol_invalid"), join };
    const wire = adapter.canonicalWire(transformed);
    const wireValidation = adapter.validateWire(wire);
    if (!wireValidation.ok) return { ...failure(fallback, state, "provider_adapter_unsupported"), join };
    const beforeEstimate = estimateTokens(input).total;
    const afterEstimate = estimateTokens(transformed).total;
    return {
      messages: transformed,
      snapshot,
      index: indexResult,
      state: availableState,
      changed: true,
      estimatedTokens: afterEstimate,
      savingsTokens: beforeEstimate - afterEstimate,
      // This is a confidence heuristic. Pass-through extras or block
      // replacements can make the first changed array slot earlier than the
      // true source message that changed; the value is diagnostic only.
      changedPrefix: firstChangedMessage(input, transformed),
      confidence: options.ctx.getContextUsage()?.tokens != null ? "reported" : "heuristic",
      join,
    };
  } catch (error) {
    const reason = error instanceof Error && error.message === "alias_overflow" ? "alias_overflow" : "projection_unsupported";
    return failure(fallback, state, reason);
  }
}

type CompleteProjection = Extract<ProjectionResult, { ok: true }>;

type JoinedProjection =
  | { ok: true; projection: CompleteProjection; incomingByFullIndex: number[]; canonicalMessages: AgentMessage[] }
  | { ok: false; reason: string; mismatch?: JoinMismatch };

function resolveProjectionAndJoin(input: readonly AgentMessage[], ctx: ExtensionContext): JoinedProjection {
  const projection = projectSessionManager(ctx.sessionManager);
  if (!projection.ok) return projection;
  const visible = buildProviderVisibleProjection(projection.messages);
  const join = joinProjectedMessages(visible.messages, input);
  // Mismatch counting re-fingerprints the input, so it runs only on the rare
  // failure path where the user needs an explanation.
  if (!join.ok) return { ...join, mismatch: describeJoinMismatch(visible.messages, input) };
  const incomingByFullIndex = mapVisibleJoinToFull(projection.messages.length, visible.fullIndexes, join.incomingByExpected);
  const canonicalMessages = projection.messages.map((item, fullIndex) => {
    const incomingIndex = incomingByFullIndex[fullIndex];
    // Pi 0.87 hides system messages from `context`. Use the canonical host
    // message only for those barriers; the output merge never invents them.
    // Older hosts that include systems preserve their incoming copy as extra.
    return incomingIndex >= 0 ? input[incomingIndex] : item.message;
  });
  return { ok: true, projection, incomingByFullIndex, canonicalMessages };
}

function buildProviderVisibleProjection(messages: readonly ProjectedMessage[]): { messages: ProjectedMessage[]; fullIndexes: number[] } {
  const visible: { messages: ProjectedMessage[]; fullIndexes: number[] } = { messages: [], fullIndexes: [] };
  messages.forEach((item, fullIndex) => {
    if (item.message.role === "system") return;
    visible.messages.push(item);
    visible.fullIndexes.push(fullIndex);
  });
  return visible;
}

/** Expand a join over provider-visible messages back to the full canonical index. */
function mapVisibleJoinToFull(fullLength: number, fullIndexes: readonly number[], incomingByVisible: readonly number[]): number[] {
  const incomingByFull = Array.from({ length: fullLength }, () => -1);
  fullIndexes.forEach((fullIndex, visibleIndex) => { incomingByFull[fullIndex] = incomingByVisible[visibleIndex] ?? -1; });
  return incomingByFull;
}

function mergeProjectedOutput(input: readonly AgentMessage[], incomingByExpected: readonly number[], byProjectedIndex: readonly AgentMessage[][]): AgentMessage[] {
  const expectedAtIncoming = new Map<number, number>();
  incomingByExpected.forEach((incomingIndex, expectedIndex) => { if (incomingIndex >= 0) expectedAtIncoming.set(incomingIndex, expectedIndex); });
  const output: AgentMessage[] = [];
  for (let incomingIndex = 0; incomingIndex < input.length; incomingIndex++) {
    const expectedIndex = expectedAtIncoming.get(incomingIndex);
    if (expectedIndex === undefined) {
      // Extras belong to other extensions. Preserve them byte-for-byte and do
      // not attach aliases, redact fields, or replace their content.
      output.push(deepClone(input[incomingIndex]));
      continue;
    }
    output.push(...(byProjectedIndex[expectedIndex] || []).map((message) => deepClone(message)));
  }
  return output;
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
