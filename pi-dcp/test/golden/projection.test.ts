import { describe, expect, it } from "vitest";
import { projectContextEntries } from "../../src/identity/project.ts";
import { buildProtocolUnits } from "../../src/identity/protocol.ts";

const timestamp = new Date(1).toISOString();
const systemMessage = {
  role: "system",
  content: "",
  sections: { guidance: "Current instructions" },
  toolsAdded: [{ name: "compress", description: "Compress context", parameters: { type: "object" } }],
  timestamp: 1,
};

describe("Pi session projection adapter", () => {
  it("projects legacy compaction to one summary and ignores retainedTail metadata", () => {
    const result = projectContextEntries([{
      type: "compaction",
      id: "c",
      parentId: null,
      timestamp,
      summary: "old",
      firstKeptEntryId: "m",
      tokensBefore: 20,
      details: { retainedTail: [{ role: "user", content: "must not invent" }] },
    } as any]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].message.role).toBe("compactionSummary");
    }
  });

  it("ignores Pi 0.86 usage entries because Pi excludes them from model context", () => {
    const result = projectContextEntries([{
      type: "usage",
      id: "usage-1",
      parentId: null,
      timestamp,
      kind: "cache_warm",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      usage: {},
    } as any]);

    expect(result).toMatchObject({ ok: true, messages: [] });
  });

  it("projects Pi 0.86 persisted system messages", () => {
    const result = projectContextEntries([{
      type: "message",
      id: "system-1",
      parentId: null,
      timestamp,
      message: systemMessage,
    } as any]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messages.map((item) => item.message)).toEqual([systemMessage]);
      const index = buildProtocolUnits(result.messages);
      expect("units" in index && index.units[0]).toMatchObject({ role: "system", compressible: false });
    }
  });

  it("matches Pi's null-content normalization for legacy persisted messages", () => {
    const result = projectContextEntries([
      { type: "message", id: "system-null", parentId: null, timestamp, message: { role: "system", content: null, timestamp: 1 } },
      { type: "message", id: "user-null", parentId: "system-null", timestamp, message: { role: "user", content: null, timestamp: 2 } },
      { type: "message", id: "assistant-null", parentId: "user-null", timestamp, message: { role: "assistant", content: null, timestamp: 3 } },
      { type: "message", id: "tool-null", parentId: "assistant-null", timestamp, message: { role: "toolResult", toolCallId: "call-1", toolName: "read", content: null, isError: false, timestamp: 4 } },
    ] as any);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messages.map((item) => ({ role: item.message.role, content: "content" in item.message ? item.message.content : undefined }))).toEqual([
        { role: "system", content: "" },
        { role: "user", content: [] },
        { role: "toolResult", content: [] },
      ]);
      expect(result.unprojectedEntryIds).toContain("assistant-null");
    }
  });

  it("projects a Pi 0.86 compaction system snapshot before its summary", () => {
    const result = projectContextEntries([{
      type: "compaction",
      id: "compact-1",
      parentId: null,
      timestamp,
      summary: "old context",
      firstKeptEntryId: "m",
      tokensBefore: 20,
      systemMessage,
    } as any]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messages.map((item) => item.message.role)).toEqual(["system", "compactionSummary"]);
      expect(result.messages[0].message).toEqual(systemMessage);
    }
  });
});
