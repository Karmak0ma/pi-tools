import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/util/canonical-json.ts";

describe("bounded utility scaling", () => {
  it("handles a deterministic large canonical payload", () => { const input = Array.from({ length: 2000 }, (_, index) => ({ index, text: "x".repeat(20) })); const started = performance.now(); const output = canonicalJson(input); expect(output.length).toBeGreaterThan(40_000); expect(performance.now() - started).toBeLessThan(1000); });
});
