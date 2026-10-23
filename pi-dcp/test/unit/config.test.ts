import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isEnabledForModel } from "../../src/config/models.ts";
import { describe, expect, it } from "vitest";
import { validateConfig } from "../../src/config/schema.ts";
import { loadConfig } from "../../src/config/load.ts";
import { defaults } from "../../src/config/defaults.ts";
import { PI_BUILTIN_TOOLS, PRUNE_PROTECTED_TOOLS } from "../../src/compression/protected.ts";

describe("configuration", () => {
  it("validates exact provider/model identifiers and defaults to all models enabled", () => {
    expect(defaults.disabledModels).toEqual([]);
    for (const disabledModels of ["test/model", [1], ["model"], ["/model"], ["test/"], ["test/model name"]]) {
      expect(validateConfig({ disabledModels }).error).toBeDefined();
    }
    const config = validateConfig({ disabledModels: ["test/vendor/model", "test/vendor/model"] }).value!;
    expect(config.disabledModels).toEqual(["test/vendor/model"]);
    expect(isEnabledForModel(config, { provider: "test", id: "vendor/model" })).toBe(false);
    expect(isEnabledForModel(config, { provider: "other", id: "vendor/model" })).toBe(true);
    expect(isEnabledForModel(config, { provider: "test", id: "vendor/model-new" })).toBe(true);
    expect(isEnabledForModel({ ...config, enabled: false }, { provider: "other", id: "model" })).toBe(false);
  });

  it("loads model exclusions from extension files and replaces lists in higher-priority layers", async () => {
    const root = await mkdtemp(join(tmpdir(), "dcp-model-config-"));
    const agent = join(root, "agent");
    const project = join(root, "project");
    try {
      await mkdir(agent);
      await mkdir(join(project, ".pi"), { recursive: true });
      await writeFile(join(agent, "dcp.jsonc"), '{ // global policy\n "disabledModels": ["test/global"] }');
      await writeFile(join(project, ".pi", "dcp.json"), JSON.stringify({ disabledModels: ["test/project"] }));
      const env = { PI_CODING_AGENT_DIR: agent };
      expect((await loadConfig(project, false, env)).config.disabledModels).toEqual(["test/global"]);
      expect((await loadConfig(project, true, env)).config.disabledModels).toEqual(["test/project"]);
      await writeFile(join(agent, "dcp_settings.json"), '{"disabledModels": []}');
      expect((await loadConfig(project, true, env)).config.disabledModels).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("rejects excluded settings and supports percentages", () => { expect(validateConfig({ compress: { mode: "message" } }).error).toContain("unsupported"); const result = validateConfig({ compress: { maxContextLimit: "80%" } }); expect(result.error).toBeUndefined(); expect(result.value?.compress.maxContextLimit).toBe("80%"); });
  it("does not read project layers when untrusted", async () => { const result = await loadConfig("/path/that/does/not/exist", false, { PI_CODING_AGENT_DIR: "/path/that/does/not/exist" }); expect(result.paths).toEqual([]); });
  it("uses conservative opencode-dcp-inspired defaults", () => { expect(defaults.enabled).toBe(true); expect(defaults.compress.permission).toBe("allow"); expect(defaults.nudge).toEqual({ minContextPercent: 35, maxContextPercent: 70, criticalContextPercent: 90, turnsBetweenNudges: 5, turnNudgeFrequency: 5, iterationNudgeThreshold: 15, minPotentialSavingsTokens: 32000 }); expect([...PI_BUILTIN_TOOLS]).toEqual(["read", "write", "edit", "bash", "grep", "find", "ls"]); expect([...PRUNE_PROTECTED_TOOLS]).toEqual(["compress", "write", "edit", "todo"]); expect(defaults.commands.protectedTools).toEqual(["compress", "write", "edit", "todo"]); expect(defaults.compress.protectedTools).toEqual(["todo"]); expect(defaults.strategies.deduplication.enabled).toBe(true); expect(defaults.strategies.purgeErrors.turns).toBe(4); });
});
