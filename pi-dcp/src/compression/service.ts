import type { Model } from "@earendil-works/pi-ai";
import { hashJson, randomId, sha256 } from "../util/hash.ts";
import type { ContextSnapshot } from "../identity/types.ts";
import type { ReducedState } from "../state/reducer.ts";
import { createEnvelope, type CompressionCreated, type CreatedBlock } from "../state/operations.ts";
import { expandNestedSummary } from "./nesting.ts";
import { resolveCompressionRanges } from "./range.ts";
import { validateSummary, type SummaryValidation } from "./validate.ts";
import type { CompressionParams } from "./schema.ts";
import type { CanonicalIndex } from "../identity/types.ts";
import { protectUnit, type ProtectionOptions } from "./protected.ts";

export interface CompressionBuildOptions { sessionId: string; extensionVersion: string; snapshot: ContextSnapshot; state: ReducedState; params: CompressionParams; model: Model<any> | undefined; toolCallId?: string; maxSummaryChars?: number; maxExpandedChars?: number; maxNestedDepth?: number; index?: CanonicalIndex; protection?: ProtectionOptions; turnProtection?: { enabled: boolean; turns: number }; protectUserMessages?: boolean; }
export type CompressionBuildResult = { ok: true; envelope: ReturnType<typeof createEnvelope>; blocks: CreatedBlock[]; } | { ok: false; reason: string };
export function buildCompressionEnvelope(options: CompressionBuildOptions): CompressionBuildResult {
  if (options.snapshot.snapshotId !== options.params.snapshotId) return { ok: false, reason: "snapshot_stale" };
  const ranges = resolveCompressionRanges(options.snapshot, options.state, options.params.content.map(({ startId, endId }) => ({ startId, endId })));
  if (!ranges.ok) return ranges;
  const lastUser = Math.max(-1, ...options.snapshot.units.map((unit, index) => unit.role === "user" ? index : -1));
  const protectedUserStart = options.turnProtection?.enabled ? Math.max(0, lastUser - options.turnProtection.turns + 1) : Number.POSITIVE_INFINITY;
  for (const range of ranges.ranges) {
    const selectedUnits = options.snapshot.units.slice(range.start, range.end + 1);
    if (selectedUnits.some((unit, offset) => !unit.compressible || (options.protectUserMessages && unit.role === "user") || (unit.role === "user" && range.start + offset === lastUser) || (options.turnProtection?.enabled && unit.role === "user" && range.start + offset >= protectedUserStart))) return { ok: false, reason: "content_protected" };
    if (options.index && options.protection) for (let unitIndex = range.start; unitIndex <= range.end; unitIndex++) { const unit = options.snapshot.units[unitIndex]; const messages = options.index.entries.filter((item) => unit.messageKeys.some((key) => key.entryId === item.key.entryId && key.projection === item.key.projection)).map((item) => item.message); if (protectUnit(messages, options.protection)) return { ok: false, reason: "content_protected" }; }
  }
  const blocks: CreatedBlock[] = [];
  for (let index = 0; index < ranges.ranges.length; index++) {
    const range = ranges.ranges[index]; const authored = options.params.content[index].summary;
    const valid: SummaryValidation = validateSummary(authored, options.maxSummaryChars || 100000); if (!valid.ok) return valid;
    const aliases = new Map([...options.snapshot.blockAliases.entries()].map(([alias, block]) => [alias, block.blockId]));
    const expanded = expandNestedSummary(authored, range.consumedBlockIds, options.state, options.maxNestedDepth || 8, options.maxExpandedChars || 200000, aliases); if (!expanded.ok) return expanded;
    const units = options.snapshot.units.slice(range.start, range.end + 1);
    const directEntryIds = [...new Set(units.flatMap((unit) => unit.entryIds))];
    const directToolCallIds = [...new Set(units.flatMap((unit) => unit.toolCallIds))];
    const nested = range.consumedBlockIds.flatMap((id) => options.state.blocks.get(id)?.coverage || []).filter(Boolean);
    const effectiveEntryIds = [...new Set([...directEntryIds, ...nested.flatMap((coverage) => coverage.effectiveEntryIds)])];
    const effectiveToolCallIds = [...new Set([...directToolCallIds, ...nested.flatMap((coverage) => coverage.effectiveToolCallIds)])];
    const block: CreatedBlock = { blockId: randomId(), ordinal: index, topic: options.params.topic, summary: expanded.summary, authoredSummary: authored, estimatedSummaryTokens: Math.max(1, Math.ceil(expanded.summary.length / 4)), coverage: { directEntryIds, effectiveEntryIds, directToolCallIds, effectiveToolCallIds }, anchor: { beforeEntryId: options.snapshot.units[range.start - 1]?.entryIds.at(-1), afterEntryId: options.snapshot.units[range.end + 1]?.entryIds[0] }, consumedBlockIds: expanded.consumedBlockIds, nestedDepth: expanded.depth };
    blocks.push(block);
  }
  const operation: CompressionCreated = { type: "compression.created", runId: randomId(), mode: "range", toolCallId: options.toolCallId || options.params.snapshotId, snapshotHash: options.snapshot.hash, model: { provider: options.model?.provider || "unknown", id: options.model?.id || "unknown", api: options.model?.api || "unknown" }, blocks };
  const requestKey = sha256(`${options.sessionId}\0${operation.toolCallId}\0${options.snapshot.hash}`);
  const envelope = createEnvelope(operation, options.sessionId, options.extensionVersion, requestKey);
  if (JSON.stringify(envelope).length > 256 * 1024) return { ok: false, reason: "summary_invalid" };
  return { ok: true, envelope, blocks };
}
