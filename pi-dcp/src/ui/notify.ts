import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { EffectiveConfig } from "../config/defaults.ts";

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
}

const CONTEXT_BAR_WIDTH = 32;

/**
 * Render one notification, or undefined when notifications are off.
 *
 * Detailed compression notifications use the same four-line information
 * hierarchy as the selected option 3 prototype. This plain-text form is used
 * in tool results, print/RPC modes, and toast delivery. The TUI result renderer
 * below applies live theme colors without putting ANSI sequences into the
 * model-visible tool result.
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

/**
 * Render option 3 for the interactive TUI.
 *
 * The `Theme` instance is supplied by Pi's renderer. Each result refresh calls
 * this function again, so a live theme switch regenerates every colored span
 * instead of leaving stale ANSI colors in the transcript.
 */
export function renderCompressionNotification(item: CompressionNotification, theme: Theme): Text {
  const topic = item.topic?.trim() || "compressed context";
  const title = `${theme.fg("success", theme.bold(`✓ Compression #${item.compressionCount}`))}  ${theme.fg("customMessageText", topic)}`;
  const context = renderContextBar(item.contextPercent, theme);
  const call = `${theme.fg("muted", "this call ")}${theme.fg("toolOutput", `${formatInteger(item.estimatedTokens ?? 0)} tokens`)}${theme.fg("muted", ` from ${formatInteger(item.toolCount)} tools / ${formatInteger(item.messageCount)} messages`)}`;
  const session = `${theme.fg("muted", "session   ")}${theme.fg("accent", `${formatInteger(item.sessionTotalTokens)} tokens compressed total`)}`;
  return new Text(`${title}\n${context}\n${call}\n${session}`, 0, 0);
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

function renderContextBar(percent: number | undefined, theme: Theme): string {
  if (percent === undefined) return `${theme.fg("muted", "context  [?]")}  ${theme.fg("muted", "? reclaimed")}`;
  const reclaimed = Math.min(CONTEXT_BAR_WIDTH, Math.max(0, Math.round(CONTEXT_BAR_WIDTH * percent / 100)));
  const retained = CONTEXT_BAR_WIDTH - reclaimed;
  return `${theme.fg("muted", "context  ")}${theme.fg("warning", "█".repeat(retained))}${theme.fg("success", "█".repeat(reclaimed))}${theme.fg("success", `  ${formatPercent(percent)} reclaimed`)}`;
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
