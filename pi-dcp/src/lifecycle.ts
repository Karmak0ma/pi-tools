import type { ExtensionAPI, ExtensionContext, ContextEvent, BeforeAgentStartEvent, SessionStartEvent, SessionBeforeCompactEvent, AgentSettledEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { checkContextCapabilities } from "./capabilities.ts";
import { loadConfig } from "./config/load.ts";
import { reconstructFromBranch } from "./state/reconstruct.ts";
import { projectContextEntries } from "./identity/project.ts";
import { buildProtocolUnits } from "./identity/protocol.ts";
import { hashJson } from "./util/hash.ts";
import { deepClone } from "./util/clone.ts";
import { transformOutgoingContext } from "./transform/pipeline.ts";
import { evaluateNudge, stableNudgeText } from "./transform/metadata.ts";
import { evaluateSettledStrategies } from "./strategies/settle.ts";
import { createEnvelope, isOperationEnvelope, OPERATION_CUSTOM_TYPE, type OpEnvelope } from "./state/operations.ts";
import { reduceEnvelope, markAvailability, type ReducedState } from "./state/reducer.ts";
import { clearBaselines, disableRuntime, invalidateSnapshot, publishBaseline, runtimeSessionIdentity, setDcpToolActive, type DcpRuntime } from "./runtime.ts";
import { SYSTEM_GUIDANCE } from "./prompts/defaults.ts";
import { persistMissingSavingsBestEffort, persistSavingsBestEffort } from "./stats.ts";
import { bindCompressionProvenance } from "./compression/tool.ts";

const VERSION = "0.2.0";

export function registerLifecycle(pi: ExtensionAPI, runtime: DcpRuntime): void {
  runtime.pi = pi;
  pi.on("session_start", async (event, ctx) => { await onSessionStart(event, ctx, runtime, pi); });
  pi.on("session_before_tree", () => { runtime.mutationBlocked = true; invalidateSnapshot(runtime); });
  pi.on("session_before_fork", () => { runtime.mutationBlocked = true; invalidateSnapshot(runtime); });
  pi.on("session_before_switch", () => { runtime.mutationBlocked = true; invalidateSnapshot(runtime); });
  pi.on("session_tree", async (_event, ctx) => { await rebase(ctx, runtime, pi); });
  pi.on("session_compact", async (_event, ctx) => { await rebase(ctx, runtime, pi); });
  pi.on("session_before_compact", (_event: SessionBeforeCompactEvent) => { invalidateSnapshot(runtime); return undefined; });
  pi.on("session_shutdown", () => { runtime.valid = false; clearBaselines(runtime); runtime.pendingManual = undefined; runtime.mutationBlocked = true; });
  pi.on("model_select", () => { invalidateSnapshot(runtime); });
  // Ordinary turns append a new baseline leaf; they do not invalidate the
  // retained baseline for a tool call already in flight.
  pi.on("turn_start", () => { runtime.turnCount++; runtime.nudgeInFlightKey = undefined; });
  pi.on("before_agent_start", async (event, ctx) => beforeAgentStart(event, ctx, runtime));
  pi.on("context", async (event: ContextEvent, ctx) => transformContext(event, ctx, runtime));
  // Capture the host's direct tool-call event because Pi 0.84.1 may invoke it
  // before the producing assistant entry becomes visible in SessionManager.
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "compress") await bindCompressionProvenance(event.toolCallId, ctx, runtime);
  });
  pi.on("agent_settled", async (_event: AgentSettledEvent, ctx) => { await onSettled(ctx, runtime, pi); });
}

async function onSessionStart(event: SessionStartEvent, ctx: ExtensionContext, runtime: DcpRuntime, pi: ExtensionAPI): Promise<void> {
  const capability = checkContextCapabilities(ctx);
  if (!capability.ok) {
    const alreadyWarned = runtime.warnedReasonCodes.has("capability_missing");
    disableRuntime(runtime, "capability_missing");
    try { setDcpToolActive(pi, false); } catch { /* capability failure can include active-tool APIs */ }
    if (!alreadyWarned) runtime.logger.diagnostic({ reason: "capability_missing", counts: { missing: capability.missing.length } });
    return;
  }
  const loaded = await loadConfig(ctx.cwd, ctx.isProjectTrusted());
  runtime.config = loaded.config;
  runtime.configPaths = loaded.paths;
  runtime.sessionId = ctx.sessionManager.getSessionId();
  runtime.sessionFile = ctx.sessionManager.getSessionFile();
  runtime.branchLeafId = ctx.sessionManager.getLeafId();
  const rebuilt = reconstructFromBranch(ctx.sessionManager.getBranch());
  runtime.reduced = rebuilt.state;
  await persistBranchSavings(ctx.sessionManager.getBranch(), runtime);
  if (rebuilt.legacyIgnored) runtime.logger.diagnostic({ reason: "legacy_state_ignored", counts: { entries: rebuilt.legacyOperationEntries } });
  if (rebuilt.operationEntries === 0) runtime.reduced.manualMode = loaded.config.manualMode.enabled;
  const initialProjection = projectContextEntries(ctx.sessionManager.buildContextEntries());
  if (initialProjection.ok) {
    const initialIndex = buildProtocolUnits(initialProjection.messages);
    if ("units" in initialIndex) runtime.reduced = reconcileAvailability(runtime.reduced, initialIndex);
  }
  runtime.generation++;
  clearBaselines(runtime);
  runtime.lastSettledSuffixHash = undefined;
  runtime.lastNudgeTurn = undefined;
  runtime.lastNudgeEvaluation = undefined;
  runtime.pendingManual = undefined;
  runtime.nudgeInFlightKey = undefined;
  runtime.mutationBlocked = false;
  runtime.valid = !runtime.reduced.corruptReason && runtime.config.enabled && !runtime.warnedReasonCodes.has("tool_collision");
  if (runtime.valid) setDcpToolActive(pi, runtime.config.compress.permission !== "deny");
  else setDcpToolActive(pi, false);
  if (loaded.error) runtime.logger.diagnostic({ reason: "config_layer_invalid" });
  void event;
}

async function rebase(ctx: ExtensionContext, runtime: DcpRuntime, pi: ExtensionAPI): Promise<void> {
  if (!runtime.valid) return;
  await runtime.mutex.runExclusive(() => {
    const identity = runtimeSessionIdentity(ctx);
    runtime.sessionId = identity.sessionId;
    runtime.sessionFile = identity.sessionFile;
    runtime.branchLeafId = identity.leafId;
    const rebuilt = reconstructFromBranch(ctx.sessionManager.getBranch());
    const projection = projectContextEntries(ctx.sessionManager.buildContextEntries());
    const index = projection.ok ? buildProtocolUnits(projection.messages) : { ok: false as const, reason: "projection_unsupported" as const };
    runtime.reduced = "units" in index ? reconcileAvailability(rebuilt.state, index) : rebuilt.state;
    runtime.index = "units" in index ? index : undefined;
    clearBaselines(runtime);
    runtime.lastSettledSuffixHash = undefined;
    runtime.lastNudgeTurn = undefined;
    runtime.lastNudgeEvaluation = undefined;
    runtime.generation++;
    runtime.mutationBlocked = false;
    if (runtime.reduced.corruptReason) { runtime.valid = false; setDcpToolActive(pi, false); }
  });
}

async function beforeAgentStart(event: BeforeAgentStartEvent, ctx: ExtensionContext, runtime: DcpRuntime): Promise<{ systemPrompt: string; message?: { customType: string; content: string; display: boolean; details?: unknown } }> {
  const result: { systemPrompt: string; message?: { customType: string; content: string; display: boolean; details?: unknown } } = {
    systemPrompt: `${event.systemPrompt}\n\n${SYSTEM_GUIDANCE}`,
  };
  if (!runtime.valid) return result;

  const branch = ctx.sessionManager.getBranch();
  const alreadyPersisted = new Set(branch.flatMap((entry) => {
    if (entry.type !== "custom_message" || entry.customType !== "pi-dcp.v2.nudge") return [];
    const details = entry.details;
    return details && typeof details === "object" && typeof (details as { nudgeKey?: unknown }).nudgeKey === "string" ? [(details as { nudgeKey: string }).nudgeKey] : [];
  }));
  const pending = [...runtime.reduced.nudges.values()]
    .sort((a, b) => a.requestedByOpId.localeCompare(b.requestedByOpId))
    .find((nudge) => nudge.configGeneration === runtime.generation && !alreadyPersisted.has(nudge.nudgeKey) && runtime.nudgeInFlightKey !== nudge.nudgeKey);
  if (!pending) return result;
  runtime.nudgeInFlightKey = pending.nudgeKey;
  runtime.lastNudgeTurn = runtime.turnCount;
  return {
    ...result,
    message: {
      customType: "pi-dcp.v2.nudge",
      content: stableNudgeText(pending.band),
      display: false,
      details: { nudgeKey: pending.nudgeKey, band: pending.band, configGeneration: pending.configGeneration },
    },
  };
}

async function transformContext(event: ContextEvent, ctx: ExtensionContext, runtime: DcpRuntime): Promise<{ messages: AgentMessage[] }> {
  const fallback = deepClone(event.messages);
  if (!runtime.valid || runtime.mutationBlocked) return { messages: fallback };
  return runtime.mutex.runExclusive(() => {
    const result = transformOutgoingContext(event.messages, {
      ctx,
      sessionId: runtime.sessionId,
      generation: runtime.generation,
      state: runtime.reduced,
      config: runtime.config,
      turnCount: runtime.turnCount,
      branchIdentity: runtime.sessionId,
    });
    if (result.snapshot) {
      const baseline = publishBaseline(runtime, result.snapshot);
      runtime.index = baseline.index || result.index;
      runtime.reduced = result.state;
      runtime.branchLeafId = ctx.sessionManager.getLeafId();
    } else {
      // A failed publication must not leave an unrelated authorization slot.
      clearBaselines(runtime);
    }
    runtime.lastTransform = {
      changed: result.changed,
      estimatedTokens: result.estimatedTokens ?? result.messages.length,
      savingsTokens: result.savingsTokens,
      changedPrefix: result.changedPrefix,
      confidence: result.confidence,
      reason: result.reason,
    };
    return { messages: result.messages };
  });
}

function reconcileAvailability(state: ReducedState, index: { units: { entryIds: string[]; role: string; compressible: boolean }[] }): ReducedState {
  const available = new Set(index.units.flatMap((unit) => unit.entryIds));
  const anchors = new Set<string>();
  for (const block of state.blocks.values()) {
    const indexes = index.units.map((unit, position) => block.coverage.effectiveEntryIds.some((id) => unit.entryIds.includes(id)) ? position : -1).filter((position) => position >= 0);
    if (indexes.length) anchors.add(`${index.units[Math.min(...indexes) - 1]?.entryIds.at(-1) || ""}|${index.units[Math.max(...indexes) + 1]?.entryIds[0] || ""}`);
  }
  const next = markAvailability(state, available, anchors);
  const latestUser = Math.max(-1, ...index.units.map((unit, position) => unit.role === "user" ? position : -1));
  for (const block of next.blocks.values()) {
    const indexes = index.units.map((unit, position) => block.coverage.effectiveEntryIds.some((id) => unit.entryIds.includes(id)) ? position : -1).filter((position) => position >= 0);
    if (indexes.some((position) => position === latestUser || !index.units[position].compressible)) { block.available = false; block.active = false; }
  }
  return next;
}

async function persistBranchSavings(entries: readonly SessionEntry[], runtime: DcpRuntime): Promise<void> {
  const envelopes: OpEnvelope[] = [];
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== OPERATION_CUSTOM_TYPE) continue;
    if (isOperationEnvelope(entry.data)) envelopes.push(entry.data);
  }
  await persistMissingSavingsBestEffort(envelopes, runtime.logger);
}

async function onSettled(ctx: ExtensionContext, runtime: DcpRuntime, pi: ExtensionAPI): Promise<void> {
  if (!runtime.valid) return;
  await runtime.mutex.runExclusive(async () => {
    try {
      const rebuilt = reconstructFromBranch(ctx.sessionManager.getBranch());
      if (rebuilt.state.corruptReason) { runtime.valid = false; return; }
      const projection = projectContextEntries(ctx.sessionManager.buildContextEntries());
      if (!projection.ok) return;
      const index = buildProtocolUnits(projection.messages);
      if (!("units" in index)) return;
      runtime.reduced = reconcileAvailability(rebuilt.state, index);

      // Automatic strategies are explicitly gated here. Manual mode no longer
      // makes evaluateSettledStrategies silently discard the configured flag.
      //
      // This mutation must run before nudge creation. A persisted pruning
      // operation increments `runtime.generation` and invalidates baselines;
      // creating the nudge first would leave it tagged with the old generation,
      // and beforeAgentStart would correctly—but incorrectly for this case—
      // reject it as stale instead of delivering it on the next request.
      const strategiesAllowed = !(runtime.reduced.manualMode && !runtime.config.manualMode.automaticStrategies);
      const suffixHash = hashJson(index.entries.slice(-64).map((entry) => entry.fingerprint));
      if (strategiesAllowed && suffixHash !== runtime.lastSettledSuffixHash) {
        const decisions = evaluateSettledStrategies(index, runtime.reduced, {
          cwd: ctx.cwd,
          protectedTools: [...runtime.config.strategies.deduplication.protectedTools, ...runtime.config.strategies.purgeErrors.protectedTools],
          protectedFilePatterns: runtime.config.protectedFilePatterns,
          turnProtection: runtime.config.turnProtection,
          deduplication: runtime.config.strategies.deduplication.enabled,
          purgeErrors: runtime.config.strategies.purgeErrors.enabled,
          purgeTurns: runtime.config.strategies.purgeErrors.turns,
          automaticStrategiesAllowed: !runtime.reduced.manualMode || runtime.config.manualMode.automaticStrategies,
        });
        if (decisions.length) {
          const envelope = createEnvelope({ type: "tools.pruned", decisions }, runtime.sessionId, VERSION, hashJson([runtime.sessionId, "settled", suffixHash, decisions]));
          pi.appendEntry(OPERATION_CUSTOM_TYPE, envelope);
          await persistSavingsBestEffort(envelope, runtime.logger);
          runtime.reduced = reduceEnvelope(runtime.reduced, envelope);
          if (runtime.reduced.corruptReason) { runtime.valid = false; return; }
          runtime.generation++;
          clearBaselines(runtime);
        }
        runtime.lastSettledSuffixHash = suffixHash;
      }

      // Evaluate and persist the nudge only after any generation-changing
      // settled work has completed. This keeps configGeneration equal to the
      // generation that beforeAgentStart will use for delivery.
      const usage = ctx.getContextUsage();
      const evaluation = evaluateNudge(usage?.tokens, runtime.config, usage?.contextWindow || ctx.model?.contextWindow || 0, runtime.lastNudgeTurn === undefined ? Number.POSITIVE_INFINITY : runtime.turnCount - runtime.lastNudgeTurn, runtime.lastNudgeTurn === runtime.turnCount, ctx.model?.id);
      runtime.lastNudgeEvaluation = evaluation;
      if (evaluation.decision) {
        const branchAnchor = ctx.sessionManager.getLeafId();
        const nudgeKey = hashJson([branchAnchor, evaluation.decision.type, runtime.generation]);
        if (!runtime.reduced.nudges.has(nudgeKey)) {
          const envelope = createEnvelope({ type: "nudge.requested", nudgeKey, band: evaluation.decision.type, branchAnchor, configGeneration: runtime.generation }, runtime.sessionId, VERSION, hashJson(["nudge", nudgeKey]));
          pi.appendEntry(OPERATION_CUSTOM_TYPE, envelope);
          runtime.reduced = reduceEnvelope(runtime.reduced, envelope);
          runtime.lastNudgeTurn = runtime.turnCount;
          await persistSavingsBestEffort(envelope, runtime.logger);
        }
      }
    } catch {
      // Fail closed: the next request remains raw and no stale baseline is used.
    }
  });
}
