import type { Model } from "@earendil-works/pi-ai";
import { hashJson } from "../util/hash.ts";
import { outgoingPrune, requestLayout, type ReducedBlock, type ReducedState } from "../state/reducer.ts";
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

/**
 * The label of the block at `ordinal` (1-based) in alias order. Shared by
 * createSnapshot and the compress result, so a block is named the same way
 * wherever it is printed.
 */
export function blockAlias(ordinal: number): string {
  return `b${String(ordinal).padStart(4, "0")}`;
}

/**
 * The first and last unit a block covers, or undefined when no unit holds one
 * of its effective entries.
 *
 * This is the one definition of a block's span. Range resolution (range.ts),
 * the rendered replacement (transform/blocks.ts), the alias order
 * (orderedActiveBlocks), and the compress inventory (eligibility.ts) all call
 * it. Two definitions could disagree about where a block ends, and then the
 * inventory would advertise a label the request does not show, or hide one it does.
 */
export function blockSpan(units: readonly { entryIds: readonly string[] }[], block: Pick<ReducedBlock, "coverage">): { start: number; end: number } | undefined {
  let start = -1;
  let end = -1;
  for (let index = 0; index < units.length; index++) {
    if (!block.coverage.effectiveEntryIds.some((entryId) => units[index].entryIds.includes(entryId))) continue;
    if (start < 0) start = index;
    end = index;
  }
  return start < 0 ? undefined : { start, end };
}

/**
 * The active, available blocks in alias order: by the earliest unit each one
 * covers, then by blockId. Aliases are positional, so appending history never
 * renumbers an existing block. A block created earlier in history can renumber
 * later ones, which is why a label is valid only for the request it was
 * published in.
 *
 * This is the only ordering rule. createSnapshot uses it, and the compress
 * result uses it to name a new block with the alias the next request shows.
 */
export function orderedActiveBlocks(units: readonly { entryIds: readonly string[] }[], state: ReducedState): { blockId: string; block: ReducedBlock; span: { start: number; end: number } | undefined }[] {
  return [...state.blocks.entries()]
    .filter(([, block]) => block.active && block.available)
    .map(([blockId, block]) => ({ blockId, block, span: blockSpan(units, block) }))
    .sort((a, b) => (a.span?.start ?? Number.MAX_SAFE_INTEGER) - (b.span?.start ?? Number.MAX_SAFE_INTEGER) || a.blockId.localeCompare(b.blockId));
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
  /** Session branch entries, in order. Pruning claims are placed on this order, not on projected indexes. */
  branch: readonly { id: string }[];
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

  const layout = requestLayout(options.branch, units, options.state);
  const blockAliases = new Map<string, SnapshotBlockAlias>();
  const blockRanges = new Map<string, { start: number; end: number }>();
  const activeBlocks = orderedActiveBlocks(units, options.state);

  for (let index = 0; index < activeBlocks.length; index++) {
    const { blockId, block, span } = activeBlocks[index];
    const ordinal = index + 1;
    if (ordinal > 9999) throw new Error("alias_overflow");
    const alias = blockAlias(ordinal);
    blockAliases.set(alias, {
      alias,
      blockId,
      topic: block.topic,
      estimatedSummaryTokens: block.estimatedSummaryTokens,
    });
    if (span) blockRanges.set(blockId, span);
  }

  const projectionHash = hashJson(options.index.entries.map((entry) => ({
    key: entry.key,
    fingerprint: entry.fingerprint,
  })));
  const dcpTransformHash = hashJson({
    activeBlocks: [...blockAliases.values()].map((block) => ({ alias: block.alias, blockId: block.blockId })),
    // Only the claims that shape the request. A pending claim changes nothing the
    // model receives, so it must not change the identity of this request either.
    prunedTools: [...options.state.toolPrunes.keys()].sort((a, b) => a.localeCompare(b)).flatMap((toolCallId) => {
      const prune = outgoingPrune(options.state, toolCallId, layout);
      return prune ? [[toolCallId, prune] as const] : [];
    }),
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
    layout,
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
