import type { Model } from "@earendil-works/pi-ai";
import { hashJson } from "../util/hash.ts";
import type { ReducedState } from "../state/reducer.ts";
import type { BaselineKey, BaselineSnapshot, CanonicalIndex, ModelKey, SnapshotBlockAlias } from "./types.ts";

/**
 * The single formula used to name every protocol-unit alias. Every consumer
 * that needs "which mNNNN is unit index N" (label injection, compression
 * validation, error/status reporting) calls this instead of re-deriving or
 * scanning `unitAliases`, so they cannot drift out of sync with each other.
 */
export function unitAlias(index: number): string {
  return `m${String(index + 1).padStart(4, "0")}`;
}

export function modelKey(model: Model<any> | undefined, contextWindow = 0): ModelKey {
  return {
    provider: model?.provider || "unknown",
    id: model?.id || "unknown",
    api: model?.api || "unknown",
    contextWindow: model?.contextWindow || contextWindow,
  };
}

/**
 * Build a deterministic baseline. No request counter, wall clock, random ID,
 * or expiry participates in the returned provider-facing representation.
 */
export function createSnapshot(options: {
  sessionId: string;
  leafId: string | null;
  model: ModelKey;
  generation: number;
  index: CanonicalIndex;
  state: ReducedState;
  configHash: string;
  branchIdentity?: string;
  thinkingLevel?: string;
  /** Deprecated input accepted only to ease source migration; it is ignored. */
  ttlMs?: number;
}): BaselineSnapshot {
  const units = options.index.units.map((unit) => ({
    ...unit,
    entryIds: [...unit.entryIds],
    messageKeys: unit.messageKeys.map((key) => ({ ...key })),
    toolCallIds: [...unit.toolCallIds],
  }));

  // Label every protocol unit. Skipping non-compressible units would make an
  // append change the visible ordinal sequence, while validation can still
  // reject protected/non-compressible ranges.
  const unitAliases = new Map<string, number>();
  for (let index = 0; index < units.length; index++) {
    if (index + 1 > 9999) throw new Error("alias_overflow");
    unitAliases.set(unitAlias(index), index);
  }

  const blockAliases = new Map<string, SnapshotBlockAlias>();
  const blockRanges = new Map<string, { start: number; end: number }>();
  const activeBlocks = [...options.state.blocks.entries()]
    .filter(([, block]) => block.active && block.available)
    .map(([blockId, block]) => ({
      blockId,
      block,
      indexes: units
        .map((unit, index) => block.coverage.effectiveEntryIds.some((entryId) => unit.entryIds.includes(entryId)) ? index : -1)
        .filter((index) => index >= 0),
    }))
    .sort((a, b) => (a.indexes[0] ?? Number.MAX_SAFE_INTEGER) - (b.indexes[0] ?? Number.MAX_SAFE_INTEGER) || a.blockId.localeCompare(b.blockId));

  for (let index = 0; index < activeBlocks.length; index++) {
    const { blockId, block, indexes } = activeBlocks[index];
    const ordinal = index + 1;
    if (ordinal > 9999) throw new Error("alias_overflow");
    const alias = `b${String(ordinal).padStart(4, "0")}`;
    blockAliases.set(alias, {
      alias,
      blockId,
      topic: block.topic,
      estimatedSummaryTokens: block.estimatedSummaryTokens,
    });
    if (indexes.length) blockRanges.set(blockId, { start: Math.min(...indexes), end: Math.max(...indexes) });
  }

  const projectionHash = hashJson(options.index.entries.map((entry) => ({
    key: entry.key,
    fingerprint: entry.fingerprint,
  })));
  const dcpTransformHash = hashJson({
    activeBlocks: [...blockAliases.values()].map((block) => ({ alias: block.alias, blockId: block.blockId })),
    prunedTools: [...options.state.toolPrunes.entries()].sort(([a], [b]) => a.localeCompare(b)),
    aliasTransport: "local-unit-inline-v1",
  });
  const branchIdentity = options.branchIdentity || options.sessionId;
  const key: BaselineKey = {
    branchIdentity,
    leafId: options.leafId,
    provider: options.model.provider,
    modelId: options.model.id,
    api: options.model.api,
    contextWindow: options.model.contextWindow,
    thinkingLevel: options.thinkingLevel || "default",
    generation: options.generation,
    configSafetyHash: options.configHash,
    projectionHash,
    dcpTransformHash,
  };
  const hash = computeSnapshotHash({
    sessionId: branchIdentity,
    leafId: options.leafId,
    model: options.model,
    configHash: options.configHash,
    generation: options.generation,
    units,
    activeBlockIds: [...blockAliases.values()].map((block) => block.blockId),
  });

  return {
    key,
    sessionId: options.sessionId,
    leafId: options.leafId,
    model: options.model,
    generation: options.generation,
    hash,
    units,
    unitAliases,
    blockAliases,
    activeBlockIds: [...blockAliases.values()].map((block) => block.blockId),
    blockRanges,
    index: options.index,
    // Kept deterministic so equivalent transforms are deeply equal in tests.
    createdMonotonicMs: 0,
  };
}

export function computeSnapshotHash(options: {
  sessionId: string;
  leafId: string | null;
  model: ModelKey;
  configHash: string;
  generation: number;
  units: readonly { key: string; toolCallIds: readonly string[]; contentDigest?: string }[];
  activeBlockIds: readonly string[];
}): string {
  return hashJson({
    branch: options.sessionId,
    leafId: options.leafId,
    model: options.model,
    configHash: options.configHash,
    generation: options.generation,
    units: options.units.map((unit) => ({ key: unit.key, calls: unit.toolCallIds, digest: unit.contentDigest })),
    blocks: [...options.activeBlockIds],
  });
}

export const computeBaselineHash = computeSnapshotHash;
/** Descriptive v2 name; createSnapshot remains a narrow migration alias. */
export const createBaselineSnapshot = createSnapshot;
