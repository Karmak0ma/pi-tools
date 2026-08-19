import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EffectiveConfig } from "../config/defaults.ts";

export interface Notification { action: string; topic?: string; count?: number; estimatedTokens?: number; durationMs?: number; confidence?: "reported" | "heuristic"; }

/**
 * Render one notification line, or undefined when notifications are off.
 *
 * The line is produced separately from delivery so the same text can be shown
 * as a toast and, for tool-initiated work, be returned as part of the tool
 * result. Delivering it through a separate chat message is deliberately no
 * longer supported: Pi can only insert an extension message mid-turn with
 * `deliverAs: "nextTurn"`, which held the line back until the following turn
 * and made compression look like it had done nothing.
 */
export function formatNotification(config: EffectiveConfig, item: Notification): string | undefined {
  if (config.pruneNotification === "off") return undefined;
  const estimate = item.estimatedTokens === undefined ? "" : ` ~${item.estimatedTokens} tokens`;
  const detail = config.pruneNotification === "detailed"
    ? ` (${item.topic || ""}${item.count === undefined ? "" : `, ${item.count} item(s)`}${item.durationMs === undefined ? "" : `, ${item.durationMs}ms`}${item.confidence ? `, ${item.confidence}` : ""})`
    : "";
  return `${item.action}${estimate}${detail}`;
}

/** Show the line as a toast when the configuration asks for one. */
export function notify(ctx: ExtensionContext, config: EffectiveConfig, item: Notification): void {
  const message = formatNotification(config, item);
  if (!message) return;
  if (config.pruneNotificationType === "toast" || config.pruneNotificationType === "both" || ctx.mode !== "tui") ctx.ui.notify(message, "info");
}
