import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Logger } from "./observability/logger.ts";
import type { OpEnvelope, DcpOperation } from "./state/operations.ts";

/**
 * These are operation-level savings, not per-request context deltas. Counting
 * every transformed request would count the same compressed block repeatedly;
 * recording each persisted pruning/compression operation once gives cumulative
 * and replayable statistics instead.
 */
export const SAVINGS_SOURCES = [
  "compression",
  "deduplication",
  "sweep",
  "old-error-input",
  "question-input",
] as const;

export type SavingsSource = (typeof SAVINGS_SOURCES)[number];

export interface SavingsBucket {
  events: number;
  tokens: number;
}

export type SavingsTotals = Record<SavingsSource, SavingsBucket>;

export interface SavingsRecord {
  schema: 1;
  operationId: string;
  sessionId: string;
  createdAt: number;
  savings: Partial<Record<SavingsSource, SavingsBucket>>;
}

export interface SavingsLedger {
  totals: SavingsTotals;
  operationIds: Set<string>;
}

export function emptySavingsTotals(): SavingsTotals {
  return Object.fromEntries(SAVINGS_SOURCES.map((source) => [source, { events: 0, tokens: 0 }])) as SavingsTotals;
}

export function cloneSavingsTotals(totals: SavingsTotals): SavingsTotals {
  return Object.fromEntries(SAVINGS_SOURCES.map((source) => [source, { ...totals[source] }])) as SavingsTotals;
}

export function addSavingsTotals(target: SavingsTotals, addition: Partial<Record<SavingsSource, SavingsBucket>>): SavingsTotals {
  for (const source of SAVINGS_SOURCES) {
    const bucket = addition[source];
    if (!bucket) continue;
    target[source].events += finiteNonNegative(bucket.events);
    target[source].tokens += finiteNonNegative(bucket.tokens);
  }
  return target;
}

export function savingsFromOperation(operation: DcpOperation): Partial<Record<SavingsSource, SavingsBucket>> {
  if (operation.type === "compression.created") {
    return {
      compression: {
        events: operation.blocks.length,
        tokens: operation.blocks.reduce((total, block) => total + finiteNonNegative(block.estimatedSavingsTokens), 0),
      },
    };
  }
  if (operation.type === "tools.pruned") {
    const savings = {} as Partial<Record<SavingsSource, SavingsBucket>>;
    for (const decision of operation.decisions) {
      const source = decision.kind === "dedup-output"
        ? "deduplication"
        : decision.kind === "sweep-output"
          ? "sweep"
          : decision.kind;
      const bucket = savings[source] || { events: 0, tokens: 0 };
      bucket.events++;
      bucket.tokens += finiteNonNegative(decision.estimatedTokens);
      savings[source] = bucket;
    }
    return savings;
  }
  return {};
}

export function savingsRecordFromEnvelope(envelope: OpEnvelope): SavingsRecord | undefined {
  const savings = savingsFromOperation(envelope.operation);
  if (!Object.values(savings).some((bucket) => bucket && bucket.events > 0)) return undefined;
  return {
    schema: 1,
    operationId: envelope.opId,
    sessionId: envelope.originSessionId,
    createdAt: envelope.createdAt,
    savings,
  };
}

export function statsPath(env: NodeJS.ProcessEnv = process.env): string {
  const agentDir = env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, "dcp_stats.jsonl");
}

/**
 * The ledger is append-only so two Pi sessions do not overwrite one another's
 * totals. Readers deduplicate operation IDs, which also makes startup repair
 * safe if a process appended the same historical operation more than once.
 */
export async function appendSavingsRecord(envelope: OpEnvelope, path = statsPath()): Promise<boolean> {
  const record = savingsRecordFromEnvelope(envelope);
  if (!record) return false;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
  return true;
}

export async function readSavingsLedger(path = statsPath()): Promise<SavingsLedger> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return { totals: emptySavingsTotals(), operationIds: new Set() };
  }

  const totals = emptySavingsTotals();
  const operationIds = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!isSavingsRecord(parsed) || operationIds.has(parsed.operationId)) continue;
    operationIds.add(parsed.operationId);
    addSavingsTotals(totals, parsed.savings);
  }
  return { totals, operationIds };
}

export async function persistSavingsBestEffort(envelope: OpEnvelope, logger?: Logger): Promise<void> {
  try {
    await appendSavingsRecord(envelope);
  } catch {
    // Statistics must never turn a successful DCP operation into a failed one.
    logger?.diagnostic({ reason: "append_best_effort", counts: { statistics: 1 } });
  }
}

export async function persistMissingSavingsBestEffort(envelopes: readonly OpEnvelope[], logger?: Logger): Promise<void> {
  try {
    const ledger = await readSavingsLedger();
    for (const envelope of envelopes) {
      const record = savingsRecordFromEnvelope(envelope);
      if (!record || ledger.operationIds.has(record.operationId)) continue;
      await appendSavingsRecord(envelope);
      ledger.operationIds.add(record.operationId);
    }
  } catch {
    // Startup repair is deliberately best effort; the session remains usable
    // even when the global statistics file is read-only or malformed.
    logger?.diagnostic({ reason: "append_best_effort", counts: { statistics: 1 } });
  }
}

function isSavingsRecord(value: unknown): value is SavingsRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.schema !== 1 || typeof record.operationId !== "string" || !record.operationId || typeof record.sessionId !== "string" || !record.sessionId || typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt) || !record.savings || typeof record.savings !== "object" || Array.isArray(record.savings)) return false;
  for (const [source, bucket] of Object.entries(record.savings)) {
    if (!(SAVINGS_SOURCES as readonly string[]).includes(source) || !bucket || typeof bucket !== "object" || Array.isArray(bucket)) return false;
    const value = bucket as Record<string, unknown>;
    if (typeof value.events !== "number" || !Number.isFinite(value.events) || value.events < 0 || typeof value.tokens !== "number" || !Number.isFinite(value.tokens) || value.tokens < 0) return false;
  }
  return true;
}

function finiteNonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
