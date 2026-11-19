import type { Model } from "@earendil-works/pi-ai";
import { hashJson, randomId, sha256 } from "../util/hash.ts";
import type { BaselineSnapshot } from "../identity/types.ts";
import type { ReducedState } from "../state/reducer.ts";
import { createEnvelope, MAX_NESTED_DEPTH, type CompressionCreated, type CreatedBlock } from "../state/operations.ts";
import { resolveCompressionRanges } from "./range.ts";
import { validateSummary, type SummaryValidation } from "./validate.ts";
import { normalizeCompressionParams, type CompressionParams } from "./schema.ts";
import type { CanonicalIndex } from "../identity/types.ts";
import { appendProtectedSections, collectProtectedToolSections, extractProtectedSection, type ProtectionOptions } from "./protected.ts";
import { buildEligibility, compressibleSegments, unitBlockReason, type UnitBlockReason } from "./eligibility.ts";
import { unitAlias } from "../identity/snapshot.ts";
import { estimateTokens } from "../tokens/estimate.ts";

export interface CompressionBuildOptions { sessionId: string; extensionVersion: string; snapshot: BaselineSnapshot; state: ReducedState; params: CompressionParams; model: Model<any> | undefined; toolCallId?: string; maxSummaryChars?: number; maxNestedDepth?: number; index?: CanonicalIndex; protection?: ProtectionOptions; turnProtection?: { enabled: boolean; turns: number }; protectUserMessages?: boolean; }
export type CompressionBuildFailure = {
  ok: false;
  reason: string;
  rangeIndex?: number;
  id?: string;
  byTool?: string;
  byPattern?: string;
  hint?: string;
  /** Depth limit in force when nesting_limit_exceeded was raised. */
  limit?: number;
  cause?: UnitBlockReason;
  /** Every blocked unit across all requested ranges (content_protected). */
  blocked?: BlockedUnit[];
  /** Per offending range: the valid sub-ranges that split around its blockers. */
  splits?: RangeSplit[];
};
export interface BlockedUnit { id: string; rangeIndex: number; cause: UnitBlockReason; }
export interface RangeSplit { rangeIndex: number; requested: string; segments: string[]; }
export type CompressionBuildResult = { ok: true; envelope: ReturnType<typeof createEnvelope>; blocks: CreatedBlock[]; } | CompressionBuildFailure;
export function buildCompressionEnvelope(options: CompressionBuildOptions): CompressionBuildResult {
  const params = normalizeCompressionParams(options.params);
  const ranges = resolveCompressionRanges(options.snapshot, options.state, params.content.map(({ startId, endId }) => ({ startId, endId })));
  if (!ranges.ok) return ranges;
  // Tool-output protection (compress.protectedTools / protectedFilePatterns)
  // is deliberately absent from this eligibility check: a protected tool
  // call no longer blocks the range, its output is folded into the summary
  // verbatim below instead (collectProtectedToolSections). The only remaining
  // hard blockers are settledness and the user-turn protection rules.
  const eligibility = buildEligibility(options.snapshot.units, { turnProtection: options.turnProtection, protectUserMessages: options.protectUserMessages });
  // Collect EVERY blocker instead of failing on the first one. Reporting a
  // single unit ("drop m0572") hid that the range had seven blockers, so the
  // fix looked trivial but was not, and the model abandoned the retry. The
  // complete list plus ready-made split ranges makes the retry mechanical.
  const blocked: BlockedUnit[] = [];
  const splits: RangeSplit[] = [];
  for (const range of ranges.ranges) {
    const before = blocked.length;
    for (let unitIndex = range.start; unitIndex <= range.end; unitIndex++) {
      const cause = unitBlockReason(options.snapshot.units[unitIndex], unitIndex, eligibility);
      if (cause) blocked.push({ id: unitAlias(unitIndex), rangeIndex: range.rangeIndex, cause });
    }
    if (blocked.length > before) {
      const requested = `${unitAlias(range.start)}-${unitAlias(range.end)}`;
      splits.push({ rangeIndex: range.rangeIndex, requested, segments: compressibleSegments(options.snapshot.units, eligibility, range.start, range.end) });
    }
  }
  if (blocked.length) return { ok: false, reason: "content_protected", rangeIndex: blocked[0].rangeIndex, id: blocked[0].id, cause: blocked[0].cause, blocked, splits };
  const blocks: CreatedBlock[] = [];
  for (let index = 0; index < ranges.ranges.length; index++) {
    const range = ranges.ranges[index]; const authored = params.content[index].summary;
    const valid: SummaryValidation = validateSummary(authored, options.maxSummaryChars || 100000); if (!valid.ok) return { ok: false, reason: valid.reason, rangeIndex: range.rangeIndex, hint: authored.length > (options.maxSummaryChars || 100000) ? "exceeds maxChars" : "summary contains invalid content" };
    // A range that includes blocks merges them. The authored summary replaces
    // the whole range and is stored as written. Child summaries are NOT pasted
    // in: pasting kept every merged block as large as all its ancestors put
    // together. The children stay in their own records, inactive after the
    // reducer applies this envelope.
    const children = range.consumedBlockIds.flatMap((id) => { const child = options.state.blocks.get(id); return child ? [child] : []; });
    // Depth is one more than the deepest child. This is the smallest value the
    // reducer accepts (block.nestedDepth >= child.nestedDepth + 1), and it is
    // checked before anything persists: a stored block above MAX_NESTED_DEPTH
    // would fail replay for the whole session.
    const nestedDepth = children.reduce((depth, child) => Math.max(depth, child.nestedDepth + 1), 0);
    const depthLimit = Math.min(options.maxNestedDepth ?? MAX_NESTED_DEPTH, MAX_NESTED_DEPTH);
    if (nestedDepth > depthLimit) return { ok: false, reason: "nesting_limit_exceeded", rangeIndex: range.rangeIndex, limit: depthLimit };
    const units = options.snapshot.units.slice(range.start, range.end + 1);
    // Protected tool output is kept verbatim instead of blocking the range.
    // Children's protected output comes first and is carried even when this call
    // has no index or protection options: it is already stored in their summaries.
    // Tool calls that a child covers are skipped, so each child's stored output is
    // the only copy from it (appendProtectedSections also drops identical bodies).
    const coveredToolCallIds = new Set(children.flatMap((child) => child.coverage.effectiveToolCallIds));
    const ownProtected = options.index && options.protection
      ? collectProtectedToolSections(units, options.index, options.protection, coveredToolCallIds)
      : "";
    const finalSummary = appendProtectedSections(authored, [...children.map((child) => extractProtectedSection(child)), ownProtected]);
    const directEntryIds = [...new Set(units.flatMap((unit) => unit.entryIds))];
    const directToolCallIds = [...new Set(units.flatMap((unit) => unit.toolCallIds))];
    const nested = children.map((child) => child.coverage);
    const effectiveEntryIds = [...new Set([...directEntryIds, ...nested.flatMap((coverage) => coverage.effectiveEntryIds)])];
    const effectiveToolCallIds = [...new Set([...directToolCallIds, ...nested.flatMap((coverage) => coverage.effectiveToolCallIds)])];
    // Recall cues are the model's list for THIS block only. They are not carried
    // over from merged children: that would grow the list at every merge and keep
    // names that the new summary may no longer need. Nothing becomes unsearchable:
    // each child keeps its own summary and cues in its record, and the search
    // corpus indexes them there.
    const recall = cleanRecall(params.content[index].recall);
    // Cues are rendered with the block, so they count toward its footprint.
    const estimatedSummaryTokens = Math.max(1, Math.ceil([finalSummary, ...recall].join("\n").length / 4));
    const estimatedSourceTokens = estimateCompressionSourceTokens(options, units, range.consumedBlockIds);
    const block: CreatedBlock = { blockId: randomId(), ordinal: index, topic: params.topic, summary: finalSummary, authoredSummary: authored, estimatedSummaryTokens, estimatedSourceTokens, estimatedSavingsTokens: Math.max(0, estimatedSourceTokens - estimatedSummaryTokens), coverage: { directEntryIds, effectiveEntryIds, directToolCallIds, effectiveToolCallIds }, anchor: { beforeEntryId: options.snapshot.units[range.start - 1]?.entryIds.at(-1), afterEntryId: options.snapshot.units[range.end + 1]?.entryIds[0] }, consumedBlockIds: range.consumedBlockIds, nestedDepth, ...(recall.length ? { recall } : {}) };
    blocks.push(block);
  }
  const operation: CompressionCreated = { type: "compression.created", runId: randomId(), mode: "range", toolCallId: options.toolCallId || `legacy-${options.snapshot.hash.slice(0, 16)}`, snapshotHash: options.snapshot.hash, model: { provider: options.model?.provider || "unknown", id: options.model?.id || "unknown", api: options.model?.api || "unknown" }, blocks };
  const requestKey = sha256(`${options.sessionId}\0${operation.toolCallId}\0${options.snapshot.hash}`);
  const envelope = createEnvelope(operation, options.sessionId, options.extensionVersion, requestKey);
  // Carried protected output accumulates across merges, so a range can exceed
  // this limit even when its own summary is short.
  if (JSON.stringify(envelope).length > 256 * 1024) return { ok: false, reason: "summary_invalid", hint: "the stored operation exceeds 256 KiB; merge fewer blocks or shorten the summary" };
  return { ok: true, envelope, blocks };
}

/**
 * Normalize the model's cues before they are stored. Each cue becomes one trimmed
 * line, so the rendered list cannot break into extra lines. Blank and repeated
 * cues are dropped. An empty result omits the field entirely (see the block literal
 * above), so a block without cues keeps the fields it had before cues existed.
 */
function cleanRecall(cues: readonly string[] | undefined): string[] {
  const lines = (cues ?? []).map((cue) => cue.replace(/\s+/g, " ").trim()).filter((cue) => cue.length > 0);
  return [...new Set(lines)];
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
