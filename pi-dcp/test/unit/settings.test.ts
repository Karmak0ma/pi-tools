import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/load.ts";
import { settingsPath, writeSettings } from "../../src/config/settings.ts";
import { defaults, type EffectiveConfig } from "../../src/config/defaults.ts";
import { evaluateNudge, shouldNudge } from "../../src/transform/metadata.ts";

describe("personal DCP settings", () => {
  it("loads dcp_settings.json after normal configuration layers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-dcp-settings-"));
    try {
      await writeFile(settingsPath({ PI_CODING_AGENT_DIR: dir }), JSON.stringify({ nudge: { minContextPercent: 60, maxContextPercent: 70, criticalContextPercent: 90, turnsBetweenNudges: 3 } }));
      const loaded = await loadConfig(join(dir, "project"), false, { PI_CODING_AGENT_DIR: dir });
      expect(loaded.config.nudge).toEqual({ minContextPercent: 60, maxContextPercent: 70, criticalContextPercent: 90, turnsBetweenNudges: 3 });
      expect(loaded.paths).toContain(join(dir, "dcp_settings.json"));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("ignores and removes the obsolete nudge severity setting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-dcp-settings-"));
    try {
      const path = join(dir, "dcp_settings.json");
      await writeFile(path, JSON.stringify({ nudge: { type: "hard", minContextPercent: 40 } }));
      await writeSettings(defaults as unknown as EffectiveConfig, path);
      const parsed = JSON.parse(await readFile(path, "utf8"));
      expect(parsed.nudge.type).toBeUndefined();
      const loaded = await loadConfig(join(dir, "project"), false, { PI_CODING_AGENT_DIR: dir });
      expect(loaded.config.nudge.minContextPercent).toBe(35);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("writes a private, editable settings document", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-dcp-settings-"));
    try {
      const path = join(dir, "dcp_settings.json");
      await writeSettings(defaults as unknown as EffectiveConfig, path);
      const parsed = JSON.parse(await readFile(path, "utf8"));
      expect(parsed.nudge).toEqual({ minContextPercent: 35, maxContextPercent: 70, criticalContextPercent: 90, turnsBetweenNudges: 5 });
      expect(parsed.compress.permission).toBe("allow");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("uses the configured interval between below-maximum nudges and imperative nudges at maximum", () => {
    const config = structuredClone(defaults) as unknown as EffectiveConfig;
    config.nudge = { minContextPercent: 35, maxContextPercent: 70, criticalContextPercent: 90, turnsBetweenNudges: 3 };
    expect(shouldNudge(300, config, 1000, 3)).toBeUndefined();
    expect(shouldNudge(400, config, 1000, 1)).toBeUndefined();
    expect(shouldNudge(400, config, 1000, 3)?.type).toBe("soft");
    expect(shouldNudge(700, config, 1000, 0)?.type).toBe("imperative");
    expect(shouldNudge(900, config, 1000, 0)?.type).toBe("critical");
    expect(evaluateNudge(400, config, 1000, 1).reason).toBe("interval_not_elapsed");
    expect(evaluateNudge(null, config, 1000).reason).toBe("usage_unavailable");
    expect(evaluateNudge(400, config, 1000, 3, true).reason).toBe("already_nudged_this_turn");
  });
});
