import { describe, expect, it } from "vitest";
import { projectContextEntries } from "../../src/identity/project.ts";

describe("Pi 0.84.1 projection adapter", () => {
  it("projects compaction to one summary and ignores retainedTail metadata", () => { const result = projectContextEntries([{ type: "compaction", id: "c", parentId: null, timestamp: new Date(1).toISOString(), summary: "old", firstKeptEntryId: "m", tokensBefore: 20, details: { retainedTail: [{ role: "user", content: "must not invent" }] } } as any]); expect(result.ok).toBe(true); if (result.ok) { expect(result.messages).toHaveLength(1); expect(result.messages[0].message.role).toBe("compactionSummary"); } });
});
