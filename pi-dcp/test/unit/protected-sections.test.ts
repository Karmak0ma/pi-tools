import { describe, expect, it } from "vitest";
import { appendProtectedSections, extractProtectedSection } from "../../src/compression/protected.ts";

// The persisted intro text. Changing it would hide protected output that older blocks already store.
const INTRO = "\n\nThe following protected tool output was part of this range and is preserved verbatim:";
const body = (name: string, text: string) => `\n### Tool: ${name}\n${text}`;

describe("protected output carry-forward", () => {
  it("appends bodies once after the authored text and reads back the exact body", () => {
    // A header line inside tool output must survive: bodies are never split.
    const todo = body("todo", "A");
    const read = body("read", "B\n### Tool: x\nC");
    const summary = appendProtectedSections("Authored.", [todo, read]);
    expect(summary).toBe(`Authored.${INTRO}${todo}${read}`);
    expect(extractProtectedSection({ summary, authoredSummary: "Authored." })).toBe(todo + read);
  });

  it("does not repeat an identical body that an earlier source already carried", () => {
    const todo = body("todo", "A");
    const summary = appendProtectedSections("Authored.", [todo, todo, body("read", "B")]);
    expect(summary.split(todo).length - 1).toBe(1);
    expect(summary).toContain(body("read", "B"));
  });

  it("locates the appended body by position, so authored text that quotes the intro is not mistaken for it", () => {
    const authored = `Discussed the marker:${INTRO}\nnot a section.`;
    const summary = appendProtectedSections(authored, [body("todo", "A")]);
    expect(extractProtectedSection({ summary, authoredSummary: authored })).toBe(body("todo", "A"));
  });

  it("finds nothing in a summary without protected output", () => {
    expect(extractProtectedSection({ summary: "Plain.", authoredSummary: "Plain." })).toBe("");
    expect(appendProtectedSections("Plain.", [""])).toBe("Plain.");
  });

  it("keeps protected output of a legacy summary that pasted child text (over-carry, never loss)", () => {
    // Legacy blocks do not start with their authored text, so the first intro is used.
    const legacy = `[DCP nested summary]\nChild.${INTRO}${body("todo", "A")}\n\nParent text.`;
    expect(extractProtectedSection({ summary: legacy, authoredSummary: "Parent (b0001)." })).toContain(body("todo", "A"));
  });
});
