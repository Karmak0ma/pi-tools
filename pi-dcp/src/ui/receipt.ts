import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import type { ReceiptStyle } from "../config/defaults.ts";
import type { CompressionNotification } from "./notify.ts";
import type { ContextSegment } from "./receipt-data.ts";

/**
 * TUI rendering of the compress tool: the call (header and, when expanded, the
 * summaries as Markdown) and the result receipt with the configured bar style.
 *
 * Design (chosen from docs/mockups/compress-render-v2.html):
 * - One card on `customMessageBg` with a purple `[dcp]` label, like
 *   pi-advisor-flow's `[advisor]` card, so pi-dcp output reads as one family.
 * - Collapsed: the header line plus ONE bar line, so a quiet transcript still
 *   shows how much the call gave back.
 * - Expanded: summaries through Pi's Markdown component. Before this, Pi
 *   printed the raw JSON arguments and the user saw literal "\n" escapes.
 * - Numbers use `text` (bright); labels `muted`; decoration `dim`/`border*`.
 *   The old receipt used `toolOutput`, which is grey in most themes.
 *
 * Only theme tokens are used, so a theme switch recolors old receipts too.
 * Nothing here changes the model-visible tool result text.
 */

/** Theme subset used here. Narrow on purpose, so tests can pass a fake theme. */
export type ReceiptTheme = Pick<Theme, "fg" | "bold" | "bg">;
type Color = Parameters<Theme["fg"]>[0];

export interface RenderSlotContext {
  expanded: boolean;
  outputPad?: number;
  keyHint?: (keybinding: string, description: string) => string;
}

/** Bar widths in cells. Fixed, not width-adaptive: 40 + labels fits an 80-column terminal. */
const WIDE_BAR = 40;
const COMPACT_BAR = 24;
/** Collapsed calls list at most this many ranges; a call may hold 16. */
const COLLAPSED_RANGES = 3;
/** Labeled entries under the history sparkline; older runs only get a column. */
const LABELED_HISTORY = 3;
const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
const SPARK = "▁▂▃▄▅▆▇█";

// ───────────────────────────── call ─────────────────────────────

interface RangeView { startId: string; endId: string; topic?: string; summary?: string; recall?: string[]; }

/**
 * Read the call arguments defensively. renderCall also runs while the model
 * is still streaming the arguments, so any field may be missing or partial.
 */
function rangesOf(args: unknown): { topic?: string; ranges: RangeView[] } {
  const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const topic = typeof input.topic === "string" ? input.topic : undefined;
  const content = Array.isArray(input.content) ? input.content : [];
  const ranges = content.flatMap((item): RangeView[] => {
    if (!item || typeof item !== "object") return [];
    const range = item as Record<string, unknown>;
    return [{
      startId: typeof range.startId === "string" ? range.startId : "?",
      endId: typeof range.endId === "string" ? range.endId : "?",
      topic: typeof range.topic === "string" ? range.topic : undefined,
      summary: typeof range.summary === "string" ? range.summary : undefined,
      recall: Array.isArray(range.recall) ? range.recall.filter((cue): cue is string => typeof cue === "string") : undefined,
    }];
  });
  return { topic, ranges };
}

function card(theme: ReceiptTheme, context: RenderSlotContext): Box {
  return new Box(context.outputPad ?? 1, 0, (text) => theme.bg("customMessageBg", text));
}

export function renderCompressCall(args: unknown, theme: ReceiptTheme, context: RenderSlotContext): Component {
  const { topic: callTopic, ranges } = rangesOf(args);
  const box = card(theme, context);
  box.addChild(new Spacer(1));
  const title = `${theme.fg("customMessageLabel", theme.bold("[dcp]"))} ${theme.fg("text", "Compress context")}`;
  const rangeLine = (range: RangeView, bold: boolean) => {
    const topic = oneLine(range.topic || callTopic || "Compressed context");
    return `${theme.fg("mdLink", `${range.startId} → ${range.endId}`)}  ${theme.fg("text", bold ? theme.bold(topic) : topic)}`;
  };

  // One range: everything on the title line, as in the mockup. Several: a
  // count on the title line and one line per range below it.
  if (ranges.length <= 1) {
    box.addChild(new Text(ranges[0] ? `${title}  ${rangeLine(ranges[0], context.expanded)}` : title, 0, 0));
  } else {
    box.addChild(new Text(`${title} ${theme.fg("dim", `· ${ranges.length} ranges`)}`, 0, 0));
    if (!context.expanded) {
      const lines = ranges.slice(0, COLLAPSED_RANGES).map((range) => `  ${rangeLine(range, false)}`);
      if (ranges.length > COLLAPSED_RANGES) lines.push(theme.fg("dim", `  … ${ranges.length - COLLAPSED_RANGES} more ranges`));
      box.addChild(new Text(lines.join("\n"), 0, 0));
    }
  }

  if (context.expanded) {
    ranges.forEach((range, index) => {
      if (ranges.length > 1) {
        box.addChild(new Spacer(1));
        box.addChild(new Text(`${theme.fg("dim", `${index + 1}.`)} ${rangeLine(range, true)}`, 0, 0));
      }
      if (range.summary?.trim()) {
        box.addChild(new Spacer(1));
        box.addChild(new Markdown(range.summary.trim(), 2, 0, getMarkdownTheme()));
      }
      if (range.recall?.length) {
        box.addChild(new Spacer(1));
        const cues = range.recall.map((cue) => `${theme.fg("dim", "  › ")}${theme.fg("muted", oneLine(cue))}`);
        box.addChild(new Text([theme.fg("muted", theme.bold("  Recall")), ...cues].join("\n"), 0, 0));
      }
    });
  }
  return box;
}

// ───────────────────────────── result ─────────────────────────────

interface ResultView {
  content: readonly { type: string; text?: string }[];
  details?: Record<string, unknown>;
}

/**
 * Render the receipt. `style` is read live from the configuration at render
 * time, so changing the style in /dcp settings also redraws old receipts.
 */
export function renderCompressResult(result: ResultView, style: ReceiptStyle, theme: ReceiptTheme, context: RenderSlotContext): Component {
  const box = card(theme, context);
  const notification = result.details?.notification as CompressionNotification | undefined;
  const text = result.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
  const hint = !context.expanded && context.keyHint ? `  ${context.keyHint("app.tools.expand", "to expand")}` : "";

  if (notification) {
    if (context.expanded) {
      box.addChild(new Spacer(1));
      box.addChild(new Text(expandedReceipt(notification, style, theme).join("\n"), 0, 0));
    } else {
      box.addChild(new Text(`${compactReceipt(notification, style, theme)}${theme.fg("dim", hint)}`, 0, 0));
    }
  } else if (typeof result.details?.reason === "string") {
    // A rejected call. The text is written for the model (reason, valid
    // labels, retry advice). Collapsed shows only the first line.
    const lines = text.split("\n");
    const head = `${theme.fg("error", theme.bold("✗ Compression rejected"))} ${theme.fg("dim", `· ${result.details.reason}`)}`;
    const body = context.expanded ? lines : lines.slice(0, 1);
    box.addChild(new Text([head, ...body.map((line) => theme.fg("text", `  ${line}`))].join("\n") + theme.fg("dim", hint), 0, 0));
  } else {
    // Notifications are not "detailed": show the plain result text, but in a
    // readable color instead of grey toolOutput.
    box.addChild(new Text(theme.fg("text", text), 0, 0));
  }
  box.addChild(new Spacer(1));
  return box;
}

/** The style that can actually be drawn: every style but simple needs usage data. */
export function effectiveStyle(item: CompressionNotification, style: ReceiptStyle): ReceiptStyle {
  if (style === "simple" || !(item.contextWindow && item.contextWindow > 0) || item.usageBeforeTokens === undefined) return "simple";
  if (style === "full" && !item.layout?.length) return "regained";
  return style;
}

interface Numbers { window: number; before: number; saved: number; after: number; }
function numbers(item: CompressionNotification): Numbers {
  const window = item.contextWindow || 0;
  const saved = Math.max(0, item.estimatedTokens ?? 0);
  const before = item.usageBeforeTokens ?? 0;
  return { window, before, saved, after: Math.max(0, before - saved) };
}

function compactReceipt(item: CompressionNotification, style: ReceiptStyle, theme: ReceiptTheme): string {
  const n = numbers(item);
  const check = theme.fg("success", "✓ ");
  switch (effectiveStyle(item, style)) {
    case "before-after":
      return `${check}${usageBar(n.before, n.window, 12, theme)} ${theme.fg(usageColor(n.before, n.window), pct(n.before, n.window))}${theme.fg("dim", "  →  ")}${usageBar(n.after, n.window, 12, theme)} ${theme.fg(usageColor(n.after, n.window), theme.bold(pct(n.after, n.window)))}  ${theme.fg("success", theme.bold(`−${pct(n.saved, n.window)}`))}`;
    case "regained":
      return `${check}${regainedBar(n, COMPACT_BAR, theme)}  ${theme.fg(usageColor(n.after, n.window), pct(n.after, n.window))}${theme.fg("muted", " used  ")}${theme.fg("success", theme.bold(`+${pct(n.saved, n.window)}`))}${theme.fg("muted", " regained")}`;
    case "full": {
      const summaries = item.layout?.filter((segment) => segment.kind === "summary").length ?? 0;
      return `${check}${layoutBar(item.layout ?? [], n, COMPACT_BAR, theme)}  ${theme.fg(usageColor(n.after, n.window), pct(n.after, n.window))}${theme.fg("muted", ` used · ${summaries} summar${summaries === 1 ? "y" : "ies"}  `)}${theme.fg("success", theme.bold(`+${pct(n.saved, n.window)}`))}`;
    }
    default:
      return `${check}${cellBar(item.contextPercent, 20, theme)}  ${theme.fg("success", theme.bold(item.contextPercent === undefined ? "?" : `${item.contextPercent.toFixed(1)}%`))}${theme.fg("muted", " reclaimed · ")}${theme.fg("text", tokens(n.saved))}${theme.fg("muted", " tok")}`;
  }
}

function expandedReceipt(item: CompressionNotification, style: ReceiptStyle, theme: ReceiptTheme): string[] {
  const n = numbers(item);
  const label = (text: string) => theme.fg("muted", `  ${text.padEnd(10)}`);
  const indent = " ".repeat(12);
  const lines = [
    theme.fg("success", theme.bold(`◆ CONTEXT COMPRESSED · #${item.compressionCount}`)),
    theme.fg("text", `  ${oneLine(item.topic?.trim() || "compressed context")}`),
    "",
  ];
  const windowText = theme.fg("dim", `  ${tokens(n.window)}`);
  switch (effectiveStyle(item, style)) {
    case "before-after":
      lines.push(
        `${label("before")}${usageBar(n.before, n.window, WIDE_BAR, theme)}  ${theme.fg("text", tokens(n.before).padStart(6))}${theme.fg("muted", ` / ${tokens(n.window)}  `)}${theme.fg(usageColor(n.before, n.window), pct(n.before, n.window).padStart(6))}`,
        `${label("after")}${usageBar(n.after, n.window, WIDE_BAR, theme)}  ${theme.fg("text", theme.bold(tokens(n.after).padStart(6)))}${theme.fg("muted", ` / ${tokens(n.window)}  `)}${theme.fg(usageColor(n.after, n.window), theme.bold(pct(n.after, n.window).padStart(6)))}  ${theme.fg("success", theme.bold(`−${pct(n.saved, n.window)}`))}`,
      );
      break;
    case "regained":
      lines.push(
        `${label("context")}${regainedBar(n, WIDE_BAR, theme)}${windowText}`,
        `${indent}${legend(theme, usageColor(n.after, n.window), "used", n.after, n.window)}    ${legend(theme, "success", "regained", n.saved, n.window)}`,
      );
      break;
    case "full": {
      const layout = item.layout ?? [];
      const sum = (kind: ContextSegment["kind"]) => layout.filter((segment) => segment.kind === kind).reduce((total, segment) => total + segment.tokens, 0);
      const summaries = layout.filter((segment) => segment.kind === "summary").length;
      lines.push(
        `${label("context")}${layoutBar(layout, n, WIDE_BAR, theme)}${windowText}`,
        `${indent}${legend(theme, "muted", "system", sum("system"))}  ${legend(theme, usageColor(n.after, n.window), "history", sum("history"))}  ${legend(theme, "customMessageLabel", `summaries (${summaries})`, sum("summary"))}  ${legend(theme, "success", "saved", n.saved)}`,
        `${indent}${theme.fg(usageColor(n.after, n.window), theme.bold(pct(n.after, n.window)))}${theme.fg("muted", " used · ")}${theme.fg("success", theme.bold(`+${pct(n.saved, n.window)}`))}${theme.fg("muted", " regained by this call")}`,
      );
      if (item.history?.length) lines.push("", `${label("history")}${historyStrip(item.history, theme)}`);
      break;
    }
    default:
      lines.push(
        `${label("reclaimed")}${cellBar(item.contextPercent, WIDE_BAR, theme)}  ${theme.fg("success", theme.bold(item.contextPercent === undefined ? "?" : `${item.contextPercent.toFixed(1)}%`))}${n.window ? theme.fg("muted", ` of ${tokens(n.window)}`) : ""}`,
        theme.fg("dim", `${indent}0         25        50        75        100`),
      );
  }
  // Option 2's right-aligned table: numbers line up and scan fast.
  lines.push(
    "",
    `${label("this call")}${theme.fg("text", theme.bold(integer(n.saved).padStart(8)))}${theme.fg("muted", " tok   ")}${theme.fg("text", integer(item.toolCount).padStart(3))}${theme.fg("muted", " tools   ")}${theme.fg("text", integer(item.messageCount).padStart(3))}${theme.fg("muted", " messages")}`,
    `${label("session")}${theme.fg("text", theme.bold(integer(item.sessionTotalTokens).padStart(8)))}${theme.fg("muted", " tok   ")}${theme.fg("text", integer(item.compressionCount).padStart(3))}${theme.fg("muted", ` compression${item.compressionCount === 1 ? "" : "s"}`)}`,
  );
  return lines;
}

// ───────────────────────────── bars ─────────────────────────────

/**
 * Usage color, same thresholds as the sidebar-vflo context meter: above 60%
 * red, above 40% yellow, else accent (blue in sidebar-vflo and monokai-vflo).
 */
export function usageColor(value: number, window: number): Color {
  const percent = window > 0 ? value / window * 100 : 0;
  return percent > 60 ? "error" : percent > 40 ? "warning" : "accent";
}

interface BarPart { tokens: number; color: Color; glyph?: string; minCell?: boolean; }

/**
 * Draw parts left to right on a `width`-cell track.
 *
 * A terminal cell has one foreground color, so the edge between two colored
 * parts must fall on a whole cell. Only the last part may end in an
 * eighth-block (`smoothEnd`), against the track. `minCell` parts get at least
 * one cell even when smaller, taken from the largest part without it: a small
 * summary block must stay visible in the full layout, or the bar would hide
 * the very thing it is meant to show.
 */
export function drawBar(parts: readonly BarPart[], total: number, width: number, theme: ReceiptTheme, smoothEnd = false): string {
  if (!(total > 0) || width <= 0) return theme.fg("borderMuted", "█".repeat(Math.max(0, width)));
  const exact = parts.map((part) => Math.max(0, part.tokens) / total * width);
  // Edges at rounded cumulative positions: rounding errors never accumulate.
  const cells: number[] = [];
  let cumulative = 0;
  let previousEdge = 0;
  for (const value of exact) {
    cumulative += value;
    const edge = Math.min(width, Math.round(cumulative));
    cells.push(Math.max(0, edge - previousEdge));
    previousEdge = Math.max(previousEdge, edge);
  }
  parts.forEach((part, index) => {
    if (!part.minCell || cells[index] > 0 || exact[index] <= 0) return;
    let donor = -1;
    cells.forEach((count, candidate) => { if (!parts[candidate].minCell && count > 1 && (donor < 0 || count > cells[donor])) donor = candidate; });
    if (donor >= 0) cells[donor]--;
    cells[index] = 1;
  });

  // Eighth-block end: recompute the last part from the exact end position.
  let partial = "";
  if (smoothEnd && parts.length > 0) {
    const last = parts.length - 1;
    const start = cells.slice(0, last).reduce((sum, count) => sum + count, 0);
    const end = Math.min(width, exact.reduce((sum, value) => sum + value, 0));
    const whole = Math.max(0, Math.floor(end) - start);
    const eighth = Math.round((end - Math.floor(end)) * 8);
    cells[last] = whole + (eighth === 8 ? 1 : 0);
    if (eighth > 0 && eighth < 8 && start + whole < width) partial = theme.fg(parts[last].color, EIGHTHS[eighth]);
  }

  let used = 0;
  let out = "";
  parts.forEach((part, index) => {
    const count = Math.max(0, Math.min(cells[index], width - used));
    if (count > 0) out += theme.fg(part.color, (part.glyph ?? "█").repeat(count));
    used += count;
  });
  if (partial) { out += partial; used++; }
  return out + theme.fg("borderMuted", "█".repeat(Math.max(0, width - used)));
}

function usageBar(value: number, window: number, width: number, theme: ReceiptTheme): string {
  return drawBar([{ tokens: value, color: usageColor(value, window) }], window, width, theme, true);
}

function regainedBar(n: Numbers, width: number, theme: ReceiptTheme): string {
  return drawBar([{ tokens: n.after, color: usageColor(n.after, n.window) }, { tokens: n.saved, color: "success" }], n.window, width, theme, true);
}

/**
 * The full layout: system (grey), raw history (usage color), summaries
 * (purple), then this call's savings (green) at the end. Neighboring summaries
 * alternate █ and ▓, so two adjacent blocks still read as two.
 */
function layoutBar(layout: readonly ContextSegment[], n: Numbers, width: number, theme: ReceiptTheme): string {
  const history = usageColor(n.after, n.window);
  let alternate = false;
  const parts: BarPart[] = layout.map((segment, index) => {
    if (segment.kind === "summary") {
      alternate = layout[index - 1]?.kind === "summary" ? !alternate : false;
      return { tokens: segment.tokens, color: "customMessageLabel", glyph: alternate ? "▓" : "█", minCell: true };
    }
    return { tokens: segment.tokens, color: segment.kind === "system" ? "muted" : history, minCell: segment.kind === "system" };
  });
  parts.push({ tokens: n.saved, color: "success", minCell: true });
  return drawBar(parts, n.window, width, theme);
}

/** Option 2's ▰▱ cell bar for the simple style. */
function cellBar(percent: number | undefined, width: number, theme: ReceiptTheme): string {
  if (percent === undefined) return theme.fg("border", "▱".repeat(width));
  const filled = Math.max(0, Math.min(width, Math.round(width * percent / 100)));
  return theme.fg("success", "▰".repeat(filled)) + theme.fg("border", "▱".repeat(width - filled));
}

/** One sparkline column per compression; the newest (this call) is green. */
function historyStrip(history: readonly number[], theme: ReceiptTheme): string {
  const max = Math.max(...history, 1);
  const spark = history.map((value, index) => theme.fg(index === history.length - 1 ? "success" : "accent", SPARK[Math.max(0, Math.min(7, Math.round(value / max * 7)))])).join("");
  const first = history.length - Math.min(LABELED_HISTORY, history.length);
  const labels = history.slice(first).map((value, offset) => `${theme.fg("muted", `#${first + offset + 1} `)}${theme.fg("text", tokens(value))}`).join(theme.fg("dim", " · "));
  return `${spark}  ${labels}`;
}

function legend(theme: ReceiptTheme, color: Color, name: string, value: number, window?: number): string {
  const share = window ? theme.fg(color, ` ${pct(value, window)}`) : "";
  return `${theme.fg(color, "■")}${theme.fg("muted", ` ${name} `)}${theme.fg("text", theme.bold(tokens(value)))}${share}`;
}

// ───────────────────────────── format ─────────────────────────────

function oneLine(text: string): string { return text.replace(/\s+/g, " ").trim(); }
function integer(value: number): string { return Math.max(0, Math.round(value)).toLocaleString("en-US"); }
function pct(value: number, window: number): string { return window > 0 ? `${(value / window * 100).toFixed(1)}%` : "?"; }
/** Compact token count: 812, 36.8k, 128k, 1.2M. One decimal only while it adds information. */
export function tokens(value: number): string {
  const count = Math.max(0, value);
  if (count < 1_000) return String(Math.round(count));
  if (count < 100_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}
