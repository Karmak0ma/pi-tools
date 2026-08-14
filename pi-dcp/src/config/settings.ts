import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { EffectiveConfig } from "./defaults.ts";

export interface SettingsPatch {
  enabled: boolean;
  commands: Pick<EffectiveConfig["commands"], "enabled">;
  nudge: EffectiveConfig["nudge"];
  compress: Pick<EffectiveConfig["compress"], "permission" | "protectUserMessages" | "protectedTools">;
  manualMode: Pick<EffectiveConfig["manualMode"], "enabled" | "automaticStrategies">;
  turnProtection: EffectiveConfig["turnProtection"];
  pruneNotification: EffectiveConfig["pruneNotification"];
  pruneNotificationType: EffectiveConfig["pruneNotificationType"];
  protectedFilePatterns: string[];
}

export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const agentDir = env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, "dcp_settings.json");
}

export function settingsPatch(config: EffectiveConfig): SettingsPatch {
  return {
    enabled: config.enabled,
    commands: { enabled: config.commands.enabled },
    nudge: { ...config.nudge },
    compress: {
      permission: config.compress.permission,
      protectUserMessages: config.compress.protectUserMessages,
      protectedTools: [...config.compress.protectedTools],
    },
    manualMode: { enabled: config.manualMode.enabled, automaticStrategies: config.manualMode.automaticStrategies },
    turnProtection: { ...config.turnProtection },
    pruneNotification: config.pruneNotification,
    pruneNotificationType: config.pruneNotificationType,
    protectedFilePatterns: [...config.protectedFilePatterns],
  };
}

export async function writeSettings(config: EffectiveConfig, path = settingsPath()): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  let existing: unknown = {};
  try { existing = JSON.parse(await readFile(path, "utf8")); } catch { /* create a new settings file */ }
  const document = mergeSettings(existing, settingsPatch(config));
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

function mergeSettings(existing: unknown, patch: SettingsPatch): Record<string, unknown> { const base = existing && typeof existing === "object" && !Array.isArray(existing) ? structuredClone(existing) as Record<string, unknown> : {}; if (base.nudge && typeof base.nudge === "object" && !Array.isArray(base.nudge)) delete (base.nudge as Record<string, unknown>).type; for (const [key, value] of Object.entries(patch)) { if (value && typeof value === "object" && !Array.isArray(value) && base[key] && typeof base[key] === "object" && !Array.isArray(base[key])) base[key] = { ...(base[key] as Record<string, unknown>), ...value }; else base[key] = value; } return base; }
