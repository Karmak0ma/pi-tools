import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { RECEIPT_STYLES, type ReceiptStyle } from "../config/defaults.ts";
import type { CompressionNotification } from "./notify.ts";
import { renderCompressCall, renderCompressResult, type ReceiptTheme } from "./receipt.ts";

/**
 * Receipt style picker for /dcp settings: the list on the left, a live preview
 * of the highlighted style on the right. The preview is drawn by the real
 * receipt renderer with the active theme, so what the user sees here is what
 * the transcript will show, and the two can never drift apart.
 */

/** One line per style in the list. */
export const RECEIPT_STYLE_LABELS: Record<ReceiptStyle, string> = {
  simple: "simple — share this call reclaimed",
  "before-after": "before-after — usage before/after",
  regained: "regained — used + regained",
  full: "full — layout with summaries",
};

/**
 * Fixed example numbers for the preview. Chosen so every style shows its
 * point: usage crosses a color threshold (64% red → 46% yellow), and the
 * layout holds two adjacent summaries plus a separate one.
 */
export const PREVIEW_RECEIPT: CompressionNotification = {
  action: "compressed",
  topic: "Merge main into phase-10f",
  count: 1,
  estimatedTokens: 36_812,
  confidence: "heuristic",
  compressionCount: 3,
  toolCount: 12,
  messageCount: 41,
  contextPercent: 18.4,
  sessionTotalTokens: 92_340,
  contextWindow: 200_000,
  usageBeforeTokens: 128_600,
  layout: [
    { kind: "system", tokens: 9_000 },
    { kind: "history", tokens: 24_000 },
    { kind: "summary", tokens: 2_400 },
    { kind: "summary", tokens: 1_800 },
    { kind: "history", tokens: 31_000 },
    { kind: "summary", tokens: 2_100 },
    { kind: "history", tokens: 21_488 },
  ],
  history: [21_300, 34_228, 36_812],
};
const PREVIEW_ARGS = { content: [{ startId: "m0029", endId: "m0114", topic: PREVIEW_RECEIPT.topic, summary: "(summary)" }] };

/** Width of the list column, including the "→ " prefix. */
const LIST_WIDTH = 38;
const GAP = 2;
/**
 * The widest receipt line (before-after) is about 84 columns. Below this
 * total width the preview no longer fits beside the list, so it moves under it.
 */
const SIDE_BY_SIDE_MIN_WIDTH = LIST_WIDTH + GAP + 84;

/**
 * Build the preview lines for one style: collapsed view, then expanded receipt.
 * Headings get one leading space to line up with the card content, which the
 * card indents by its one-column padding.
 */
export function previewLines(style: ReceiptStyle, theme: ReceiptTheme, width: number): string[] {
  const result = { content: [], details: { notification: PREVIEW_RECEIPT } };
  return [
    theme.fg("muted", theme.bold(" Collapsed")),
    ...renderCompressCall(PREVIEW_ARGS, theme, { expanded: false }).render(width),
    ...renderCompressResult(result, style, theme, { expanded: false }).render(width),
    "",
    theme.fg("muted", theme.bold(" Expanded (Ctrl+O)")),
    ...renderCompressResult(result, style, theme, { expanded: true }).render(width),
  ];
}

/** The picker component. Exported for tests; use pickReceiptStyle from commands. */
export function createReceiptPicker(
  current: ReceiptStyle,
  theme: ReceiptTheme,
  requestRender: () => void,
  matches: (data: string, binding: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel") => boolean,
  done: (style: ReceiptStyle | undefined) => void,
): Component & { selected(): ReceiptStyle } {
  let index = Math.max(0, RECEIPT_STYLES.indexOf(current));
  return {
    selected: () => RECEIPT_STYLES[index],
    render(width: number): string[] {
      const list = [
        theme.fg("accent", theme.bold("Compress receipt style")),
        theme.fg("dim", "detailed notifications only"),
        "",
        ...RECEIPT_STYLES.map((style, position) => {
          const mark = style === current ? theme.fg("success", " ✓") : "";
          return position === index
            ? `${theme.fg("accent", "→ ")}${theme.fg("accent", RECEIPT_STYLE_LABELS[style])}${mark}`
            : `  ${theme.fg("text", RECEIPT_STYLE_LABELS[style])}${mark}`;
        }),
        "",
        theme.fg("dim", "↑↓ move · enter select · esc back"),
      ];
      const sideBySide = width >= SIDE_BY_SIDE_MIN_WIDTH;
      const previewWidth = sideBySide ? width - LIST_WIDTH - GAP : width;
      const preview = previewLines(RECEIPT_STYLES[index], theme, previewWidth);
      if (!sideBySide) return [...list, "", ...preview].map((line) => truncateToWidth(line, width));
      // Zip the two columns. The list is padded to a fixed width so the preview
      // starts in the same column on every row.
      const rows = Math.max(list.length, preview.length);
      const out: string[] = [];
      for (let row = 0; row < rows; row++) {
        const left = truncateToWidth(list[row] ?? "", LIST_WIDTH);
        const padded = left + " ".repeat(Math.max(0, LIST_WIDTH - visibleWidth(left)) + GAP);
        out.push(truncateToWidth(padded + (preview[row] ?? ""), width));
      }
      return out;
    },
    handleInput(data: string): void {
      if (matches(data, "tui.select.up")) index = (index - 1 + RECEIPT_STYLES.length) % RECEIPT_STYLES.length;
      else if (matches(data, "tui.select.down")) index = (index + 1) % RECEIPT_STYLES.length;
      else if (matches(data, "tui.select.confirm")) { done(RECEIPT_STYLES[index]); return; }
      else if (matches(data, "tui.select.cancel")) { done(undefined); return; }
      else return;
      requestRender();
    },
    // Stateless rendering: every render() rebuilds from the live theme.
    invalidate(): void {},
  };
}

/**
 * Ask for a receipt style. Returns undefined when the user goes back.
 * Outside the interactive TUI, a custom component cannot be shown, so this
 * falls back to the plain select list without a preview.
 */
export async function pickReceiptStyle(ctx: ExtensionCommandContext, current: ReceiptStyle): Promise<ReceiptStyle | undefined> {
  if (ctx.mode !== "tui") {
    const value = await ctx.ui.select("Compress receipt style (detailed notifications only)", [...Object.values(RECEIPT_STYLE_LABELS), "Back"]);
    return RECEIPT_STYLES.find((style) => RECEIPT_STYLE_LABELS[style] === value);
  }
  return ctx.ui.custom<ReceiptStyle | undefined>((tui, theme, keybindings, done) =>
    createReceiptPicker(current, theme, () => tui.requestRender(), (data, binding) => keybindings.matches(data, binding), done));
}
