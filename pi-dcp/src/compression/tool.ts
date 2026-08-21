import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { CompressionParameters, isCompressionParams, normalizeCompressionParams } from "./schema.ts";
import { buildCompressionEnvelope } from "./service.ts";
import { modelKey, computeSnapshotHash } from "../identity/snapshot.ts";
import type { BaselineSnapshot } from "../identity/types.ts";
import { projectContextEntries } from "../identity/project.ts";
import { buildProtocolUnits } from "../identity/protocol.ts";
import { reduceEnvelope } from "../state/reducer.ts";
import { OPERATION_CUSTOM_TYPE } from "../state/operations.ts";
import { formatNotification, notify } from "../ui/notify.ts";
import { hashJson } from "../util/hash.ts";
import { clearBaselines, findBaselineForParent, latestBaseline, noteSuccessfulCompression, pinBaseline, unpinBaseline, type DcpRuntime } from "../runtime.ts";
import { persistSavingsBestEffort } from "../stats.ts";
import { buildErrorText } from "./errors.ts";
import { selectionRules } from "../prompts/defaults.ts";

export function registerCompressionTool(pi: ExtensionAPI, runtime: DcpRuntime): void {
  const tool: ToolDefinition<typeof CompressionParameters> = {
    name: "compress",
    label: "Compress context",
    description: `Create faithful, contiguous, model-authored summaries for older resolved context.

Selection
- Choose complete protocol units (a user turn, or an assistant tool-call message together with ALL of its tool results) whose work is finished.
- The range is inclusive: every unit between startId and endId is included.
- startId must precede endId; ranges must not overlap.
- Read labels off the message they are attached to: <pi-dcp-message-id>mNNNN</pi-dcp-message-id> for units, <pi-dcp-message-id>bNNNN</pi-dcp-message-id> for active blocks.
${selectionRules(runtime.config)}
- Never invent labels; if no labels are visible, do not call this tool.
- Do not include: active work, unresolved questions, pending tool exchanges, or details still needed for immediate edits.
- Protected tool output (configured protected tools and file patterns) does not need to be described in your summary or avoided: pi-dcp automatically appends it to the block verbatim, so it survives compression even if your prose omits it.

Summary quality
- Write an exhaustive technical summary: decisions, constraints, exact paths, findings, verification evidence.
- Preserve user intent; quote short user messages verbatim when they carry the intent.
- Keep the summary lean: no preamble, no restating the obvious.
- topic is optional display metadata; if omitted, pi-dcp uses "Compressed context".

Nested blocks
- If your range includes a block (bNNNN), you MUST reference it in the summary as (bNNNN) exactly once per block.
- (bNNNN) are reserved tokens; do not invent them and do not repeat one.
- Preflight check before calling: every block inside your range appears exactly once in your summary.
- (bNNNN) is a write-only instruction to this tool, not the stored result: pi-dcp replaces it with that block's full stored content before saving, atomically, in the same call. A tool result reporting success means this already happened - there is nothing left to fix and nothing to verify by re-reading. Never call compress again on a block just because you cannot see its expanded text; that re-wraps real content for no reason and risks failing for reasons unrelated to your actual task.

Batching
- You may pass up to 16 ranges in one call; each range gets its own summary.

Validation
- The call is authorized from the assistant response that produced the tool call; ranges are validated against the current baseline.
- Validation is the authority on what is selectable right now, so you never need a per-turn list: a rejected call changes nothing, names the reason, and lists the labels you may use instead. Fix the range from that list and retry once.`,
    promptSnippet: "compress older resolved context ranges",
    promptGuidelines: [
      "After substantial work is finished and verified, use compress proactively before beginning a different substantial work phase when a useful safe range is visible.",
      "Use compress only for older closed work and complete protocol units.",
      "Use compress only with current visible mNNNN or bNNNN labels; never invent labels.",
      "Never pass compress a BLOCKED unit or a still-live recent user turn.",
      "If no labels are visible, do not call compress.",
    ],
    parameters: CompressionParameters,
    executionMode: "sequential",
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      return executeCompression(toolCallId, params, ctx, pi, runtime);
    },
  };
  pi.registerTool(tool);
}

/**
 * Bind a compress invocation at Pi's authoritative `tool_call` boundary.
 *
 * Pi 0.84.1 documents that SessionManager is synchronized through the current
 * assistant message before `tool_call`, but its agent hook can run before the
 * asynchronous message event has persisted that entry. We therefore prefer a
 * persisted assistant entry when available and otherwise bind the exact host
 * tool-call ID to the baseline published immediately before this response.
 * The binding is internal, single-use, and still undergoes complete history,
 * model, generation, and configuration validation during execution.
 */
export async function bindCompressionProvenance(toolCallId: string, ctx: ExtensionContext, runtime: DcpRuntime): Promise<void> {
  await runtime.mutex.runExclusive(() => {
    if (!runtime.valid || runtime.mutationBlocked) return;
    const currentModel = modelKey(ctx.model, ctx.getContextUsage()?.contextWindow || 0);
    const current = { model: currentModel, generation: runtime.generation, configHash: hashJson(runtime.config) };
    const persisted = findAssistantToolEntry(ctx, toolCallId);
    const baseline = persisted
      ? findBaselineForParent(runtime, persisted.parentId, current)
      : findBaselineForParent(runtime, ctx.sessionManager.getLeafId(), current) || latestBaseline(runtime);
    if (baseline && baselineIdentityMatches(baseline, runtime, currentModel)) {
      runtime.compressionProvenance.set(toolCallId, baseline);
    }
  });
}

async function executeCompression(toolCallId: string, rawParams: unknown, ctx: ExtensionContext, pi: ExtensionAPI, runtime: DcpRuntime): Promise<{ content: [{ type: "text"; text: string }]; details: Record<string, unknown> }> {
  try {
    // A v1 call is rejected before any state lookup. In particular, the model
    // cannot revive a deprecated singleton snapshot by echoing snapshotId.
    if (!isCompressionParams(rawParams)) return failure("protocol_version", { stage: "v1_schema_rejected" }, runtime);
    const params = normalizeCompressionParams(rawParams);
    if (!runtime.valid || runtime.mutationBlocked) return failure("compression_unavailable", { stage: runtime.lastReadiness?.reason || (runtime.valid ? "state_invalidated" : "extension_disabled") }, runtime);
    if (runtime.config.compress.permission === "deny") return failure("permission_denied", {}, runtime);

  let ask = false;
  const first = await runtime.mutex.runExclusive(() => {
    const baseline = producingBaseline(toolCallId, ctx, runtime);
    if (!baseline) {
      if (runtime.lastReadiness && !readinessCurrent(runtime)) return { error: "compression_unavailable", stage: runtime.lastReadiness.reason || "state_invalidated" } as const;
      return { error: "baseline_unavailable", stage: "assistant_provenance_missing" } as const;
    }
    const currentModel = modelKey(ctx.model, ctx.getContextUsage()?.contextWindow || 0);
    if (!baselineIdentityMatches(baseline, runtime, currentModel)) return { error: "baseline_unavailable", stage: "baseline_identity_mismatch", baseline } as const;
    const validation = validateBaselineHistory(baseline, ctx, toolCallId, runtime, currentModel);
    if (!validation.ok) return { error: "baseline_unavailable", stage: validation.stage, baseline } as const;
    ask = runtime.config.compress.permission === "ask";
    return { baseline } as const;
  });
  if ("error" in first) return failure(first.error || "baseline_unavailable", { stage: first.stage }, runtime, first.baseline);
  pinBaseline(runtime, first.baseline);

  if (ask) {
    if (!ctx.hasUI) { unpinBaseline(runtime, first.baseline); return failure("permission_unavailable", {}, runtime); }
    let confirmed = false;
    try {
      confirmed = await ctx.ui.confirm("Allow pi-dcp compression?", "The model-selected ranges and summaries will be persisted as one pi-dcp operation. Raw history is not modified.", { timeout: 30_000 });
    } catch { confirmed = false; }
    if (!confirmed) { unpinBaseline(runtime, first.baseline); return failure("permission_denied", {}, runtime); }
  }

    return await runtime.mutex.runExclusive(async () => {
      try {
        const baseline = producingBaseline(toolCallId, ctx, runtime);
    const currentModel = modelKey(ctx.model, ctx.getContextUsage()?.contextWindow || 0);
    if (!baseline) {
      if (runtime.lastReadiness && !readinessCurrent(runtime)) return failure("compression_unavailable", { stage: runtime.lastReadiness.reason || "state_invalidated" }, runtime);
      return failure("baseline_unavailable", { stage: "assistant_provenance_missing" }, runtime);
    }
    if (!baselineIdentityMatches(baseline, runtime, currentModel)) return failure("baseline_unavailable", { stage: "baseline_identity_mismatch" }, runtime, baseline);
    const validation = validateBaselineHistory(baseline, ctx, toolCallId, runtime, currentModel);
    if (!validation.ok) return failure("baseline_unavailable", { stage: validation.stage }, runtime, baseline);

    const built = buildCompressionEnvelope({
      sessionId: runtime.sessionId,
      extensionVersion: "0.2.0",
      snapshot: baseline,
      state: runtime.reduced,
      params,
      model: ctx.model,
      toolCallId,
      maxSummaryChars: runtime.config.summary.maxChars,
      maxExpandedChars: runtime.config.summary.maxExpandedChars,
      maxNestedDepth: runtime.config.summary.maxNestedDepth,
      index: baseline.index || runtime.index,
      protection: { cwd: ctx.cwd, protectedTools: runtime.config.compress.protectedTools, protectedFilePatterns: runtime.config.protectedFilePatterns },
      turnProtection: runtime.config.turnProtection,
      protectUserMessages: runtime.config.compress.protectUserMessages,
    });
    if (!built.ok) return failure(built.reason, built, runtime, baseline);

    // Validate the envelope against the reducer *before* persisting it. This
    // is a pure, non-mutating dry run (reduceEnvelope always clones state; it
    // never touches runtime.reduced), so trying it first costs nothing when
    // it succeeds. What it buys: buildCompressionEnvelope's checks (range,
    // placeholder, size) and the reducer's own invariants (anchors, coverage,
    // nestedDepth, no-overlap) are two independently maintained pieces of
    // logic, and a future gap between them - like the nestedDepth
    // under-count fixed in nesting.ts (2026-08-19 incident) - must never
    // reach `pi.appendEntry`. Once appended, a rejected envelope is
    // permanent: reconstructFromBranch (state/reconstruct.ts) replays the
    // full persisted branch unconditionally on every resume *and* restart,
    // so a corrupt entry re-corrupts the state every single time and disables
    // compression for the rest of the session's life, contrary to the
    // fallback notice's own claim that restarting clears it. Checking first
    // turns any such mismatch into what it always should have been: a
    // normal, retryable tool-call failure that never touches history.
    const dryRun = reduceEnvelope(runtime.reduced, built.envelope);
    if (dryRun.corruptReason) return failure("state_conflict", {}, runtime, baseline);

    pi.appendEntry(OPERATION_CUSTOM_TYPE, built.envelope);
    await persistSavingsBestEffort(built.envelope, runtime.logger);
    runtime.reduced = dryRun;
    noteSuccessfulCompression(runtime);
    runtime.generation++;
    clearBaselines(runtime);
    runtime.lastReadiness = { ready: false, reason: "state_invalidated", generation: runtime.generation };
    const report = {
      action: "compressed",
      topic: params.topic,
      count: built.blocks.length,
      estimatedTokens: built.blocks.reduce((sum, block) => sum + (block.estimatedSavingsTokens || 0), 0),
      confidence: "heuristic",
    } as const;
    notify(ctx, runtime.config, report);
    // The statistics belong in the tool result, not in a separate chat message.
    // Pi can only insert an extension message mid-turn with `deliverAs:
    // "nextTurn"`, so the old chat notification always appeared one turn late
    // and looked unrelated to the call that produced it.
    const stats = formatNotification(runtime.config, report);
    return {
      content: [{ type: "text", text: `pi-dcp compressed ${built.blocks.length} range(s). Refresh context aliases.${stats ? ` ${stats}.` : ""}` }],
      details: {
        runId: built.envelope.operation.type === "compression.created" ? built.envelope.operation.runId : undefined,
        blockIds: built.blocks.map((block) => block.blockId),
        estimatedDelta: built.blocks.reduce((sum, block) => sum + block.estimatedSummaryTokens, 0),
      },
      };
    } finally {
        unpinBaseline(runtime, first.baseline);
      }
    });
  } finally {
    // A host tool-call binding authorizes one execution attempt only. A model
    // retry receives a new tool-call ID and a new authoritative binding.
    runtime.compressionProvenance.delete(toolCallId);
  }
}

/**
 * `lastReadiness.ready` can go stale-true: `onSettled` bumps `runtime.generation`
 * and clears baselines after a settled pruning mutation without touching
 * `lastReadiness` (nudge delivery in the same cycle depends on the pre-bump
 * `ready` flag, so it is deliberately left alone there). Compare generations
 * here, at the point where a missing baseline is actually reported, so a
 * stale flag cannot make a genuinely invalidated state report the unhelpful
 * `baseline_unavailable` instead of `compression_unavailable`.
 */
function readinessCurrent(runtime: DcpRuntime): boolean {
  return !!runtime.lastReadiness?.ready && runtime.lastReadiness.generation === runtime.generation;
}

function producingBaseline(toolCallId: string, ctx: ExtensionContext, runtime: DcpRuntime): BaselineSnapshot | undefined {
  const currentModel = modelKey(ctx.model, ctx.getContextUsage()?.contextWindow || 0);
  return recoverProducingBaseline(toolCallId, ctx, runtime, currentModel);
}

/**
 * Resolve the immutable request baseline from the live tool execution.
 *
 * `tool_call` is a useful early binding point, but it must not be a second,
 * hidden prerequisite for a registered tool's own `execute` callback. Pi has
 * already authorized and dispatched the exact tool-call ID by the time this
 * callback runs. Requiring an ephemeral map entry as additional proof made a
 * valid, uniquely persisted call fail whenever the lifecycle hook was missed
 * during reload/event draining—the production failure this fallback fixes.
 *
 * Recovery still cannot invent a baseline. Without an early host binding, it
 * requires exactly one persisted assistant call and selects only the retained
 * snapshot for that call's exact parent. Pi's older pre-persistence ordering
 * remains supported only when `tool_call` created the binding first. This also
 * makes duplicate persisted IDs fail closed instead of accidentally resembling
 * the pre-persistence case. `validateBaselineHistory` then recomputes the
 * canonical history hash and rejects changed descendants before append.
 * Storing the recovered value in the single-use map keeps confirmation
 * revalidation on the identical object.
 */
function recoverProducingBaseline(
  toolCallId: string,
  ctx: ExtensionContext,
  runtime: DcpRuntime,
  currentModel: ReturnType<typeof modelKey>,
): BaselineSnapshot | undefined {
  const bound = runtime.compressionProvenance.get(toolCallId);
  if (bound) return bound;

  const producing = findAssistantToolEntry(ctx, toolCallId);
  if (!producing) return undefined;

  const current = { model: currentModel, generation: runtime.generation, configHash: hashJson(runtime.config) };
  const baseline = findBaselineForParent(runtime, producing.parentId, current);
  if (!baseline || !baselineIdentityMatches(baseline, runtime, currentModel)) return undefined;

  runtime.compressionProvenance.set(toolCallId, baseline);
  return baseline;
}

function findAssistantToolEntry(ctx: ExtensionContext, toolCallId: string): { id: string; parentId: string | null; entryIndex: number; callNames: Map<string, string> } | undefined {
  const entries = ctx.sessionManager.buildContextEntries();
  const matches = entries.flatMap((entry, entryIndex) => entry.type === "message" && entry.message.role === "assistant" && entry.message.content.some((part) => part.type === "toolCall" && part.id === toolCallId && part.name === "compress") ? [{ entry, entryIndex }] : []);
  if (matches.length !== 1) return undefined;
  const { entry, entryIndex } = matches[0];
  if (entry.type !== "message" || entry.message.role !== "assistant") return undefined;
  return {
    id: entry.id,
    parentId: entry.parentId,
    entryIndex,
    callNames: new Map(entry.message.content.filter((part) => part.type === "toolCall").map((part) => [part.id, part.name])),
  };
}

function baselineIdentityMatches(baseline: BaselineSnapshot, runtime: DcpRuntime, currentModel: ReturnType<typeof modelKey>): boolean {
  return baseline.sessionId === runtime.sessionId
    && baseline.generation === runtime.generation
    && baseline.model.provider === currentModel.provider
    && baseline.model.id === currentModel.id
    && baseline.model.api === currentModel.api
    && baseline.model.contextWindow === currentModel.contextWindow
    && baseline.key.configSafetyHash === hashJson(runtime.config);
}

type BaselineValidation = { ok: true } | { ok: false; stage: "assistant_provenance_missing" | "duplicate_tool_call" | "assistant_parent_changed" | "projection_unsupported" | "protocol_invalid" | "history_changed" | "descendant_invalid" };
function validateBaselineHistory(baseline: BaselineSnapshot, ctx: ExtensionContext, toolCallId: string, runtime: DcpRuntime, currentModel: ReturnType<typeof modelKey>): BaselineValidation {
  const entries = ctx.sessionManager.buildContextEntries();
  const producing = findAssistantToolEntry(ctx, toolCallId);

  if (producing) {
    if (producing.parentId !== baseline.leafId) return { ok: false, stage: "assistant_parent_changed" };
    const producingIndex = entries.findIndex((entry) => entry.type === "message" && entry.id === producing.id);
    if (producingIndex < 0) return { ok: false, stage: "assistant_provenance_missing" };

    // Descendants may only be results from this assistant batch. Entries that
    // predate the assistant are checked through canonical projection below;
    // context-invisible custom operation entries must not be rejected merely
    // because protocol units intentionally do not contain their IDs.
    const seenResults = new Set<string>();
    for (let index = producingIndex + 1; index < entries.length; index++) {
      const entry = entries[index];
      if (entry.type !== "message" || entry.message.role !== "toolResult" || !producing.callNames.has(entry.message.toolCallId) || producing.callNames.get(entry.message.toolCallId) !== entry.message.toolName || seenResults.has(entry.message.toolCallId)) return { ok: false, stage: "descendant_invalid" };
      seenResults.add(entry.message.toolCallId);
    }
  } else {
    // This is the Pi 0.84.1 persistence race: `tool_call` proved the call, but
    // SessionManager still exposes the exact parent baseline. Any changed leaf
    // means unrelated history appeared and the fallback must fail closed.
    if (runtime.compressionProvenance.get(toolCallId) !== baseline) return { ok: false, stage: "assistant_provenance_missing" };
    if (ctx.sessionManager.getLeafId() !== baseline.leafId) return { ok: false, stage: "assistant_parent_changed" };
  }

  const projection = projectContextEntries(entries);
  if (!projection.ok) return { ok: false, stage: "projection_unsupported" };
  const index = buildProtocolUnits(projection.messages);
  if (!("units" in index)) return { ok: false, stage: "protocol_invalid" };

  const baselineEntryIds = new Set(baseline.units.flatMap((unit) => unit.entryIds));
  const baselineProjected = projection.messages.filter((item) => baselineEntryIds.has(item.key.entryId));
  const retainedEntries = baseline.index?.entries;
  if (!retainedEntries || baselineProjected.length !== retainedEntries.length || baselineProjected.some((item, position) => item.key.entryId !== retainedEntries[position].key.entryId || item.key.projection !== retainedEntries[position].key.projection)) return { ok: false, stage: "history_changed" };
  const baselineIndex = buildProtocolUnits(baselineProjected);
  if (!("units" in baselineIndex)) return { ok: false, stage: "protocol_invalid" };
  const currentHash = computeSnapshotHash({
    sessionId: baseline.key.branchIdentity,
    leafId: baseline.leafId,
    model: currentModel,
    configHash: baseline.key.configSafetyHash,
    generation: baseline.generation,
    units: baselineIndex.units,
    activeBlockIds: baseline.activeBlockIds,
  });
  if (currentHash !== baseline.hash) return { ok: false, stage: "history_changed" };

  if (producing) {
    // A duplicate persisted tool-call ID is never authorized. In the fallback
    // path, uniqueness comes from Pi's one `tool_call` event and single-use map.
    const callCount = projection.messages.flatMap((item) => item.message.role === "assistant" ? item.message.content.filter((part) => part.type === "toolCall" && part.id === toolCallId) : []).length;
    if (callCount !== 1) return { ok: false, stage: "duplicate_tool_call" };
  }
  return { ok: true };
}

function failure(reason: string, extra: Record<string, unknown> = {}, runtime: DcpRuntime, baseline?: BaselineSnapshot): { content: [{ type: "text"; text: string }]; details: Record<string, unknown> } {
  const errorExtra = baseline ? { ...extra, baseline } : extra;
  const details = Object.fromEntries(Object.entries(extra).filter(([key]) => key !== "ok" && key !== "baseline"));
  return { content: [{ type: "text", text: buildErrorText(runtime, reason, errorExtra) }], details: { reason, ...details } };
}
