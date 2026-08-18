import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DcpRuntime } from "../runtime.ts";

export async function contextCommand(ctx: ExtensionCommandContext, runtime: DcpRuntime): Promise<void> {
  const usage = ctx.getContextUsage();
  const estimate = runtime.lastTransform?.estimatedTokens;
  const active = [...runtime.reduced.blocks.values()].filter((block) => block.active && block.available);
  const nudge = runtime.lastNudgeEvaluation;
  const nudgeSummary = nudge ? `${nudge.reason}${nudge.decision ? ` (${nudge.decision.type})` : ""}; last sent turn ${runtime.lastNudgeTurn ?? "never"}` : "not evaluated";
  const readiness = runtime.lastReadiness;
  ctx.ui.notify(`pi-dcp context: ${usage?.tokens ?? estimate ?? "unknown"} tokens (${usage?.tokens != null ? "reported" : "heuristic"}); ${active.length} active block(s), savings ${runtime.lastTransform?.savingsTokens ?? "unknown"}, changed prefix ${runtime.lastTransform?.changedPrefix ?? "unknown"}, confidence ${runtime.lastTransform?.confidence ?? "heuristic"}; nudge ${nudgeSummary}. compression: ${readiness?.ready ? "ready" : `unavailable (${readiness?.reason || "unknown"})`}.`, "info");
}
