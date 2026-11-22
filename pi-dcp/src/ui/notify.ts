import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EffectiveConfig } from "../config/defaults.ts";
import type { ContextSegment } from "./receipt-data.ts";

export interface Notification {
  action: string;
  topic?: string;
  count?: number;
  estimatedTokens?: number;
  durationMs?: number;
  confidence?: "reported" | "heuristic";
}

/**
 * The data needed by the compression receipt renderer.
 *
 * `contextPercent` is the estimated savings as a percentage of the model's
 * context window. Keeping the denominator explicit avoids presenting a
 * savings percentage based on a provider-specific or stale token report.
 */
export interface CompressionNotification extends Notification {
  compressionCount: number;
  toolCount: number;
  messageCount: number;
  contextPercent?: number;
  sessionTotalTokens: number;
  /*
   * The fields below feed the TUI bar styles (ui/receipt.ts). All are
   * optional: receipts stored by older versions lack them, and Pi may not
   * know the usage. The renderer then falls back to the simple style.
   */
  /** Context window the percentages refer to. */
  contextWindow?: number;
  /** Pi's reported context usage when the call ran, i.e. before this call applies. */
  usageBeforeTokens?: number;
  /** Ordered context layout after this call, scaled to usage before − savings. */
  layout?: ContextSegment[];
  /** Estimated savings per compression in this session, oldest first, this call last. */
  history?: number[];
}

const CONTEXT_BAR_WIDTH = 32;

/**
 * Render one notification, or undefined when notifications are off.
 *
 * This plain-text form is used in tool results, print/RPC modes, and toast
 * delivery. The TUI draws the receipt itself (ui/receipt.ts) from the same
 * data, so no ANSI sequences ever reach the model-visible tool result.
 */
export function formatNotification(config: EffectiveConfig, item: Notification): string | undefined {
  if (config.pruneNotification === "off") return undefined;
  if (config.pruneNotification === "detailed" && isCompressionNotification(item)) return formatCompressionNotification(item);

  const estimate = item.estimatedTokens === undefined ? "" : ` ~${formatInteger(item.estimatedTokens)} tokens`;
  const detail = config.pruneNotification === "detailed"
    ? ` (${item.topic || ""}${item.count === undefined ? "" : `, ${item.count} item(s)`}${item.durationMs === undefined ? "" : `, ${item.durationMs}ms`}${item.confidence ? `, ${item.confidence}` : ""})`
    : "";
  return `${item.action}${estimate}${detail}`;
}

/** Show the notification as a toast when the configuration asks for one. */
export function notify(ctx: ExtensionContext, config: EffectiveConfig, item: Notification): void {
  const message = formatNotification(config, item);
  if (!message) return;
  if (config.pruneNotificationType === "toast" || config.pruneNotificationType === "both" || ctx.mode !== "tui") ctx.ui.notify(message, "info");
}

function isCompressionNotification(item: Notification): item is CompressionNotification {
  return typeof (item as Partial<CompressionNotification>).compressionCount === "number"
    && typeof (item as Partial<CompressionNotification>).toolCount === "number"
    && typeof (item as Partial<CompressionNotification>).messageCount === "number"
    && typeof (item as Partial<CompressionNotification>).sessionTotalTokens === "number";
}

function formatCompressionNotification(item: CompressionNotification): string {
  const topic = item.topic?.trim() || "compressed context";
  const percent = item.contextPercent === undefined ? "? reclaimed" : `${formatPercent(item.contextPercent)} reclaimed`;
  return [
    `✓ Compression #${item.compressionCount}  ${topic}`,
    `context  ${plainContextBar(item.contextPercent)}  ${percent}`,
    `this call ${formatInteger(item.estimatedTokens ?? 0)} tokens from ${formatInteger(item.toolCount)} tools / ${formatInteger(item.messageCount)} messages`,
    `session   ${formatInteger(item.sessionTotalTokens)} tokens compressed total`,
  ].join("\n");
}

function plainContextBar(percent: number | undefined): string {
  if (percent === undefined) return "[?]";
  const reclaimed = Math.min(CONTEXT_BAR_WIDTH, Math.max(0, Math.round(CONTEXT_BAR_WIDTH * percent / 100)));
  return `[${"█".repeat(CONTEXT_BAR_WIDTH - reclaimed)}${"░".repeat(reclaimed)}]`;
}

function formatInteger(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString("en-US");
}

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}
