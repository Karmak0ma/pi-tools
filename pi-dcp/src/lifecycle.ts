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
import { evaluateNudge } from "./transform/metadata.ts";
import { buildStatusMessage } from "./prompts/status.ts";
import { stripEchoedLabels } from "./transform/echo.ts";
import { relocateCacheBreakpoint } from "./transform/cache-breakpoint.ts";
import { evaluateSettledStrategies } from "./strategies/settle.ts";
import { createEnvelope, isOperationEnvelope, OPERATION_CUSTOM_TYPE, type OpEnvelope } from "./state/operations.ts";
import { reduceEnvelope, markAvailability, type ReducedState } from "./state/reducer.ts";
import { clearBaselines, disableRuntime, invalidateSnapshot, publishBaseline, runtimeSessionIdentity, setDcpToolActive, type DcpRuntime } from "./runtime.ts";
import { modelKey } from "./identity/snapshot.ts";
import { buildSystemGuidance } from "./prompts/defaults.ts";
import { persistMissingSavingsBestEffort, persistSavingsBestEffort } from "./stats.ts";
import { bindCompressionProvenance } from "./compression/tool.ts";
import { stripLeakedLabelTags } from "./ui/strip-labels.ts";

export const VERSION = "0.2.0";

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
  pi.on("turn_start", (_event, ctx) => {
    runtime.turnCount++;
    if (lastAssistantContainsCompress(ctx)) runtime.pendingNudge = undefined;
  });
  pi.on("before_agent_start", async (event, ctx) => beforeAgentStart(event, ctx, runtime));
  pi.on("context", async (event: ContextEvent, ctx) => transformContext(event, ctx, runtime));
  // The status suffix would otherwise carry the provider's rolling prompt-cache
  // breakpoint, which no later request can ever read back.
  pi.on("before_provider_request", (event) => relocateCacheBreakpoint(event.payload));
  // Strip label tags the model wrote into its own reply, before that reply is
  // persisted and becomes context. An echoed tag is indistinguishable from a
  // real label on the next request and is usually wrong (see transform/echo.ts),
  // so leaving it in place can steer a later compress range onto the wrong
  // units. Returning undefined leaves the finalized message untouched.
  pi.on("message_end", (event) => {
    const cleaned = stripEchoedLabels(event.message);
    return cleaned ? { message: cleaned } : undefined;
  });
  // Capture the host's direct tool-call event because Pi 0.84.1 may invoke it
  // before the producing assistant entry becomes visible in SessionManager.
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "compress") await bindCompressionProvenance(event.toolCallId, ctx, runtime);
  });
  pi.on("agent_settled", async (_event: AgentSettledEvent, ctx) => { await onSettled(ctx, runtime, pi); });
  // Display-only safety net: strips any pi-dcp label tag the model imitated
  // into its own reply (see src/ui/strip-labels.ts). Feature-detected because
  // registerMarkdownTransformer is not part of checkFactoryCapabilities' hard
  // requirements - its absence must never disable the rest of the extension.
  if (typeof pi.registerMarkdownTransformer === "function") {
    pi.registerMarkdownTransformer((markdown) => stripLeakedLabelTags(markdown));
  }
}

async function onSessionStart(event: SessionStartEvent, ctx: ExtensionContext, runtime: DcpRuntime, pi: ExtensionAPI): Promise<void> {
  const capability = checkContextCapabilities(ctx);
  if (!capability.ok) {
    disableRuntime(runtime, "capability_missing");
    try { setDcpToolActive(pi, false); } catch { /* capability failure can include active-tool APIs */ }
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
    if ("units" in initialIndex) runtime.reduced = reconcileAvailability(runtime.reduced, initialIndex, initialProjection.unprojectedEntryIds);
  }
  runtime.generation++;
  clearBaselines(runtime);
  runtime.lastSettledSuffixHash = undefined;
  runtime.lastNudgeTurn = undefined;
  runtime.lastNudgeEvaluation = undefined;
  runtime.pendingManual = undefined;
  runtime.pendingNudge = undefined;
  runtime.mutationBlocked = false;
  runtime.valid = !runtime.reduced.corruptReason && runtime.config.enabled && !runtime.warnedReasonCodes.has("tool_collision");
  runtime.lastReadiness = runtime.valid
    ? { ready: false, reason: "state_invalidated", generation: runtime.generation }
    : { ready: false, reason: "extension_disabled", generation: runtime.generation };
  // Registering the tool (index.ts) is necessary but not sufficient: the host
  // only auto-activates a genuinely new tool name on its registry rebuild, so
  // a name that was ever deactivated (e.g. a prior `deny`/invalid session)
  // stays inactive across `/reload` unless explicitly re-added here.
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
    runtime.reduced = "units" in index ? reconcileAvailability(rebuilt.state, index, projection.ok ? projection.unprojectedEntryIds : undefined) : rebuilt.state;
    runtime.index = "units" in index ? index : undefined;
    clearBaselines(runtime);
    runtime.lastSettledSuffixHash = undefined;
    runtime.lastNudgeTurn = undefined;
    runtime.lastNudgeEvaluation = undefined;
    runtime.generation++;
    runtime.mutationBlocked = false;
    if (runtime.reduced.corruptReason) {
      runtime.valid = false;
      runtime.lastReadiness = { ready: false, reason: "state_invalidated", generation: runtime.generation };
      setDcpToolActive(pi, false);
    }
  });
}

async function beforeAgentStart(event: BeforeAgentStartEvent, _ctx: ExtensionContext, runtime: DcpRuntime): Promise<{ systemPrompt: string }> {
  // The guidance carries the compression selection rules, including the
  // turn-relative ones, so no per-request message has to restate them. It is
  // built from config rather than being a constant, but config is fixed for a
  // session, so the system prefix stays byte-stable and cacheable.
  //
  // Nudges are operation-backed for replay/audit; their model-visible delivery
  // stays transient and happens in the status suffix of context, because a
  // per-request byte in the system channel would invalidate the whole
  // conversation cache (see prompts/status.ts).
  return { systemPrompt: `${event.systemPrompt}\n\n${buildSystemGuidance(runtime.config)}` };
}

async function transformContext(event: ContextEvent, ctx: ExtensionContext, runtime: DcpRuntime): Promise<{ messages: AgentMessage[] }> {
  const fallback = deepClone(event.messages);
  if (!runtime.valid) {
    const status = buildStatusMessage(runtime);
    return { messages: status ? [...fallback, status] : fallback };
  }
  if (runtime.mutationBlocked) {
    runtime.lastReadiness = { ready: false, reason: "state_invalidated", generation: runtime.generation };
    const status = buildStatusMessage(runtime);
    return { messages: status ? [...fallback, status] : fallback };
  }
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
      runtime.lastModel = modelKey(ctx.model, ctx.getContextUsage()?.contextWindow || 0);
      runtime.lastReadiness = { ready: true, adapterId: ctx.model?.api || "unknown", generation: runtime.generation };
      // Announce recovery as well. Without it a user who saw the failure notice
      // has no way to know the extension started working again.
      if (runtime.fallbackReason) {
        runtime.pendingFallbackNotice = `pi-dcp: context compression resumed (was disabled: ${runtime.fallbackReason}).`;
        runtime.fallbackReason = undefined;
      }
    } else {
      // A failed publication must not leave an unrelated authorization slot.
      clearBaselines(runtime);
      runtime.lastReadiness = { ready: false, reason: result.reason || "unknown", generation: runtime.generation };
      runtime.logger.diagnostic({ reason: result.reason || "unknown", confidence: result.confidence } as any);
      const reason = result.reason || "unknown";
      // Re-announce whenever the reason changes, not once per process. The
      // 2026-08-18 incident stayed invisible because the single toast had
      // already been consumed by an unrelated reason earlier in the run.
      if (runtime.fallbackReason !== reason) {
        runtime.fallbackReason = reason;
        runtime.pendingFallbackNotice = `pi-dcp: context compression disabled: ${reason}. Every request is now sent uncompressed. Restarting the session usually clears this.`;
        if (!runtime.warnedReasonCodes.has(reason)) {
          runtime.warnedReasonCodes.add(reason);
          ctx.ui?.notify?.(`pi-dcp: context transform disabled: ${reason}`);
        }
      }
    }
    runtime.lastTransform = {
      changed: result.changed,
      estimatedTokens: result.estimatedTokens ?? result.messages.length,
      savingsTokens: result.savingsTokens,
      changedPrefix: result.changedPrefix,
      confidence: result.confidence,
      reason: result.reason,
    };
    const status = buildStatusMessage(runtime);
    return { messages: status ? [...result.messages, status] : result.messages };
  });
}

function reconcileAvailability(state: ReducedState, index: { units: { entryIds: string[]; role: string; compressible: boolean }[] }, unprojectedEntryIds: ReadonlySet<string> = new Set()): ReducedState {
  const available = new Set(index.units.flatMap((unit) => unit.entryIds));
  const anchors = new Map<string, { beforeEntryId?: string; afterEntryId?: string }>();
  for (const block of state.blocks.values()) {
    const indexes = index.units.map((unit, position) => block.coverage.effectiveEntryIds.some((id) => unit.entryIds.includes(id)) ? position : -1).filter((position) => position >= 0);
    if (indexes.length) anchors.set(block.blockId, {
      beforeEntryId: index.units[Math.min(...indexes) - 1]?.entryIds.at(-1),
      afterEntryId: index.units[Math.max(...indexes) + 1]?.entryIds[0],
    });
  }
  const next = markAvailability(state, available, anchors, unprojectedEntryIds);
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

/**
 * Write the pending fallback notice into the transcript. `agent_settled` is the
 * first safe moment: the agent is no longer streaming, so Pi appends the custom
 * message directly instead of queuing it, and no tool-call/tool-result pair can
 * be split. The entry is persisted, so the degradation is still diagnosable
 * from the session file long after the toast is gone.
 */
function flushFallbackNotice(runtime: DcpRuntime, pi: ExtensionAPI): void {
  const notice = runtime.pendingFallbackNotice;
  if (!notice) return;
  runtime.pendingFallbackNotice = undefined;
  try {
    pi.sendMessage({ customType: "pi-dcp.v2.notification", content: notice, display: true }, { triggerTurn: false });
  } catch { /* a warning must never break the turn it is warning about */ }
}

function lastAssistantContainsCompress(ctx: ExtensionContext | undefined): boolean {
  if (!ctx) return false;
  const last = [...ctx.sessionManager.getBranch()].reverse().find((entry) => entry.type === "message" && entry.message.role === "assistant");
  if (!last || last.type !== "message" || last.message.role !== "assistant") return false;
  return last.message.content.some((part) => part.type === "toolCall" && part.name === "compress");
}

async function onSettled(ctx: ExtensionContext, runtime: DcpRuntime, pi: ExtensionAPI): Promise<void> {
  flushFallbackNotice(runtime, pi);
  if (!runtime.valid) return;
  await runtime.mutex.runExclusive(async () => {
    try {
      const rebuilt = reconstructFromBranch(ctx.sessionManager.getBranch());
      if (rebuilt.state.corruptReason) { runtime.valid = false; return; }
      const projection = projectContextEntries(ctx.sessionManager.buildContextEntries());
      if (!projection.ok) return;
      const index = buildProtocolUnits(projection.messages);
      if (!("units" in index)) return;
      runtime.reduced = reconcileAvailability(rebuilt.state, index, projection.unprojectedEntryIds);

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
      if (evaluation.decision && runtime.lastReadiness?.ready) {
        const branchAnchor = ctx.sessionManager.getLeafId();
        const nudgeKey = hashJson([branchAnchor, evaluation.decision.type, runtime.generation]);
        if (!runtime.reduced.nudges.has(nudgeKey)) {
          const envelope = createEnvelope({ type: "nudge.requested", nudgeKey, band: evaluation.decision.type, branchAnchor, configGeneration: runtime.generation }, runtime.sessionId, VERSION, hashJson(["nudge", nudgeKey]));
          pi.appendEntry(OPERATION_CUSTOM_TYPE, envelope);
          runtime.reduced = reduceEnvelope(runtime.reduced, envelope);
          runtime.pendingNudge = { band: evaluation.decision.type, nudgeKey };
          runtime.lastNudgeTurn = runtime.turnCount;
          await persistSavingsBestEffort(envelope, runtime.logger);
        }
      }
    } catch {
      // Fail closed: the next request remains raw and no stale baseline is used.
    }
  });
}
