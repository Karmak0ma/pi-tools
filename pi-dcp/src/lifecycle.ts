import type { ExtensionAPI, ExtensionContext, ContextEvent, BeforeAgentStartEvent, SessionStartEvent, SessionBeforeCompactEvent, AgentSettledEvent } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { checkContextCapabilities } from "./capabilities.ts";
import { loadConfig } from "./config/load.ts";
import { reconstructFromBranch } from "./state/reconstruct.ts";
import { projectContextEntries } from "./identity/project.ts";
import { buildProtocolUnits } from "./identity/protocol.ts";
import { hashJson } from "./util/hash.ts";
import { deepClone } from "./util/clone.ts";
import { transformOutgoingContext } from "./transform/pipeline.ts";
import { evaluateSettledStrategies } from "./strategies/settle.ts";
import { createEnvelope } from "./state/operations.ts";
import { reduceEnvelope, markAvailability, type ReducedState } from "./state/reducer.ts";
import { invalidateSnapshot, disableRuntime, runtimeSessionIdentity, setDcpToolActive, type DcpRuntime } from "./runtime.ts";
import { SYSTEM_GUIDANCE } from "./prompts/defaults.ts";
import { registerCompressionTool } from "./compression/tool.ts";

const VERSION = "0.1.0";
export function registerLifecycle(pi: ExtensionAPI, runtime: DcpRuntime): void {
  runtime.pi = pi;
  registerCompressionTool(pi, runtime);
  pi.on("session_start", async (event, ctx) => { await onSessionStart(event, ctx, runtime, pi); });
  pi.on("session_before_tree", (_event, _ctx) => { runtime.mutationBlocked = true; invalidateSnapshot(runtime); });
  pi.on("session_before_fork", (_event, _ctx) => { runtime.mutationBlocked = true; invalidateSnapshot(runtime); });
  pi.on("session_before_switch", (_event, _ctx) => { runtime.mutationBlocked = true; invalidateSnapshot(runtime); });
  pi.on("session_tree", async (_event, ctx) => { await rebase(ctx, runtime, pi); });
  pi.on("session_compact", async (_event, ctx) => { await rebase(ctx, runtime, pi); });
  pi.on("session_before_compact", (_event: SessionBeforeCompactEvent, _ctx) => { invalidateSnapshot(runtime); return undefined; });
  pi.on("session_shutdown", (_event, _ctx) => { runtime.valid = false; runtime.snapshot = undefined; runtime.pendingManual = undefined; runtime.mutationBlocked = true; });
  pi.on("model_select", (_event, _ctx) => { invalidateSnapshot(runtime); });
  pi.on("turn_start", (_event, _ctx) => { runtime.turnCount++; runtime.snapshot = undefined; });
  pi.on("before_agent_start", (event, _ctx) => beforeAgentStart(event, runtime));
  pi.on("context", async (event: ContextEvent, ctx) => transformContext(event, ctx, runtime));
  pi.on("agent_settled", async (_event: AgentSettledEvent, ctx) => { await onSettled(ctx, runtime, pi); });
}
async function onSessionStart(event: SessionStartEvent, ctx: ExtensionContext, runtime: DcpRuntime, pi: ExtensionAPI): Promise<void> { const capability = checkContextCapabilities(ctx); if (!capability.ok) { const alreadyWarned = runtime.warnedReasonCodes.has("capability_missing"); disableRuntime(runtime, "capability_missing"); try { setDcpToolActive(pi, false); } catch { /* capability failure may include active-tool APIs */ } if (!alreadyWarned) runtime.logger.diagnostic({ reason: "capability_missing", counts: { missing: capability.missing.length } }); return; } const loaded = await loadConfig(ctx.cwd, ctx.isProjectTrusted()); runtime.config = loaded.config; runtime.configPaths = loaded.paths; runtime.sessionId = ctx.sessionManager.getSessionId(); runtime.sessionFile = ctx.sessionManager.getSessionFile(); runtime.branchLeafId = ctx.sessionManager.getLeafId(); const rebuilt = reconstructFromBranch(ctx.sessionManager.getBranch(), runtime.sessionId); runtime.reduced = rebuilt.state; if (rebuilt.operationEntries === 0) runtime.reduced.manualMode = loaded.config.manualMode.enabled; const initialProjection = projectContextEntries(ctx.sessionManager.buildContextEntries()); if (initialProjection.ok) { const initialIndex = buildProtocolUnits(initialProjection.messages); if ("units" in initialIndex) runtime.reduced = reconcileAvailability(runtime.reduced, initialIndex); } runtime.generation++; runtime.snapshot = undefined; runtime.lastSettledSuffixHash = undefined; runtime.lastNudgeTurn = undefined; runtime.lastNudgeEvaluation = undefined; runtime.pendingManual = undefined; runtime.manualAuthorization = undefined; runtime.mutationBlocked = false; runtime.valid = !runtime.reduced.corruptReason && runtime.config.enabled && !runtime.warnedReasonCodes.has("tool_collision"); if (runtime.warnedReasonCodes.has("tool_collision")) { /* never alter another extension's compress tool */ } else if (runtime.valid) setDcpToolActive(pi, runtime.config.compress.permission !== "deny"); else setDcpToolActive(pi, false); if (loaded.error) runtime.logger.diagnostic({ reason: "config_layer_invalid" }); void event; }
async function rebase(ctx: ExtensionContext, runtime: DcpRuntime, pi: ExtensionAPI): Promise<void> { if (!runtime.valid) return; await runtime.mutex.runExclusive(() => { const identity = runtimeSessionIdentity(ctx); runtime.sessionId = identity.sessionId; runtime.sessionFile = identity.sessionFile; runtime.branchLeafId = identity.leafId; const rebuilt = reconstructFromBranch(ctx.sessionManager.getBranch(), identity.sessionId); const projection = projectContextEntries(ctx.sessionManager.buildContextEntries()); const index = projection.ok ? buildProtocolUnits(projection.messages) : { ok: false as const, reason: "projection_unsupported" as const }; runtime.reduced = "units" in index ? reconcileAvailability(rebuilt.state, index) : rebuilt.state; runtime.index = "units" in index ? index : undefined; runtime.snapshot = undefined; runtime.lastSettledSuffixHash = undefined; runtime.lastNudgeTurn = undefined; runtime.lastNudgeEvaluation = undefined; runtime.generation++; runtime.mutationBlocked = false; if (runtime.reduced.corruptReason) { runtime.valid = false; setDcpToolActive(pi, false); } }); }
function beforeAgentStart(event: BeforeAgentStartEvent, runtime: DcpRuntime): { systemPrompt: string } { let systemPrompt = `${event.systemPrompt}\n\n${SYSTEM_GUIDANCE}`; if (runtime.pendingManual) { const focus = runtime.pendingManual.focus ? ` Focus: ${runtime.pendingManual.focus}` : ""; systemPrompt += `\n\nA user requested manual pi-dcp compression. Make one real compress tool call using the latest snapshot and author every summary.${focus}`; runtime.manualAuthorization = { nonce: runtime.pendingManual.nonce, expiresAt: Date.now() + 600000 }; runtime.pendingManual = undefined; } return { systemPrompt }; }
async function transformContext(event: ContextEvent, ctx: ExtensionContext, runtime: DcpRuntime): Promise<{ messages: AgentMessage[] }> { const fallback = deepClone(event.messages); if (!runtime.valid || runtime.mutationBlocked) return { messages: fallback }; return runtime.mutex.runExclusive(() => { const result = transformOutgoingContext(event.messages, { ctx, sessionId: runtime.sessionId, generation: runtime.generation, state: runtime.reduced, config: runtime.config, currentSnapshot: runtime.snapshot, turnCount: runtime.turnCount, lastNudgeTurn: runtime.lastNudgeTurn }); if (result.snapshot) { runtime.snapshot = result.snapshot; runtime.index = result.index; runtime.reduced = result.state; runtime.branchLeafId = ctx.sessionManager.getLeafId(); } if (result.nudge) runtime.lastNudgeEvaluation = result.nudge; if (result.nudged) runtime.lastNudgeTurn = runtime.turnCount; runtime.lastTransform = { changed: result.changed, estimatedTokens: result.estimatedTokens ?? result.messages.length, savingsTokens: result.savingsTokens, changedPrefix: result.changedPrefix, confidence: result.confidence, reason: result.reason }; return { messages: result.messages }; }); }
function reconcileAvailability(state: ReducedState, index: { units: { entryIds: string[]; role: string; compressible: boolean }[] }): ReducedState { const available = new Set(index.units.flatMap((unit) => unit.entryIds)); const anchors = new Set<string>(); for (const block of state.blocks.values()) { const indexes = index.units.map((unit, position) => block.coverage.effectiveEntryIds.some((id) => unit.entryIds.includes(id)) ? position : -1).filter((position) => position >= 0); if (indexes.length) anchors.add(`${index.units[Math.min(...indexes) - 1]?.entryIds.at(-1) || ""}|${index.units[Math.max(...indexes) + 1]?.entryIds[0] || ""}`); } const next = markAvailability(state, available, anchors); const latestUser = Math.max(-1, ...index.units.map((unit, position) => unit.role === "user" ? position : -1)); for (const block of next.blocks.values()) { const indexes = index.units.map((unit, position) => block.coverage.effectiveEntryIds.some((id) => unit.entryIds.includes(id)) ? position : -1).filter((position) => position >= 0); if (indexes.some((position) => position === latestUser || !index.units[position].compressible)) { block.available = false; block.active = false; } } return next; }
async function onSettled(ctx: ExtensionContext, runtime: DcpRuntime, pi: ExtensionAPI): Promise<void> {
  if (!runtime.valid || (runtime.reduced.manualMode && !runtime.config.manualMode.automaticStrategies)) return;
  await runtime.mutex.runExclusive(() => {
    try {
      const rebuilt = reconstructFromBranch(ctx.sessionManager.getBranch(), runtime.sessionId);
      if (rebuilt.state.corruptReason) { runtime.valid = false; return; }
      const projection = projectContextEntries(ctx.sessionManager.buildContextEntries());
      if (!projection.ok) return;
      const index = buildProtocolUnits(projection.messages);
      if (!("units" in index)) return;
      runtime.reduced = reconcileAvailability(rebuilt.state, index);
      const suffixHash = hashJson(index.entries.slice(-64).map((entry) => entry.fingerprint));
      if (suffixHash === runtime.lastSettledSuffixHash) return;
      const decisions = evaluateSettledStrategies(index, runtime.reduced, { cwd: ctx.cwd, protectedTools: [...runtime.config.strategies.deduplication.protectedTools, ...runtime.config.strategies.purgeErrors.protectedTools], protectedFilePatterns: runtime.config.protectedFilePatterns, turnProtection: runtime.config.turnProtection, deduplication: runtime.config.strategies.deduplication.enabled, purgeErrors: runtime.config.strategies.purgeErrors.enabled, purgeTurns: runtime.config.strategies.purgeErrors.turns });
      if (!decisions.length) { runtime.lastSettledSuffixHash = suffixHash; return; }
      const envelope = createEnvelope({ type: "tools.pruned", decisions }, runtime.sessionId, VERSION, hashJson([runtime.sessionId, "settled", suffixHash, decisions]));
      pi.appendEntry("pi-dcp.operation", envelope);
      runtime.reduced = reduceEnvelope(runtime.reduced, envelope);
      if (runtime.reduced.corruptReason) { runtime.valid = false; return; }
      runtime.lastSettledSuffixHash = suffixHash;
      runtime.generation++;
      runtime.snapshot = undefined;
    } catch { /* fail closed: the next request remains raw */ }
  });
}
