import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { CompressionParameters, isCompressionParams } from "./schema.ts";
import { buildCompressionEnvelope } from "./service.ts";
import { modelKey, computeSnapshotHash } from "../identity/snapshot.ts";
import type { BaselineSnapshot } from "../identity/types.ts";
import { projectContextEntries } from "../identity/project.ts";
import { buildProtocolUnits } from "../identity/protocol.ts";
import { reduceEnvelope } from "../state/reducer.ts";
import { OPERATION_CUSTOM_TYPE } from "../state/operations.ts";
import { notify } from "../ui/notify.ts";
import { hashJson } from "../util/hash.ts";
import { clearBaselines, findBaselineForParent, latestBaseline, pinBaseline, unpinBaseline, type DcpRuntime } from "../runtime.ts";
import { persistSavingsBestEffort } from "../stats.ts";

export function registerCompressionTool(pi: ExtensionAPI, runtime: DcpRuntime): void {
  const tool: ToolDefinition<typeof CompressionParameters> = {
    name: "compress",
    label: "Compress context",
    description: "Create faithful, contiguous, model-authored summaries for older resolved context. Select complete protocol units using local mNNNN and bNNNN labels; do not include active work, unresolved questions, pending tool exchanges, or protected content.",
    promptSnippet: "compress older resolved context ranges",
    promptGuidelines: [
      "Use compress for older resolved conversation whose work is finished or no longer needed immediately.",
      "Use compress with contiguous complete protocol units using current local mNNNN and bNNNN labels.",
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
    const configHash = hashJson(runtime.config);
    const persisted = findAssistantToolEntry(ctx, toolCallId);
    const baseline = persisted
      ? findBaselineForParent(runtime, persisted.parentId, { model: currentModel, generation: runtime.generation, configHash })
      : findBaselineForParent(runtime, ctx.sessionManager.getLeafId(), { model: currentModel, generation: runtime.generation, configHash }) || latestBaseline(runtime);
    if (baseline && baselineIdentityMatches(baseline, runtime, currentModel)) runtime.compressionProvenance.set(toolCallId, baseline);
  });
}

async function executeCompression(toolCallId: string, rawParams: unknown, ctx: ExtensionContext, pi: ExtensionAPI, runtime: DcpRuntime): Promise<{ content: [{ type: "text"; text: string }]; details: Record<string, unknown> }> {
  try {
    // A v1 call is rejected before any state lookup. In particular, the model
    // cannot revive a deprecated singleton snapshot by echoing snapshotId.
    if (!isCompressionParams(rawParams)) return failure("protocol_version", { stage: "v1_schema_rejected" });
    const params = rawParams;
    if (!runtime.valid || runtime.mutationBlocked) return failure("permission_denied");
    if (runtime.config.compress.permission === "deny") return failure("permission_denied");

  let ask = false;
  const first = await runtime.mutex.runExclusive(() => {
    const baseline = producingBaseline(toolCallId, ctx, runtime);
    if (!baseline) return { error: "baseline_unavailable", stage: "assistant_provenance_missing" } as const;
    const currentModel = modelKey(ctx.model, ctx.getContextUsage()?.contextWindow || 0);
    if (!baselineIdentityMatches(baseline, runtime, currentModel)) return { error: "baseline_unavailable", stage: "baseline_identity_mismatch" } as const;
    const validation = validateBaselineHistory(baseline, ctx, toolCallId, runtime, currentModel);
    if (!validation.ok) return { error: "baseline_unavailable", stage: validation.stage } as const;
    ask = runtime.config.compress.permission === "ask";
    return { baseline } as const;
  });
  if ("error" in first) return failure(first.error || "baseline_unavailable", { stage: first.stage });
  pinBaseline(runtime, first.baseline);

  if (ask) {
    if (!ctx.hasUI) { unpinBaseline(runtime, first.baseline); return failure("permission_unavailable"); }
    let confirmed = false;
    try {
      confirmed = await ctx.ui.confirm("Allow pi-dcp compression?", "The model-selected ranges and summaries will be persisted as one pi-dcp operation. Raw history is not modified.", { timeout: 30_000 });
    } catch { confirmed = false; }
    if (!confirmed) { unpinBaseline(runtime, first.baseline); return failure("permission_denied"); }
  }

    return await runtime.mutex.runExclusive(async () => {
      try {
        const baseline = producingBaseline(toolCallId, ctx, runtime);
    const currentModel = modelKey(ctx.model, ctx.getContextUsage()?.contextWindow || 0);
    if (!baseline) return failure("baseline_unavailable", { stage: "assistant_provenance_missing" });
    if (!baselineIdentityMatches(baseline, runtime, currentModel)) return failure("baseline_unavailable", { stage: "baseline_identity_mismatch" });
    const validation = validateBaselineHistory(baseline, ctx, toolCallId, runtime, currentModel);
    if (!validation.ok) return failure("baseline_unavailable", { stage: validation.stage });

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
    if (!built.ok) return failure(built.reason);

    pi.appendEntry(OPERATION_CUSTOM_TYPE, built.envelope);
    await persistSavingsBestEffort(built.envelope, runtime.logger);
    runtime.reduced = reduceEnvelope(runtime.reduced, built.envelope);
    if (runtime.reduced.corruptReason) return failure("state_conflict");
    runtime.generation++;
    clearBaselines(runtime);
    notify(ctx, runtime.config, {
      action: "compressed",
      topic: params.topic,
      count: built.blocks.length,
      estimatedTokens: built.blocks.reduce((sum, block) => sum + (block.estimatedSavingsTokens || 0), 0),
      confidence: "heuristic",
    }, pi);
    return {
      content: [{ type: "text", text: `pi-dcp compressed ${built.blocks.length} range(s). Refresh context aliases.` }],
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

function producingBaseline(toolCallId: string, _ctx: ExtensionContext, runtime: DcpRuntime): BaselineSnapshot | undefined {
  // Persisted assistant history is validation evidence, not an execution grant.
  // Every live execution must first pass through Pi's authoritative `tool_call`
  // event, which creates this single-use binding. Otherwise replaying an old
  // assistant entry could append the same logical compression more than once.
  return runtime.compressionProvenance.get(toolCallId);
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

function failure(reason: string, extra: Record<string, unknown> = {}): { content: [{ type: "text"; text: string }]; details: Record<string, unknown> } {
  const suffix = typeof extra.stage === "string" ? ` (${extra.stage})` : "";
  return { content: [{ type: "text", text: `pi-dcp: ${reason}${suffix}` }], details: { reason, ...extra } };
}
