import { describe, expect, it } from "vitest";
import { extractPaths, isProtectedTool } from "../../src/compression/protected.ts";
import { validateSummary } from "../../src/compression/validate.ts";
import { createLogger } from "../../src/observability/logger.ts";

describe("security boundaries", () => {
  it("handles cyclic arguments conservatively without logging their values", () => { const value: Record<string, unknown> = { path: "src/a.ts" }; value.self = value; expect(extractPaths(value, "/project")).toContain("/project/src/a.ts"); expect(isProtectedTool("todo", {}, { cwd: "/project" })).toBe(true); expect(isProtectedTool("read", {}, { cwd: "/project" })).toBe(false); expect(validateSummary("\u0000secret")).toEqual({ ok: false, reason: "summary_invalid" }); const lines: string[] = []; createLogger("0.1.0", (line) => lines.push(line)).diagnostic({ reason: "summary_invalid" }); expect(lines.join("\n")).not.toContain("secret"); });
});
