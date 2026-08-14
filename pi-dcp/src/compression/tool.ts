import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { CompressionParameters, isCompressionParams } from "./schema.ts";
import { buildCompressionEnvelope } from "./service.ts";
import { isSnapshotCurrent, modelKey, computeSnapshotHash } from "../identity/snapshot.ts";
import { projectContextEntries } from "../identity/project.ts";
import { buildProtocolUnits } from "../identity/protocol.ts";
import { reduceEnvelope } from "../state/reducer.ts";
import { notify } from "../ui/notify.ts";
import { hashJson } from "../util/hash.ts";
import { type DcpRuntime, invalidateSnapshot } from "../runtime.ts";
import { validateProtocol } from "../transform/protocol-check.ts";

export function registerCompressionTool(pi: ExtensionAPI, runtime: DcpRuntime): void {
  // Pi deliberately blocks action methods such as getAllTools() while extension
  // factories are loading. Collision preflight therefore cannot happen here:
  // calling it prevents registration and, because lifecycle setup is atomic,
  // also prevents every context/nudge hook from being installed. registerTool()
  // is the supported load-time API and Pi owns name-override diagnostics.
  const tool: ToolDefinition<typeof CompressionParameters> = { name: "compress", label: "Compress context", description: "Create one or more faithful, contiguous, model-authored context summaries using the latest pi-dcp snapshot aliases. Choose older resolved conversation whose work is finished or no longer needed immediately, such as completed implementation or concluded research; keep active work, unresolved questions, pending tool exchanges, and protected content out of the range.", promptSnippet: "compress older resolved context ranges", promptGuidelines: ["Use compress to summarize older resolved conversation whose work is finished or no longer needed immediately; keep active work and unresolved questions out of the range.", "Use compress only with current pi-dcp snapshot aliases and preserve complete tool call/result units."], parameters: CompressionParameters, executionMode: "sequential", async execute(toolCallId, params, _signal, _onUpdate, ctx) { return executeCompression(toolCallId, params, ctx, pi, runtime); } };
  pi.registerTool(tool);
}
async function executeCompression(toolCallId: string, params: unknown, ctx: ExtensionContext, pi: ExtensionAPI, runtime: DcpRuntime): Promise<{ content: [{ type: "text"; text: string }]; details: Record<string, unknown> }> {
  if (!isCompressionParams(params)) return failure("range_invalid");
  if (!runtime.valid || runtime.mutationBlocked) return failure("permission_denied");
  if (runtime.reduced.manualMode) { if (!runtime.manualAuthorization || runtime.manualAuthorization.expiresAt < Date.now()) return failure("manual_nonce_required"); runtime.manualAuthorization = undefined; }
  if (runtime.config.compress.permission === "deny") return failure("permission_denied");
  let ask = false;
  const first = await runtime.mutex.runExclusive(() => {
    const snapshot = runtime.snapshot; const currentModel = modelKey(ctx.model, ctx.getContextUsage()?.contextWindow || 0);
    if (!snapshot || !isSnapshotCurrent(snapshot, { sessionId: runtime.sessionId, leafId: ctx.sessionManager.getLeafId(), model: currentModel, generation: runtime.generation })) return { error: "snapshot_stale" };
    ask = runtime.config.compress.permission === "ask"; return { snapshot };
  });
  if ("error" in first) return failure(first.error || "snapshot_stale");
  if (ask) { if (!ctx.hasUI) return failure("permission_unavailable"); let confirmed = false; try { confirmed = await ctx.ui.confirm("Allow pi-dcp compression?", "The model-selected ranges and summaries will be persisted as one pi-dcp operation. Raw history is not modified.", { timeout: 30_000 }); } catch { confirmed = false; } if (!confirmed) return failure("permission_denied"); }
  return runtime.mutex.runExclusive(() => {
    if (!runtime.snapshot || !isSnapshotCurrent(runtime.snapshot, { sessionId: runtime.sessionId, leafId: ctx.sessionManager.getLeafId(), model: modelKey(ctx.model, ctx.getContextUsage()?.contextWindow || 0), generation: runtime.generation })) return failure("snapshot_stale");
    const projection = projectContextEntries(ctx.sessionManager.buildContextEntries());
    const currentIndex = projection.ok ? buildProtocolUnits(projection.messages) : { ok: false as const, reason: "projection_unsupported" as const };
    if (!("units" in currentIndex) || computeSnapshotHash({ sessionId: runtime.sessionId, leafId: ctx.sessionManager.getLeafId(), model: modelKey(ctx.model, ctx.getContextUsage()?.contextWindow || 0), configHash: hashJson(runtime.config), generation: runtime.generation, units: currentIndex.units, activeBlockIds: runtime.snapshot.activeBlockIds }) !== runtime.snapshot.hash) return failure("snapshot_stale");
    const built = buildCompressionEnvelope({ sessionId: runtime.sessionId, extensionVersion: "0.1.0", snapshot: runtime.snapshot, state: runtime.reduced, params, model: ctx.model, toolCallId, maxSummaryChars: runtime.config.summary.maxChars, maxExpandedChars: runtime.config.summary.maxExpandedChars, maxNestedDepth: runtime.config.summary.maxNestedDepth, index: runtime.index, protection: { cwd: ctx.cwd, protectedTools: runtime.config.compress.protectedTools, protectedFilePatterns: runtime.config.protectedFilePatterns }, turnProtection: runtime.config.turnProtection, protectUserMessages: runtime.config.compress.protectUserMessages });
    if (!built.ok) return failure(built.reason);
    pi.appendEntry("pi-dcp.operation", built.envelope); runtime.reduced = reduceEnvelope(runtime.reduced, built.envelope); runtime.generation++; runtime.snapshot = undefined; notify(ctx, runtime.config, { action: "compressed", topic: params.topic, count: built.blocks.length, estimatedTokens: built.blocks.reduce((sum, block) => sum + block.estimatedSummaryTokens, 0), confidence: "heuristic" }, pi);
    return { content: [{ type: "text", text: `pi-dcp compressed ${built.blocks.length} range(s). Snapshot invalidated; refresh context aliases.` }], details: { runId: built.envelope.operation.type === "compression.created" ? built.envelope.operation.runId : undefined, blockIds: built.blocks.map((block) => block.blockId), estimatedDelta: built.blocks.reduce((sum, block) => sum + block.estimatedSummaryTokens, 0) } };
  });
}
function failure(reason: string): { content: [{ type: "text"; text: string }]; details: Record<string, unknown> } { return { content: [{ type: "text", text: `pi-dcp: ${reason}` }], details: { reason } }; }
void Type; void validateProtocol; void hashJson; void invalidateSnapshot;
