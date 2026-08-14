import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DcpRuntime } from "../runtime.ts";

function numberOrUnknown(value: number | null | undefined): string {
  return value == null ? "unknown" : String(value);
}

function turns(value: number): string {
  return Number.isFinite(value) ? String(value) : "∞";
}

export async function debugCommand(ctx: ExtensionCommandContext, runtime: DcpRuntime): Promise<void> {
  const usage = ctx.getContextUsage();
  const evaluation = runtime.lastNudgeEvaluation;
  const lines = [
    `pi-dcp debug: runtime=${runtime.valid ? "valid" : "disabled"}; turn=${runtime.turnCount}; generation=${runtime.generation}`,
    `usage: ${numberOrUnknown(usage?.tokens)} / ${numberOrUnknown(usage?.contextWindow)} tokens (${usage?.tokens != null ? "reported" : "unavailable"})`,
    `last transform: ${runtime.lastTransform?.reason || "ok"}; changed=${runtime.lastTransform?.changed ?? "unknown"}; savings=${numberOrUnknown(runtime.lastTransform?.savingsTokens)}`,
    `nudge: ${evaluation ? evaluation.reason : "no context transform recorded"}${evaluation?.decision ? `; selected=${evaluation.decision.type}` : ""}`,
    evaluation ? `nudge inputs: tokens=${numberOrUnknown(evaluation.tokens)}; window=${evaluation.contextWindow}; thresholds=${evaluation.min}/${evaluation.max}/${evaluation.critical} tokens; turnsSince=${turns(evaluation.turnsSinceNudge)}; alreadyThisTurn=${evaluation.alreadyNudgedThisTurn}` : "nudge inputs: unavailable",
    `nudge delivery: lastSentTurn=${runtime.lastNudgeTurn ?? "never"}; snapshot=${runtime.snapshot ? "current" : "none"}`,
  ];
  ctx.ui.notify(lines.join("\n"), "info");
}
