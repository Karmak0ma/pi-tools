import type { ExtensionCommandContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CanonicalIndex } from "../identity/types.ts";
import type { DcpRuntime } from "../runtime.ts";
import { projectSessionManager } from "../identity/project.ts";
import { buildProtocolUnits } from "../identity/protocol.ts";
import { collectToolRecords, latestUserUnitIndex } from "../strategies/deduplicate.ts";
import { isProtectedTool } from "../compression/protected.ts";
import { createEnvelope, OPERATION_CUSTOM_TYPE, type PrunedToolDecision } from "../state/operations.ts";
import { outgoingPrune, reduceEnvelope } from "../state/reducer.ts";
import { hashJson } from "../util/hash.ts";
import { persistSavingsBestEffort } from "../stats.ts";
import { clearBaselines } from "../runtime.ts";
/**
 * /dcp sweep is an explicit user action, so the outputs it names apply to the next
 * request at once. Applying them now can drop the signed thinking of the current
 * turn and miss the prompt cache, which is the cost the user accepts by running it.
 * Automatic claims wait for the next compression instead (state/reducer.ts). A
 * sweep also switches on an automatic claim that is still waiting. It covers only
 * outputs (never inputs), and only the current turn, which automatic strategies
 * leave alone (strategies/settle.ts).
 */
export async function sweepCommand(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI, runtime: DcpRuntime): Promise<void> { const raw = args.trim(); if (raw && (!/^\d+$/.test(raw) || Number(raw) < 1)) { ctx.ui.notify("Usage: /dcp sweep [positive integer]", "error"); return; } const limit = raw ? Number(raw) : undefined; await runtime.mutex.runExclusive(async () => { const projection = projectSessionManager(ctx.sessionManager); if (!projection.ok) return; const index = buildProtocolUnits(projection.messages); if (!("units" in index)) return; const latestUser = latestUserUnitIndex(index); const records = collectToolRecords(index).filter((record) => record.unitIndex > latestUser && record.result && !record.result.isError && !isProtectedTool(record.name, record.args, { cwd: ctx.cwd, protectedTools: runtime.config.commands.protectedTools, protectedFilePatterns: runtime.config.protectedFilePatterns })); const selected = (limit === undefined ? records : records.slice(-limit)); // An output that an earlier decision already recorded, but that still waits for a compression, is switched on here. Its tokens were counted when it was decided, so this decision adds none (see reducer.ts).
const decisions: PrunedToolDecision[] = selected.filter((record) => !outgoingPrune(runtime.reduced, record.toolCallId)?.output).map((record) => ({ toolCallId: record.toolCallId, kind: "sweep-output", estimatedTokens: runtime.reduced.toolPrunes.get(record.toolCallId)?.output ? 0 : Math.max(1, Math.ceil(JSON.stringify(record.result?.content || []).length / 4)) })); if (!decisions.length) { ctx.ui.notify("pi-dcp sweep found no eligible completed tools.", "info"); return; } const envelope = createEnvelope({ type: "tools.pruned", decisions: decisions }, runtime.sessionId, "0.2.0", hashJson([runtime.sessionId, "sweep", decisions])); pi.appendEntry(OPERATION_CUSTOM_TYPE, envelope); await persistSavingsBestEffort(envelope, runtime.logger); runtime.reduced = reduceEnvelope(runtime.reduced, envelope); runtime.generation++; clearBaselines(runtime); ctx.ui.notify(`pi-dcp swept ${decisions.length} tool output(s).`, "info"); }); }
