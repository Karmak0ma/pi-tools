import { describe, expect, it } from "vitest";
import { CompressionParametersV2 } from "../../src/compression/schema.ts";

describe("GBNF-safe compression schema", () => {
  it("contains no backslash-digit grammar escapes", () => {
    expect(JSON.stringify(CompressionParametersV2)).not.toContain("\\\\d");
  });

  it("keeps the five-character alias contract", () => {
    const pattern = new RegExp((CompressionParametersV2 as any).properties.content.items.properties.startId.pattern);
    expect(["m0001", "b0001", "m9999"].every((id) => pattern.test(id))).toBe(true);
    expect(["m1", "b1", "m00001", "m000x", "m-001", ""].some((id) => pattern.test(id))).toBe(false);
  });
});
