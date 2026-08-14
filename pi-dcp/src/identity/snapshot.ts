import type { Model } from "@earendil-works/pi-ai";
import { hashJson, randomSnapshotId } from "../util/hash.ts";
import type { ReducedState } from "../state/reducer.ts";
import type { CanonicalIndex, ContextSnapshot, ModelKey } from "./types.ts";

export function modelKey(model: Model<any> | undefined, contextWindow = 0): ModelKey {
  return { provider: model?.provider || "unknown", id: model?.id || "unknown", api: model?.api || "unknown", contextWindow: model?.contextWindow || contextWindow };
}

export function createSnapshot(options: { sessionId: string; leafId: string | null; model: ModelKey; generation: number; ttlMs: number; index: CanonicalIndex; state: ReducedState; configHash: string }): ContextSnapshot {
  const createdAt = Date.now();
  const units = options.index.units.map((unit) => ({ ...unit, entryIds: [...unit.entryIds], messageKeys: unit.messageKeys.map((key) => ({ ...key })), toolCallIds: [...unit.toolCallIds] }));
  const unitAliases = new Map<string, number>();
  let modelOrdinal = 1;
  for (let i = 0; i < units.length; i++) if (units[i].compressible) unitAliases.set(`m${String(modelOrdinal++).padStart(4, "0")}`, i);
  const blockAliases = new Map<string, { alias: string; blockId: string; topic: string; estimatedSummaryTokens: number }>();
  const blockRanges = new Map<string, { start: number; end: number }>();
  let blockOrdinal = 1;
  const activeBlocks = [...options.state.blocks.entries()].filter(([, block]) => block.active && block.available).map(([blockId, block]) => ({ blockId, block, indexes: units.map((unit, index) => block.coverage.effectiveEntryIds.some((entryId) => unit.entryIds.includes(entryId)) ? index : -1).filter((index) => index >= 0) })).sort((a, b) => (a.indexes[0] ?? Number.MAX_SAFE_INTEGER) - (b.indexes[0] ?? Number.MAX_SAFE_INTEGER) || a.blockId.localeCompare(b.blockId));
  for (const { blockId, block, indexes } of activeBlocks) { const alias = `b${String(blockOrdinal++).padStart(4, "0")}`; blockAliases.set(alias, { alias, blockId, topic: block.topic, estimatedSummaryTokens: block.estimatedSummaryTokens }); if (indexes.length) blockRanges.set(blockId, { start: Math.min(...indexes), end: Math.max(...indexes) }); }
  const hash = computeSnapshotHash({ sessionId: options.sessionId, leafId: options.leafId, model: options.model, configHash: options.configHash, generation: options.generation, units, activeBlockIds: [...blockAliases.values()].map((block) => block.blockId) });
  return { snapshotId: randomSnapshotId(), sessionId: options.sessionId, leafId: options.leafId, model: options.model, generation: options.generation, createdAt, expiresAt: createdAt + options.ttlMs, hash, units, unitAliases, blockAliases, activeBlockIds: [...blockAliases.values()].map((block) => block.blockId), blockRanges };
}

export function computeSnapshotHash(options: { sessionId: string; leafId: string | null; model: ModelKey; configHash: string; generation: number; units: readonly { key: string; toolCallIds: readonly string[]; contentDigest?: string }[]; activeBlockIds: readonly string[] }): string { return hashJson({ sessionId: options.sessionId, leafId: options.leafId, model: options.model, configHash: options.configHash, generation: options.generation, units: options.units.map((unit) => ({ key: unit.key, calls: unit.toolCallIds, digest: unit.contentDigest })), blocks: [...options.activeBlockIds] }); }

export function isSnapshotCurrent(snapshot: ContextSnapshot | undefined, current: { sessionId: string; leafId: string | null; model: ModelKey; generation: number; hash?: string }, now = Date.now()): boolean {
  if (!snapshot || now > snapshot.expiresAt) return false;
  return snapshot.sessionId === current.sessionId && snapshot.leafId === current.leafId && snapshot.generation === current.generation && snapshot.model.provider === current.model.provider && snapshot.model.id === current.model.id && snapshot.model.api === current.model.api && (!current.hash || snapshot.hash === current.hash);
}
