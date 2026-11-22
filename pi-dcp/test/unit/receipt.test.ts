import { beforeAll, describe, expect, it } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { validateConfig } from "../../src/config/schema.ts";
import type { CompressionNotification } from "../../src/ui/notify.ts";
import { drawBar, effectiveStyle, renderCompressCall, renderCompressResult, type ReceiptTheme } from "../../src/ui/receipt.ts";
import { buildContextLayout, compressionHistory } from "../../src/ui/receipt-data.ts";
import { createReceiptPicker } from "../../src/ui/receipt-picker.ts";
import { emptyState, type ReducedBlock } from "../../src/state/reducer.ts";
import type { ProjectedMessage, ProtocolUnit } from "../../src/identity/types.ts";

// Markdown in renderCompressCall reads Pi's global theme.
beforeAll(() => initTheme("dark"));

/** Theme that leaves text unchanged, so widths can be measured. */
const plain: ReceiptTheme = { fg: (_color, text) => text, bold: (text) => text, bg: (_color, text) => text } as ReceiptTheme;
/** Theme that tags every cell with its color, so bar segments can be read back. */
const tagging: ReceiptTheme = { fg: (color, text) => [...text].map((ch) => `${color}:${ch}|`).join(""), bold: (text) => text, bg: (_color, text) => text } as ReceiptTheme;
const cellColors = (bar: string) => bar.split("|").filter(Boolean).map((cell) => cell.slice(0, cell.lastIndexOf(":")));

const receipt: CompressionNotification = {
  action: "compressed", topic: "Merge main", count: 1, estimatedTokens: 36_812, confidence: "heuristic",
  compressionCount: 3, toolCount: 12, messageCount: 41, contextPercent: 18.4, sessionTotalTokens: 92_340,
  contextWindow: 200_000, usageBeforeTokens: 128_600,
  layout: [{ kind: "system", tokens: 9_000 }, { kind: "history", tokens: 40_000 }, { kind: "summary", tokens: 2_000 }, { kind: "summary", tokens: 1_500 }, { kind: "history", tokens: 39_288 }],
  history: [21_300, 34_228, 36_812],
};
const result = (notification?: CompressionNotification, extra: Record<string, unknown> = {}) => ({ content: [{ type: "text", text: "pi-dcp compressed 1 range(s)." }], details: { notification, ...extra } });

describe("drawBar", () => {
  it("always fills exactly the requested width", () => {
    for (const width of [8, 24, 40]) {
      const bar = drawBar([{ tokens: 91_788, color: "accent" }, { tokens: 36_812, color: "success" }], 200_000, width, plain, true);
      expect(visibleWidth(bar)).toBe(width);
    }
  });

  it("keeps a tiny summary visible instead of rounding it away", () => {
    const bar = drawBar([{ tokens: 50_000, color: "accent" }, { tokens: 100, color: "customMessageLabel", minCell: true }], 200_000, 40, tagging);
    expect(cellColors(bar)).toContain("customMessageLabel");
    expect(cellColors(bar)).toHaveLength(40);
  });
});

describe("receipt styles", () => {
  it("falls back to simple without usage data, and full to regained without a layout", () => {
    expect(effectiveStyle({ ...receipt, usageBeforeTokens: undefined }, "full")).toBe("simple");
    expect(effectiveStyle({ ...receipt, layout: undefined }, "full")).toBe("regained");
    expect(effectiveStyle(receipt, "before-after")).toBe("before-after");
  });

  it("renders every style collapsed as one line and expanded with the stats table", () => {
    for (const style of ["simple", "before-after", "regained", "full"] as const) {
      const collapsed = renderCompressResult(result(receipt), style, plain, { expanded: false }).render(120);
      // One content line plus the card's bottom padding.
      expect(collapsed).toHaveLength(2);
      expect(collapsed[0]).toContain("✓");
      const expanded = renderCompressResult(result(receipt), style, plain, { expanded: true }).render(120).join("\n");
      expect(expanded).toContain("CONTEXT COMPRESSED · #3");
      expect(expanded).toContain("36,812");
      expect(expanded).toContain("92,340");
    }
  });

  it("colors the before/after bars by usage level like the sidebar", () => {
    const lines = renderCompressResult(result(receipt), "before-after", tagging, { expanded: true }).render(400).join("\n");
    // 64.3% before is above 60% (red); 45.9% after is above 40% (yellow).
    expect(lines).toContain("error:█");
    expect(lines).toContain("warning:█");
  });

  it("draws the full layout in order with summaries and savings", () => {
    const lines = renderCompressResult(result(receipt), "full", tagging, { expanded: true }).render(1000);
    const bar = lines.find((line) => line.includes("customMessageLabel:"))!;
    const colors = cellColors(bar.slice(bar.indexOf("muted:█"))).filter((color, index, all) => index === 0 || color !== all[index - 1]);
    expect(colors.slice(0, 5)).toEqual(["muted", "warning", "customMessageLabel", "warning", "success"]);
    // The two adjacent summaries stay distinct through alternating glyphs.
    expect(bar).toContain("customMessageLabel:█");
    expect(bar).toContain("customMessageLabel:▓");
  });

  it("shows a rejected call with its reason instead of a receipt", () => {
    const lines = renderCompressResult({ content: [{ type: "text", text: "Range m0001 is BLOCKED.\nUse m0002." }], details: { reason: "range_blocked" } }, "regained", plain, { expanded: false }).render(120).join("\n");
    expect(lines).toContain("Compression rejected");
    expect(lines).toContain("range_blocked");
    expect(lines).not.toContain("Use m0002.");
  });
});

describe("renderCompressCall", () => {
  const args = { content: [{ startId: "m0029", endId: "m0114", topic: "Merge main", summary: "Merged **main**.\n\n- kept `reducer.ts`\n- took schema", recall: ["vitest output"] }] };

  it("shows the range and topic on one header line when collapsed", () => {
    const lines = renderCompressCall(args, plain, { expanded: false }).render(120);
    expect(lines.join("\n")).toContain("m0029 → m0114  Merge main");
    expect(lines.join("\n")).not.toContain("kept");
  });

  it("renders the summary as Markdown with real line breaks when expanded", () => {
    const text = renderCompressCall(args, plain, { expanded: true }).render(120).join("\n");
    expect(text).not.toContain("\\n");
    expect(text).toMatch(/kept .*reducer\.ts/);
    expect(text).toContain("vitest output");
  });

  it("tolerates partial arguments while the call is still streaming", () => {
    expect(() => renderCompressCall({ content: [{ startId: "m00" }] }, plain, { expanded: true }).render(80)).not.toThrow();
    expect(() => renderCompressCall(undefined, plain, { expanded: false }).render(80)).not.toThrow();
  });
});

describe("receipt data", () => {
  const message = (text: string) => ({ role: "user", content: text, timestamp: 0 }) as any;
  const entries: ProjectedMessage[] = ["a".repeat(400), "b".repeat(400), "c".repeat(400), "d".repeat(400)].map((text, index) => ({ key: { kind: "entry", entryId: `e${index}`, projection: 0 }, message: message(text), fingerprint: `f${index}`, toolCallIds: [] }));
  const units = entries.map((entry, index) => ({ key: `u${index}`, entryIds: [entry.key.entryId], messageKeys: [entry.key], toolCallIds: [], startProjectedIndex: index, endProjectedIndex: index, settled: true, compressible: true, role: "user", descriptor: "user intent" })) as ProtocolUnit[];
  const block = (id: string, entryIds: string[], summaryTokens: number, savings: number): ReducedBlock => ({ blockId: id, estimatedSummaryTokens: summaryTokens, estimatedSavingsTokens: savings, active: true, available: true, coverage: { directEntryIds: entryIds, effectiveEntryIds: entryIds, directToolCallIds: [], effectiveToolCallIds: [] } } as unknown as ReducedBlock);

  it("interleaves history and summaries in order, adds the system part, and scales to the target", () => {
    const state = emptyState();
    state.blocks.set("b1", block("b1", ["e1"], 10, 90));
    const layout = buildContextLayout({ units, entries, state, targetTokens: 1_000, systemFallbackTokens: () => 100 })!;
    expect(layout.map((segment) => segment.kind)).toEqual(["system", "history", "summary", "history"]);
    const total = layout.reduce((sum, segment) => sum + segment.tokens, 0);
    expect(Math.abs(total - 1_000)).toBeLessThanOrEqual(layout.length);
  });

  it("returns no layout when there is no usage to scale to", () => {
    expect(buildContextLayout({ units, entries, state: emptyState(), targetTokens: 0, systemFallbackTokens: () => 0 })).toBeUndefined();
  });

  it("lists savings per compression in apply order", () => {
    const state = emptyState();
    state.blocks.set("b1", block("b1", ["e1"], 10, 90));
    state.blocks.set("b2", block("b2", ["e2"], 10, 40));
    state.runs.set("r1", ["b1"]);
    state.runs.set("r2", ["b2"]);
    expect(compressionHistory(state)).toEqual([90, 40]);
  });
});

describe("receiptStyle setting", () => {
  it("accepts the four styles and rejects others", () => {
    expect(validateConfig({ receiptStyle: "full" }).value?.receiptStyle).toBe("full");
    expect(validateConfig({ receiptStyle: "fancy" }).error).toMatch(/receiptStyle/);
    expect(validateConfig({}).value?.receiptStyle).toBe("regained");
  });
});

describe("receipt style picker", () => {
  const keys = { "tui.select.up": "UP", "tui.select.down": "DOWN", "tui.select.confirm": "ENTER", "tui.select.cancel": "ESC" } as const;
  const picker = (done: (style: unknown) => void = () => {}) => createReceiptPicker("regained", plain, () => {}, (data, binding) => data === keys[binding], done);

  it("shows the preview beside the list on a wide terminal and below it on a narrow one", () => {
    const wide = picker().render(140);
    // The list and the preview share rows: a list entry and a bar on one line.
    expect(wide.some((line) => line.includes("simple —") && line.includes("✓ "))).toBe(true);
    expect(wide.every((line) => visibleWidth(line) <= 140)).toBe(true);
    const narrow = picker().render(70);
    expect(narrow.findIndex((line) => line.includes("Collapsed"))).toBeGreaterThan(narrow.findIndex((line) => line.includes("full —")));
    expect(narrow.every((line) => visibleWidth(line) <= 70)).toBe(true);
  });

  it("updates the preview while moving and returns the chosen style", () => {
    let chosen: unknown = "unset";
    const component = picker((style) => { chosen = style; });
    component.handleInput!("DOWN");
    expect(component.selected()).toBe("full");
    expect(component.render(140).join("\n")).toContain("summaries");
    component.handleInput!("ENTER");
    expect(chosen).toBe("full");
    const cancelled = picker((style) => { chosen = style; });
    cancelled.handleInput!("ESC");
    expect(chosen).toBeUndefined();
  });
});
