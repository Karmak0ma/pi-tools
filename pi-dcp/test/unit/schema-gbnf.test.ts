import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import { CompressionParametersV2, isCompressionParams, normalizeCompressionParams } from "../../src/compression/schema.ts";

describe("GBNF-safe compression schema", () => {
  it("contains no backslash-digit grammar escapes", () => {
    expect(JSON.stringify(CompressionParametersV2)).not.toContain("\\\\d");
  });

  it("keeps the five-character alias contract", () => {
    const pattern = new RegExp((CompressionParametersV2 as any).properties.content.items.properties.startId.pattern);
    expect(["m0001", "b0001", "m9999"].every((id) => pattern.test(id))).toBe(true);
    expect(["m1", "b1", "m00001", "m000x", "m-001", ""].some((id) => pattern.test(id))).toBe(false);
  });

  it("bounds a per-range topic like the call topic, in the Typebox schema and the runtime check", () => {
    const range = (topic: unknown) => ({ content: [{ startId: "m0001", endId: "m0001", summary: "done", topic }] });
    for (const good of ["Phase A", "x".repeat(120)]) {
      expect(isCompressionParams(range(good))).toBe(true);
      expect(Check(CompressionParametersV2, range(good))).toBe(true);
    }
    for (const bad of ["", "x".repeat(121), 7]) {
      expect(isCompressionParams(range(bad))).toBe(false);
      expect(Check(CompressionParametersV2, range(bad))).toBe(false);
    }
  });

  it("allows the model to omit the display-only topic", () => {
    const params = { content: [{ startId: "m0001", endId: "m0001", summary: "completed work" }] };

    expect(isCompressionParams(params)).toBe(true);
    expect(normalizeCompressionParams(params)).toMatchObject({ topic: "Compressed context", content: params.content });
  });
});
