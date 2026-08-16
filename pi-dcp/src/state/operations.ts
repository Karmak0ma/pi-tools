import { canonicalJson } from "../util/canonical-json.ts";
import { hashJson, randomId } from "../util/hash.ts";
import type { BlockId, EntryId, RunId, ToolCallId } from "../identity/types.ts";

export const OPERATION_CUSTOM_TYPE = "pi-dcp.v2.operation";
export const LEGACY_OPERATION_CUSTOM_TYPE = "pi-dcp.operation";
export const OPERATION_SCHEMA = 2 as const;

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
    return typeof operation.nudgeKey === "string" && operation.nudgeKey.length > 0
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
    && typeof block.nestedDepth === "number" && Number.isInteger(block.nestedDepth) && block.nestedDepth >= 0 && block.nestedDepth <= 8;
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
