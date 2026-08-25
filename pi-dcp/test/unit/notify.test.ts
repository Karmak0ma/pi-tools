import { describe, expect, it } from "vitest";
import { defaults } from "../../src/config/defaults.ts";
import { formatNotification, renderCompressionNotification, type CompressionNotification } from "../../src/ui/notify.ts";

const compression: CompressionNotification = {
  action: "compressed",
  topic: "notification mockup research",
  count: 1,
  estimatedTokens: 18_400,
  confidence: "heuristic",
  compressionCount: 7,
  toolCount: 12,
  messageCount: 8,
  contextPercent: 14.4,
  sessionTotalTokens: 94_200,
};

describe("compression notifications", () => {
  it("formats option 3 as plain text with all requested metrics", () => {
    const text = formatNotification(defaults as any, compression);

    expect(text).toContain("✓ Compression #7  notification mockup research");
    expect(text).toContain("14% reclaimed");
    expect(text).toContain("this call 18,400 tokens from 12 tools / 8 messages");
    expect(text).toContain("94,200 tokens compressed total");
    expect(text).toMatch(/context\s+\[█{27}░{5}\]/);
  });

  it("does not include ANSI escapes in the model-visible text", () => {
    const text = formatNotification(defaults as any, compression) || "";
    expect(text).not.toContain("\u001b[");
  });

  it("respects notification off", () => {
    expect(formatNotification({ ...defaults, pruneNotification: "off" } as any, compression)).toBeUndefined();
  });

  it("renders the same receipt through the supplied live theme", () => {
    const calls: string[] = [];
    const theme = {
      fg(color: string, text: string) {
        calls.push(color);
        return `<${color}>${text}</${color}>`;
      },
      bold(text: string) {
        calls.push("bold");
        return `<bold>${text}</bold>`;
      },
    } as any;

    const lines = renderCompressionNotification(compression, theme).render(240).join("\n");

    expect(lines).toContain("Compression #7");
    expect(lines).toContain("notification mockup research");
    expect(lines).toContain("18,400 tokens");
    expect(lines).toContain("12 tools / 8 messages");
    expect(lines).toContain("94,200 tokens compressed total");
    expect(calls).toContain("success");
    expect(calls).toContain("accent");
    expect(calls).toContain("toolOutput");
    expect(calls).toContain("muted");

    const alternateTheme = {
      fg: (color: string, text: string) => `[alternate:${color}]${text}[/alternate]`,
      bold: (text: string) => text,
    } as any;
    const alternateLines = renderCompressionNotification(compression, alternateTheme).render(240).join("\n");
    expect(alternateLines).toContain("[alternate:success]");
    expect(alternateLines).not.toBe(lines);
  });

  it("falls back safely when the context window is unavailable", () => {
    const item = { ...compression, contextPercent: undefined };
    const text = formatNotification(defaults as any, item) || "";

    expect(text).toContain("context  [?]");
    expect(text).toContain("? reclaimed");
  });
});
