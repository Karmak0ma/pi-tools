import { canonicalJson } from "../util/canonical-json.ts";
import { hashJson, randomId } from "../util/hash.ts";
import type { BlockId, EntryId, RunId, ToolCallId } from "../identity/types.ts";

export const OPERATION_CUSTOM_TYPE = "pi-dcp.v2.operation";
export const LEGACY_OPERATION_CUSTOM_TYPE = "pi-dcp.operation";
export const OPERATION_SCHEMA = 2 as const;

/**
 * Largest nestedDepth a stored block may have. Depth counts merge levels: a
 * block that merges children one level deeper is one level deeper itself. The
 * old limit of 8 bounded recursive text expansion, and merging no longer
 * expands text. Long sessions re-merge the same lineage many times, so 64 is
 * the new bound. Walks over consumedBlockIds (reducer.ts) stay within this
 * depth, so their recursion is safe.
 *
 * This bound is also a replay gate. A block above it fails isOperationEnvelope,
 * and reconstruction then marks the whole session's state corrupt. The service
 * must therefore refuse such a merge before it persists anything.
 */
export const MAX_NESTED_DEPTH = 64;

/**
 * Bounds on a range's recall cues. The model-facing schema (compression/schema.ts)
 * uses the same numbers, so a call that passes validation always replays. A cue
 * is one short line; the bound keeps the list small enough to render with every
 * block.
 *
 * Replay enforces these bounds too (isRecallCues), so they are a persisted-format
 * contract. A stored cue above a later, lower bound would fail replay and mark the
 * whole session corrupt. Raise these bounds if needed, but never lower them.
 */
export const MAX_RECALL_CUES = 6;
export const MAX_RECALL_CUE_CHARS = 160;

export interface CanonicalCoverage {
  directEntryIds: EntryId[];
  effectiveEntryIds: EntryId[];
  directToolCallIds: ToolCallId[];
  effectiveToolCallIds: ToolCallId[];
}

export interface CreatedBlock {
  blockId: BlockId;
  ordinal: number;
  topic: string;
  summary: string;
  authoredSummary: string;
  estimatedSummaryTokens: number;
  estimatedSourceTokens?: number;
  estimatedSavingsTokens?: number;
  coverage: CanonicalCoverage;
  anchor: { beforeEntryId?: string; afterEntryId?: string };
  consumedBlockIds: BlockId[];
  nestedDepth: number;
  /**
   * Searchable names of details that the summary leaves out but the original
   * history keeps. Optional: blocks created before cues existed have none, and a
   * block without cues has no such key, so its persisted bytes do not change.
   */
  recall?: string[];
}

export interface CompressionCreated {
  type: "compression.created";
  runId: RunId;
  mode: "range";
  toolCallId: ToolCallId;
  snapshotHash: string;
  model: { provider: string; id: string; api: string };
  blocks: CreatedBlock[];
}

export interface PrunedToolDecision {
  toolCallId: ToolCallId;
  kind: "dedup-output" | "old-error-input" | "sweep-output" | "question-input";
  estimatedTokens: number;
}
export interface ToolsPruned { type: "tools.pruned"; decisions: PrunedToolDecision[]; }
export interface BlockActivationChanged {
  type: "blocks.activation.changed";
  blockIds: BlockId[];
  active: boolean;
  cause: "user-decompress" | "user-recompress";
}
export interface ManualModeChanged { type: "manual.changed"; enabled: boolean; }
export interface NudgeRequested {
  type: "nudge.requested";
  /** Optional for replay compatibility with v2 operations created before semantic nudges. */
  kind?: "context" | "turn" | "iteration";
  nudgeKey: string;
  band: "soft" | "imperative" | "critical";
  branchAnchor: string | null;
  configGeneration: number;
}

export type DcpOperation = CompressionCreated | BlockActivationChanged | ToolsPruned | ManualModeChanged | NudgeRequested;

export interface OpEnvelope {
  schema: 2;
  opId: string;
  requestKey: string;
  originSessionId: string;
  createdAt: number;
  extensionVersion: string;
  operation: DcpOperation;
}

export interface LegacyOpEnvelope {
  schema: 1;
  opId: string;
  requestKey: string;
  sessionId: string;
  createdAt: number;
  extensionVersion: string;
  operation: Exclude<DcpOperation, NudgeRequested>;
}

export function createEnvelope(operation: DcpOperation, originSessionId: string, extensionVersion: string, requestKey = hashJson([originSessionId, operation])): OpEnvelope {
  return { schema: OPERATION_SCHEMA, opId: randomId(), requestKey, originSessionId, createdAt: Date.now(), extensionVersion, operation };
}

export function operationPayloadHash(operation: DcpOperation): string { return hashJson(operation); }

export function isOperationEnvelope(value: unknown): value is OpEnvelope {
  if (!value || typeof value !== "object") return false;
  const object = value as Record<string, unknown>;
  return object.schema === 2
    && typeof object.opId === "string" && isUuid(object.opId)
    && typeof object.requestKey === "string" && object.requestKey.length > 0
    && typeof object.originSessionId === "string" && object.originSessionId.length > 0
    && typeof object.createdAt === "number" && Number.isFinite(object.createdAt)
    && typeof object.extensionVersion === "string" && object.extensionVersion.length > 0
    && isOperation(object.operation);
}

/** Legacy entries are intentionally recognized only so replay can ignore them. */
export function isLegacyOperationEnvelope(value: unknown): value is LegacyOpEnvelope {
  if (!value || typeof value !== "object") return false;
  const object = value as Record<string, unknown>;
  return object.schema === 1
    && typeof object.opId === "string" && isUuid(object.opId)
    && typeof object.requestKey === "string" && object.requestKey.length > 0
    && typeof object.sessionId === "string" && object.sessionId.length > 0
    && typeof object.createdAt === "number" && Number.isFinite(object.createdAt)
    && typeof object.extensionVersion === "string" && object.extensionVersion.length > 0
    && isLegacyOperation(object.operation);
}

export function isOperation(value: unknown): value is DcpOperation {
  if (!value || typeof value !== "object" || typeof (value as { type?: unknown }).type !== "string") return false;
  const operation = value as Record<string, unknown>;
  if (operation.type === "compression.created") {
    return typeof operation.runId === "string" && operation.mode === "range"
      && typeof operation.toolCallId === "string" && typeof operation.snapshotHash === "string"
      && isModel(operation.model) && Array.isArray(operation.blocks)
      && operation.blocks.length >= 1 && operation.blocks.length <= 16
      && operation.blocks.every(isCreatedBlock);
  }
  if (operation.type === "tools.pruned") return Array.isArray(operation.decisions) && operation.decisions.every(isDecision);
  if (operation.type === "blocks.activation.changed") {
    return Array.isArray(operation.blockIds) && operation.blockIds.length > 0
      && operation.blockIds.every((id) => typeof id === "string" && id.length > 0)
      && typeof operation.active === "boolean"
      && (operation.cause === "user-decompress" || operation.cause === "user-recompress");
  }
  if (operation.type === "manual.changed") return typeof operation.enabled === "boolean";
  if (operation.type === "nudge.requested") {
    return (operation.kind === undefined || operation.kind === "context" || operation.kind === "turn" || operation.kind === "iteration")
      && typeof operation.nudgeKey === "string" && operation.nudgeKey.length > 0
      && (operation.band === "soft" || operation.band === "imperative" || operation.band === "critical")
      && (operation.branchAnchor === null || typeof operation.branchAnchor === "string")
      && typeof operation.configGeneration === "number" && Number.isInteger(operation.configGeneration) && operation.configGeneration >= 0;
  }
  return false;
}

function isLegacyOperation(value: unknown): value is Exclude<DcpOperation, NudgeRequested> {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return type !== "nudge.requested" && isOperation(value);
}
function isModel(value: unknown): value is { provider: string; id: string; api: string } {
  if (!value || typeof value !== "object") return false;
  const model = value as Record<string, unknown>;
  return typeof model.provider === "string" && typeof model.id === "string" && typeof model.api === "string";
}
function isStringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0); }
function isCreatedBlock(value: unknown): value is CreatedBlock {
  if (!value || typeof value !== "object") return false;
  const block = value as Record<string, unknown>;
  const coverage = block.coverage as Record<string, unknown> | undefined;
  const anchor = block.anchor as Record<string, unknown> | undefined;
  return typeof block.blockId === "string" && block.blockId.length > 0
    && typeof block.ordinal === "number" && Number.isInteger(block.ordinal) && block.ordinal >= 0
    && typeof block.topic === "string" && block.topic.length > 0
    && typeof block.summary === "string" && block.summary.length > 0
    && typeof block.authoredSummary === "string" && block.authoredSummary.length > 0
    && typeof block.estimatedSummaryTokens === "number" && Number.isFinite(block.estimatedSummaryTokens)
    && (block.estimatedSourceTokens === undefined || (typeof block.estimatedSourceTokens === "number" && Number.isFinite(block.estimatedSourceTokens) && block.estimatedSourceTokens >= 0))
    && (block.estimatedSavingsTokens === undefined || (typeof block.estimatedSavingsTokens === "number" && Number.isFinite(block.estimatedSavingsTokens) && block.estimatedSavingsTokens >= 0))
    && !!coverage
    && isStringArray(coverage.directEntryIds)
    && isStringArray(coverage.effectiveEntryIds) && coverage.effectiveEntryIds.length > 0
    && isStringArray(coverage.directToolCallIds)
    && isStringArray(coverage.effectiveToolCallIds)
    && !!anchor
    && (anchor.beforeEntryId === undefined || typeof anchor.beforeEntryId === "string")
    && (anchor.afterEntryId === undefined || typeof anchor.afterEntryId === "string")
    && isStringArray(block.consumedBlockIds)
    && typeof block.nestedDepth === "number" && Number.isInteger(block.nestedDepth) && block.nestedDepth >= 0 && block.nestedDepth <= MAX_NESTED_DEPTH
    && (block.recall === undefined || isRecallCues(block.recall));
}
/** Replay gate for recall cues. Shared with the model-facing schema so both enforce one bound. */
export function isRecallCues(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_RECALL_CUES
    && value.every((cue) => typeof cue === "string" && cue.length >= 1 && cue.length <= MAX_RECALL_CUE_CHARS);
}
function isDecision(value: unknown): value is PrunedToolDecision {
  if (!value || typeof value !== "object") return false;
  const decision = value as Record<string, unknown>;
  return typeof decision.toolCallId === "string" && decision.toolCallId.length > 0
    && (decision.kind === "dedup-output" || decision.kind === "old-error-input" || decision.kind === "sweep-output" || decision.kind === "question-input")
    && typeof decision.estimatedTokens === "number" && Number.isFinite(decision.estimatedTokens) && decision.estimatedTokens >= 0;
}
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
export function canonicalBlockPayload(block: CreatedBlock): string { return canonicalJson(block); }
