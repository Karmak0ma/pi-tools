import { describe, expect, it } from "vitest";
import { validateConfig } from "../../src/config/schema.ts";
import { loadConfig } from "../../src/config/load.ts";
import { defaults } from "../../src/config/defaults.ts";
import { PI_BUILTIN_TOOLS, PRUNE_PROTECTED_TOOLS } from "../../src/compression/protected.ts";

describe("configuration", () => {
  it("rejects excluded settings and supports percentages", () => { expect(validateConfig({ compress: { mode: "message" } }).error).toContain("unsupported"); const result = validateConfig({ compress: { maxContextLimit: "80%" } }); expect(result.error).toBeUndefined(); expect(result.value?.compress.maxContextLimit).toBe("80%"); });
  it("does not read project layers when untrusted", async () => { const result = await loadConfig("/path/that/does/not/exist", false, { PI_CODING_AGENT_DIR: "/path/that/does/not/exist" }); expect(result.paths).toEqual([]); });
  it("uses conservative opencode-dcp-inspired defaults", () => { expect(defaults.enabled).toBe(true); expect(defaults.compress.permission).toBe("allow"); expect(defaults.nudge).toEqual({ minContextPercent: 35, maxContextPercent: 70, criticalContextPercent: 90, turnsBetweenNudges: 5, turnNudgeFrequency: 5, iterationNudgeThreshold: 15, minPotentialSavingsTokens: 32000 }); expect([...PI_BUILTIN_TOOLS]).toEqual(["read", "write", "edit", "bash", "grep", "find", "ls"]); expect([...PRUNE_PROTECTED_TOOLS]).toEqual(["compress", "write", "edit", "todo"]); expect(defaults.commands.protectedTools).toEqual(["compress", "write", "edit", "todo"]); expect(defaults.compress.protectedTools).toEqual(["todo"]); expect(defaults.strategies.deduplication.enabled).toBe(true); expect(defaults.strategies.purgeErrors.turns).toBe(4); });
});
