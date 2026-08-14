import { canonicalPlainObject, isPlainObject } from "../util/canonical-json.ts";
import type { CanonicalIndex } from "../identity/types.ts";
import type { PrunedToolDecision } from "../state/operations.ts";
import { collectToolRecords } from "./deduplicate.ts";
import { isProtectedTool, type ProtectionOptions } from "../compression/protected.ts";

export interface ErrorPruneOptions extends ProtectionOptions { turns: number; }
export function purgeOldErrors(index: CanonicalIndex, options: ErrorPruneOptions): PrunedToolDecision[] { const records = collectToolRecords(index); const userTurns = index.units.map((unit, index) => ({ index, isUser: unit.role === "user" })).filter((entry) => entry.isUser); const decisions: PrunedToolDecision[] = []; for (const record of records) { if (!record.result?.isError || isProtectedTool(record.name, record.args, options)) continue; const age = userTurns.filter((turn) => turn.index > record.unitIndex).length; if (age >= options.turns && isPlainObject(record.args)) decisions.push({ toolCallId: record.toolCallId, kind: "old-error-input", estimatedTokens: Math.max(1, Math.ceil(JSON.stringify(record.args).length / 4)) }); } return decisions; }
export function redactOldErrorArguments(args: unknown): unknown { if (!isPlainObject(args)) return args; const result = Object.create(Object.getPrototypeOf(args)) as Record<string, unknown>; for (const [key, value] of Object.entries(args)) result[key] = typeof value === "string" ? "[Old tool input cleared by pi-dcp]" : value; return result; }
