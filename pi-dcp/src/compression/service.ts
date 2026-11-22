import type { Model } from "@earendil-works/pi-ai";
import { hashJson, randomId, sha256 } from "../util/hash.ts";
import type { BaselineSnapshot } from "../identity/types.ts";
import type { ReducedState } from "../state/reducer.ts";
import { createEnvelope, MAX_NESTED_DEPTH, type CompressionCreated, type CreatedBlock } from "../state/operations.ts";
import { isSingleBlockRewrite, resolveCompressionRanges } from "./range.ts";
import { validateSummary, type SummaryValidation } from "./validate.ts";
import { normalizeCompressionParams, type CompressionParams } from "./schema.ts";
import type { CanonicalIndex } from "../identity/types.ts";
import { appendProtectedSections, collectProtectedToolSections, extractProtectedSection, type ProtectionOptions } from "./protected.ts";
import { buildEligibility, compressibleRangeLabels, unitBlockReason, type UnitBlockReason } from "./eligibility.ts";
import { unitAlias } from "../identity/snapshot.ts";
import { estimateTokens, estimateToolResultTokens } from "../tokens/estimate.ts";

export interface CompressionBuildOptions { sessionId: string; extensionVersion: string; snapshot: BaselineSnapshot; state: ReducedState; params: CompressionParams; model: Model<any> | undefined; toolCallId?: string; maxSummaryChars?: number; index?: CanonicalIndex; protection?: ProtectionOptions; turnProtection?: { enabled: boolean; turns: number }; protectUserMessages?: boolean; }
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
/**
 * One rejected range and the valid replacement ranges that split around its blockers.
 * `blockBounded` is true when the model's range starts or ends on a bNNNN block. Then
 * the error explains that the walls lie between blocks, not inside them.
 */
export interface RangeSplit { rangeIndex: number; requested: string; segments: string[]; blockBounded: boolean; }
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
      // The model's own labels, not unit aliases. A block-bounded range would
      // otherwise be reported with m-labels that the model never wrote.
      const { startId, endId } = params.content[range.rangeIndex];
      // The same runs the inventory advertises. A run that is one block alone is
      // left out inside compressibleRangeLabels, so a retry never offers it.
      const segments = compressibleRangeLabels(options.snapshot, options.state, eligibility, range.start, range.end);
      splits.push({ rangeIndex: range.rangeIndex, requested: `${startId}-${endId}`, segments, blockBounded: isBlockLabel(startId) || isBlockLabel(endId) });
    }
  }
  if (blocked.length) return { ok: false, reason: "content_protected", rangeIndex: blocked[0].rangeIndex, id: blocked[0].id, cause: blocked[0].cause, blocked, splits };
  // A range that is one block and nothing else would only rewrite that block.
  // The rule is checked after blockers, so the model first fixes walls and then this.
  for (const range of ranges.ranges) {
    if (!isSingleBlockRewrite(options.snapshot, options.state, range)) continue;
    const id = [...options.snapshot.blockAliases.values()].find((item) => item.blockId === range.consumedBlockIds[0])?.alias;
    return { ok: false, reason: "single_block_rewrite", rangeIndex: range.rangeIndex, id };
  }
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
    // would fail replay for the whole session. The bound belongs to the stored
    // format, not to a setting: a configured lower limit would refuse merges that
    // replay accepts, which is how a copied old value (8) refused depth 9.
    const nestedDepth = children.reduce((depth, child) => Math.max(depth, child.nestedDepth + 1), 0);
    if (nestedDepth > MAX_NESTED_DEPTH) return { ok: false, reason: "nesting_limit_exceeded", rangeIndex: range.rangeIndex, limit: MAX_NESTED_DEPTH };
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
    const creditedPruneTokens = prunedTokensInRange(options.state, units, children, currentOutputTokens(options.index, units));
    // A range names its own phase when it can. A blank range topic counts as absent,
    // so the call topic applies. normalizeCompressionParams has already defaulted it.
    const block: CreatedBlock = { blockId: randomId(), ordinal: index, topic: params.content[index].topic?.trim() || params.topic, summary: finalSummary, authoredSummary: authored, estimatedSummaryTokens, estimatedSourceTokens, estimatedSavingsTokens: Math.max(0, estimatedSourceTokens - estimatedSummaryTokens), coverage: { directEntryIds, effectiveEntryIds, directToolCallIds, effectiveToolCallIds }, anchor: { beforeEntryId: options.snapshot.units[range.start - 1]?.entryIds.at(-1), afterEntryId: options.snapshot.units[range.end + 1]?.entryIds[0] }, consumedBlockIds: range.consumedBlockIds, nestedDepth, ...(recall.length ? { recall } : {}), ...(creditedPruneTokens > 0 ? { creditedPruneTokens } : {}) };
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

function isBlockLabel(alias: string): boolean {
  return alias.startsWith("b");
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
 * Tokens that earlier pruning decisions counted as saved for tool calls in this
 * range's own units. The block's source estimate reads raw history, so it already
 * contains these bytes. Consumed children are skipped: each child subtracted its
 * own decisions when it was created, and its raw bytes are not counted here again.
 *
 * An output's credit is capped at its current size (see currentOutputTokens). A
 * decision recorded before the image rule can hold a number far above the output's
 * real size, and subtracting that number would zero a block that really saves tokens.
 * The cap comes from the same messages the source counts, so the credit can never
 * exceed the part of the source that it removes.
 */
function prunedTokensInRange(state: ReducedState, units: readonly { toolCallIds: readonly string[] }[], children: readonly { coverage: { effectiveToolCallIds: readonly string[] } }[], outputTokens: ReadonlyMap<string, number>): number {
  const consumed = new Set(children.flatMap((child) => child.coverage.effectiveToolCallIds));
  let total = 0;
  for (const unit of units) for (const toolCallId of unit.toolCallIds) {
    if (consumed.has(toolCallId)) continue;
    const prune = state.toolPrunes.get(toolCallId);
    if (!prune) continue;
    // Without a current size (no index) the stored number stands. The source is then
    // not estimated at all (estimateCompressionSourceTokens returns 0), so no saving depends on it.
    const stored = prune.output?.estimatedTokens ?? 0;
    const current = outputTokens.get(toolCallId);
    const outputCredit = current === undefined ? stored : Math.min(stored, current);
    // oldErrorInput is legacy (see reducer.ts). Its tokens still lie inside the range.
    // Skipping it here would count them twice: once as the decision, and again inside
    // the block's own saving.
    total += outputCredit + (prune.oldErrorInput?.estimatedTokens ?? 0) + (prune.questionInput?.estimatedTokens ?? 0);
  }
  return total;
}

/**
 * Current size of each tool output in this range's own units, keyed by tool call.
 * It reads the same entries and projections that estimateCompressionSourceTokens
 * counts, so a credit taken from here measures the bytes that the source measured.
 */
function currentOutputTokens(index: CanonicalIndex | undefined, units: readonly { messageKeys: readonly { entryId: string; projection: number }[] }[]): Map<string, number> {
  const outputs = new Map<string, number>();
  if (!index) return outputs;
  const keys = new Set(units.flatMap((unit) => unit.messageKeys.map((key) => `${key.entryId}:${key.projection}`)));
  for (const item of index.entries) {
    if (item.message.role !== "toolResult" || !keys.has(`${item.key.entryId}:${item.key.projection}`)) continue;
    outputs.set(item.message.toolCallId, estimateToolResultTokens(item.message));
  }
  return outputs;
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
