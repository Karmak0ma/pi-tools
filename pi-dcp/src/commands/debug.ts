import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { latestBaseline, type DcpRuntime } from "../runtime.ts";
import { knownAdapterIds } from "../transform/adapters.ts";
import { VERSION } from "../lifecycle.ts";

function numberOrUnknown(value: number | null | undefined): string {
  return value == null ? "unknown" : String(value);
}

function turns(value: number): string {
  return Number.isFinite(value) ? String(value) : "∞";
}

export async function debugCommand(ctx: ExtensionCommandContext, pi: ExtensionAPI, runtime: DcpRuntime): Promise<void> {
  const usage = ctx.getContextUsage();
  const evaluation = runtime.lastNudgeEvaluation;
  const readiness = runtime.lastReadiness;
  const model = runtime.lastModel;
  // Ground truth, not the model's self-report: whether the host will
  // actually offer `compress` in the tool schema for the next turn. A model
  // that already refused earlier in this conversation tends to keep echoing
  // that refusal even after the tool becomes available again, so this is the
  // only reliable way to tell a real exposure gap from a stale claim.
  const activeTools = (() => { try { return pi.getActiveTools(); } catch { return undefined; } })();
  const lines = [
    `pi-dcp debug: runtime=${runtime.valid ? "valid" : "disabled"}; turn=${runtime.turnCount}; generation=${runtime.generation}`,
    `usage: ${numberOrUnknown(usage?.tokens)} / ${numberOrUnknown(usage?.contextWindow)} tokens (${usage?.tokens != null ? "reported" : "unavailable"})`,
    `last transform: ${runtime.lastTransform?.reason || "ok"}; changed=${runtime.lastTransform?.changed ?? "unknown"}; savings=${numberOrUnknown(runtime.lastTransform?.savingsTokens)}`,
    `nudge: ${evaluation ? evaluation.reason : "no context transform recorded"}${evaluation?.decision ? `; selected=${evaluation.decision.type}` : ""}`,
    evaluation ? `nudge inputs: tokens=${numberOrUnknown(evaluation.tokens)}; window=${evaluation.contextWindow}; thresholds=${evaluation.min}/${evaluation.max}/${evaluation.critical} tokens; turnsSince=${turns(evaluation.turnsSinceNudge)}; alreadyThisTurn=${evaluation.alreadyNudgedThisTurn}` : "nudge inputs: unavailable",
    `nudge delivery: lastSentTurn=${runtime.lastNudgeTurn ?? "never"}; baselines=${runtime.baselines.order.length}; latest=${latestBaseline(runtime) ? "retained" : "none"}`,
    `runtime version:       ${VERSION}`,
    `active model:          ${model ? `${model.provider}/${model.id}` : "none yet"}`,
    `active API:            ${model?.api || "none yet"}`,
    `adapter:               generic (known apis: ${knownAdapterIds().join(", ")})`,
    `compression readiness: ${readiness?.ready ? "ready" : `unavailable (${readiness?.reason || "unknown"})`}`,
    `compress tool exposed: ${activeTools === undefined ? "unknown (getActiveTools unavailable)" : activeTools.includes("compress") ? "yes" : "no"}`,
  ];
  ctx.ui.notify(lines.join("\n"), "info");
}
