import { describe, expect, it } from "vitest";
import { buildSessionProjection } from "@earendil-works/pi-coding-agent";
import { projectHostSessionProjection } from "../../src/identity/project.ts";
import { projectCurrentEntries } from "../helpers/current-host.ts";
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
    const result = projectCurrentEntries([{
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

  it("ignores usage entries because Pi excludes them from model context", () => {
    const result = projectCurrentEntries([{
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

  it("projects persisted system messages", () => {
    const result = projectCurrentEntries([{
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
    const result = projectCurrentEntries([
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

  it("projects a compaction system snapshot before its summary", () => {
    const result = projectCurrentEntries([{
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

  it("adapts Pi 0.87 context edits with target provenance", () => {
    const entries = [
      { type: "message", id: "user-1", parentId: null, timestamp: new Date(1).toISOString(), message: { role: "user", content: "question", timestamp: 1 } },
      { type: "message", id: "assistant-1", parentId: "user-1", timestamp: new Date(2).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "original" }], api: "test", provider: "test", model: "model", stopReason: "stop", timestamp: 2 } },
      { type: "context_edit", id: "edit-omit", parentId: "assistant-1", timestamp: new Date(3).toISOString(), targetId: "assistant-1", replacement: null },
      { type: "context_edit", id: "edit-replace", parentId: "edit-omit", timestamp: new Date(4).toISOString(), targetId: "assistant-1", replacement: { content: [{ type: "text", text: "edited" }] } },
    ] as any;
    const host = buildSessionProjection(entries, "edit-replace");
    const result = projectHostSessionProjection(() => host);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.messages.map((item) => item.key.entryId)).toEqual(["user-1", "assistant-1"]);
      expect(result.messages[1].message).toMatchObject({ role: "assistant", content: [{ type: "text", text: "edited" }] });
      expect(result.messages.some((item) => item.key.entryId === "edit-replace")).toBe(false);
    }
  });

  it("fails closed when a host projection loses source/message alignment", () => {
    const result = projectHostSessionProjection(() => ({
      entries: [{ sourceEntry: { type: "message", id: "user-1", parentId: null, timestamp, message: { role: "user", content: "question", timestamp: 1 } }, messages: [{ role: "user", content: "question", timestamp: 1 }] }],
      messages: [],
    }));

    expect(result).toEqual({ ok: false, reason: "projection_unsupported" });
  });

  it("compares flat host messages by content when they are not the per-entry objects", () => {
    // Pi normally shares objects between `entries[].messages` and `messages`,
    // which lets DCP skip a second fingerprint. A host that copies them must
    // still be checked by content, in both directions.
    const message = { role: "user", content: "question", timestamp: 1 };
    const host = (flat: unknown) => ({ entries: [{ sourceEntry: { type: "message", id: "user-1", parentId: null, timestamp, message }, messages: [message] }], messages: [flat] });

    expect(projectHostSessionProjection(() => host(structuredClone(message))).ok).toBe(true);
    expect(projectHostSessionProjection(() => host({ ...message, content: "changed" }))).toEqual({ ok: false, reason: "projection_unsupported" });
  });
});
