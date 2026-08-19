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
}

/**
 * Transform only canonical history. Transient status is appended by the
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
    const entries = options.ctx.sessionManager.buildContextEntries();
    const projection = projectContextEntries(entries);
    if (!projection.ok) return failure(fallback, state, projection.reason);
    const indexResult = buildProtocolUnits(projection.messages);
    if (!("units" in indexResult)) return failure(fallback, state, indexResult.reason);
    const join = joinProjectedMessages(projection.messages, input);
    if (!join.ok) return failure(fallback, state, join.reason);

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

    const canonicalMessages = projection.messages.map((_item, expectedIndex) => input[join.incomingByExpected[expectedIndex]]);
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
    const transformed = mergeProjectedOutput(input, join.incomingByExpected, rendered.byProjectedIndex);
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
      changed: true,
      estimatedTokens: afterEstimate,
      savingsTokens: beforeEstimate - afterEstimate,
      // This is a confidence heuristic. Pass-through extras or block
      // replacements can make the first changed array slot earlier than the
      // true source message that changed; the value is diagnostic only.
      changedPrefix: firstChangedMessage(input, transformed),
      confidence: options.ctx.getContextUsage()?.tokens != null ? "reported" : "heuristic",
    };
  } catch (error) {
    const reason = error instanceof Error && error.message === "alias_overflow" ? "alias_overflow" : "projection_unsupported";
    return failure(fallback, state, reason);
  }
}

function mergeProjectedOutput(input: readonly AgentMessage[], incomingByExpected: readonly number[], byProjectedIndex: readonly AgentMessage[][]): AgentMessage[] {
  const expectedAtIncoming = new Map(incomingByExpected.map((incomingIndex, expectedIndex) => [incomingIndex, expectedIndex]));
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
