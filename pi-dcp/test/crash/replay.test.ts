import { describe, expect, it } from "vitest";
import { reconstructFromBranch } from "../../src/state/reconstruct.ts";

describe("best effort crash replay", () => {
  it("fails closed on a malformed operation tail", () => { const result = reconstructFromBranch([{ type: "custom", id: "x", parentId: null, timestamp: new Date(1).toISOString(), customType: "pi-dcp.operation", data: { schema: 99 } } as any]); expect(result.state.corruptReason).toBe("state_schema_unknown"); });
});
