import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type EntryId = string;
export type ToolCallId = string;
export type BlockId = string;
export type RunId = string;

export type CanonicalMessageKey = { kind: "entry"; entryId: EntryId; projection: number };

export interface ProjectedMessage {
  key: CanonicalMessageKey;
  message: AgentMessage;
  fingerprint: string;
  toolCallIds: ToolCallId[];
}

export interface ProtocolUnit {
  key: string;
  entryIds: EntryId[];
  messageKeys: CanonicalMessageKey[];
  toolCallIds: ToolCallId[];
  startProjectedIndex: number;
  endProjectedIndex: number;
  settled: boolean;
  compressible: boolean;
  role: string;
  descriptor: string;
  contentDigest?: string;
}

export interface CanonicalIndex {
  entries: ProjectedMessage[];
  units: ProtocolUnit[];
  messageToUnit: Map<string, number>;
}

export interface ModelKey {
  provider: string;
  id: string;
  api: string;
  contextWindow: number;
}

export interface BaselineKey {
  /** The selected branch lineage. Session IDs are deliberately not used here. */
  branchIdentity: string;
  leafId: string | null;
  provider: string;
  modelId: string;
  api: string;
  contextWindow: number;
  thinkingLevel: string;
  generation: number;
  configSafetyHash: string;
  projectionHash: string;
  dcpTransformHash: string;
}

export interface SnapshotBlockAlias {
  alias: string;
  blockId: BlockId;
  topic: string;
  estimatedSummaryTokens: number;
}

/** An immutable, internal authorization baseline. */
export interface BaselineSnapshot {
  key: BaselineKey;
  sessionId: string;
  leafId: string | null;
  model: ModelKey;
  generation: number;
  hash: string;
  units: ProtocolUnit[];
  unitAliases: Map<string, number>;
  blockAliases: Map<string, SnapshotBlockAlias>;
  activeBlockIds: BlockId[];
  blockRanges?: Map<BlockId, { start: number; end: number }>;
  index?: CanonicalIndex;
  createdMonotonicMs: number;
}

export type JoinResult =
  | { ok: true; incomingByExpected: number[] }
  | { ok: false; reason: "join_ambiguous" | "protocol_invalid" };
