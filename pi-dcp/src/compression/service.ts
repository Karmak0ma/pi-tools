import type { Model } from "@earendil-works/pi-ai";
import { hashJson, randomId, sha256 } from "../util/hash.ts";
import type { BaselineSnapshot } from "../identity/types.ts";
import type { ReducedState } from "../state/reducer.ts";
import { createEnvelope, type CompressionCreated, type CreatedBlock } from "../state/operations.ts";
import { expandNestedSummary } from "./nesting.ts";
import { resolveCompressionRanges } from "./range.ts";
import { validateSummary, type SummaryValidation } from "./validate.ts";
import type { CompressionParams } from "./schema.ts";
import type { CanonicalIndex } from "../identity/types.ts";
import { appendProtectedToolContent, type ProtectionOptions } from "./protected.ts";
import { buildEligibility, unitBlockReason, type UnitBlockReason } from "./eligibility.ts";
import { unitAlias } from "../identity/snapshot.ts";
import { estimateTokens } from "../tokens/estimate.ts";

export interface CompressionBuildOptions { sessionId: string; extensionVersion: string; snapshot: BaselineSnapshot; state: ReducedState; params: CompressionParams; model: Model<any> | undefined; toolCallId?: string; maxSummaryChars?: number; maxExpandedChars?: number; maxNestedDepth?: number; index?: CanonicalIndex; protection?: ProtectionOptions; turnProtection?: { enabled: boolean; turns: number }; protectUserMessages?: boolean; }
export type CompressionBuildFailure = {
  ok: false;
  reason: string;
  rangeIndex?: number;
  id?: string;
  byTool?: string;
  byPattern?: string;
  hint?: string;
  cause?: UnitBlockReason;
};
export type CompressionBuildResult = { ok: true; envelope: ReturnType<typeof createEnvelope>; blocks: CreatedBlock[]; } | CompressionBuildFailure;
export function buildCompressionEnvelope(options: CompressionBuildOptions): CompressionBuildResult {
  const ranges = resolveCompressionRanges(options.snapshot, options.state, options.params.content.map(({ startId, endId }) => ({ startId, endId })));
  if (!ranges.ok) return ranges;
  // Tool-output protection (compress.protectedTools / protectedFilePatterns)
  // is deliberately absent from this eligibility check: a protected tool
  // call no longer blocks the range, its output is folded into the summary
  // verbatim below instead (appendProtectedToolContent). The only remaining
  // hard blockers are settledness and the user-turn protection rules.
  const eligibility = buildEligibility(options.snapshot.units, { turnProtection: options.turnProtection, protectUserMessages: options.protectUserMessages });
  for (const range of ranges.ranges) {
    const selectedUnits = options.snapshot.units.slice(range.start, range.end + 1);
    for (let offset = 0; offset < selectedUnits.length; offset++) {
      const unitIndex = range.start + offset;
      const cause = unitBlockReason(selectedUnits[offset], unitIndex, eligibility);
      if (cause) return { ok: false, reason: "content_protected", rangeIndex: range.rangeIndex, id: unitAlias(unitIndex), cause };
    }
  }
  const blocks: CreatedBlock[] = [];
  for (let index = 0; index < ranges.ranges.length; index++) {
    const range = ranges.ranges[index]; const authored = options.params.content[index].summary;
    const valid: SummaryValidation = validateSummary(authored, options.maxSummaryChars || 100000); if (!valid.ok) return { ok: false, reason: valid.reason, rangeIndex: range.rangeIndex, hint: authored.length > (options.maxSummaryChars || 100000) ? "exceeds maxChars" : "summary contains invalid content" };
    const aliases = new Map([...options.snapshot.blockAliases.entries()].map(([alias, block]) => [alias, block.blockId]));
    const expanded = expandNestedSummary(authored, range.consumedBlockIds, options.state, options.maxNestedDepth || 8, options.maxExpandedChars || 200000, aliases); if (!expanded.ok) return { ok: false, reason: expanded.reason, rangeIndex: range.rangeIndex, hint: expanded.reason === "placeholder_invalid" ? "missing or repeated (bNNNN) placeholder" : "expanded summary exceeds maxChars" };
    const units = options.snapshot.units.slice(range.start, range.end + 1);
    // Fold any protected tool output that fell inside this range into the
    // summary verbatim rather than rejecting the range for containing it.
    const finalSummary = options.index && options.protection
      ? appendProtectedToolContent(expanded.summary, units, options.index, options.protection)
      : expanded.summary;
    const directEntryIds = [...new Set(units.flatMap((unit) => unit.entryIds))];
    const directToolCallIds = [...new Set(units.flatMap((unit) => unit.toolCallIds))];
    const nested = range.consumedBlockIds.flatMap((id) => options.state.blocks.get(id)?.coverage || []).filter(Boolean);
    const effectiveEntryIds = [...new Set([...directEntryIds, ...nested.flatMap((coverage) => coverage.effectiveEntryIds)])];
    const effectiveToolCallIds = [...new Set([...directToolCallIds, ...nested.flatMap((coverage) => coverage.effectiveToolCallIds)])];
    const estimatedSummaryTokens = Math.max(1, Math.ceil(finalSummary.length / 4));
    const estimatedSourceTokens = estimateCompressionSourceTokens(options, units, range.consumedBlockIds);
    const block: CreatedBlock = { blockId: randomId(), ordinal: index, topic: options.params.topic, summary: finalSummary, authoredSummary: authored, estimatedSummaryTokens, estimatedSourceTokens, estimatedSavingsTokens: Math.max(0, estimatedSourceTokens - estimatedSummaryTokens), coverage: { directEntryIds, effectiveEntryIds, directToolCallIds, effectiveToolCallIds }, anchor: { beforeEntryId: options.snapshot.units[range.start - 1]?.entryIds.at(-1), afterEntryId: options.snapshot.units[range.end + 1]?.entryIds[0] }, consumedBlockIds: expanded.consumedBlockIds, nestedDepth: expanded.depth };
    blocks.push(block);
  }
  const operation: CompressionCreated = { type: "compression.created", runId: randomId(), mode: "range", toolCallId: options.toolCallId || `legacy-${options.snapshot.hash.slice(0, 16)}`, snapshotHash: options.snapshot.hash, model: { provider: options.model?.provider || "unknown", id: options.model?.id || "unknown", api: options.model?.api || "unknown" }, blocks };
  const requestKey = sha256(`${options.sessionId}\0${operation.toolCallId}\0${options.snapshot.hash}`);
  const envelope = createEnvelope(operation, options.sessionId, options.extensionVersion, requestKey);
  if (JSON.stringify(envelope).length > 256 * 1024) return { ok: false, reason: "summary_invalid" };
  return { ok: true, envelope, blocks };
}

/**
 * Estimate the representation that is replaced by a new range summary. When a
 * range consumes nested blocks, count each child summary once instead of
 * counting the child's original raw history again; otherwise nested
 * compression would falsely double-count savings.
 */
function estimateCompressionSourceTokens(options: CompressionBuildOptions, units: readonly { entryIds: string[]; messageKeys: readonly { entryId: string; projection: number }[] }[], consumedBlockIds: readonly string[]): number {
  if (!options.index) return 0;
  const consumedEntryIds = new Set(consumedBlockIds.flatMap((id) => options.state.blocks.get(id)?.coverage.effectiveEntryIds || []));
  const messages = options.index.entries
    .filter((item) => units.some((unit) => unit.messageKeys.some((key) => key.entryId === item.key.entryId && key.projection === item.key.projection)) && !consumedEntryIds.has(item.key.entryId))
    .map((item) => item.message);
  const directTokens = estimateTokens(messages).total;
  const childSummaryTokens = consumedBlockIds.reduce((total, id) => total + (options.state.blocks.get(id)?.estimatedSummaryTokens || 0), 0);
  return directTokens + childSummaryTokens;
}
