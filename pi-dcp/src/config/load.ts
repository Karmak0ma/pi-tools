import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { defaults, type EffectiveConfig } from "./defaults.ts";
import { validateConfig } from "./schema.ts";
import { settingsPath } from "./settings.ts";

export interface ConfigLoadResult { config: EffectiveConfig; warnings: string[]; paths: string[]; error?: string; }
interface Layer { jsonc: string; json: string; trusted: boolean; }

export async function loadConfig(cwd: string, trusted: boolean, env: NodeJS.ProcessEnv = process.env): Promise<ConfigLoadResult> {
  let config = structuredClone(defaults) as unknown as EffectiveConfig;
  const warnings: string[] = [];
  const paths: string[] = [];
  let error: string | undefined;
  const agentDir = env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const layers: Layer[] = [
    { jsonc: join(agentDir, "dcp.jsonc"), json: join(agentDir, "dcp.json"), trusted: true },
    { jsonc: join(cwd, CONFIG_DIR_NAME, "dcp.jsonc"), json: join(cwd, CONFIG_DIR_NAME, "dcp.json"), trusted },
  ];
  for (const layer of layers) {
    if (!layer.trusted) continue;
    const jsonc = await readOptional(layer.jsonc);
    const json = await readOptional(layer.json);
    if (jsonc !== undefined && json !== undefined) warnings.push(`JSONC layer wins over ${layer.json}`);
    const selected = jsonc === undefined ? (json === undefined ? undefined : { path: layer.json, text: json }) : { path: layer.jsonc, text: jsonc };
    if (!selected) continue;
    const errors: ParseError[] = [];
    const parsed = parse(selected.text, errors, { allowTrailingComma: true, disallowComments: false });
    if (errors.length) { error ||= `invalid configuration layer: ${selected.path}`; warnings.push(`invalid configuration layer ignored: ${selected.path}`); continue; }
    const result = validateConfig(parsed, config);
    warnings.push(...result.warnings.map((warning) => `${selected.path}: ${warning}`));
    if (result.error || !result.value) { error ||= `${selected.path}: ${result.error || "invalid configuration"}`; warnings.push(`${selected.path}: ${result.error || "invalid configuration"}`); continue; }
    config = result.value;
    paths.push(selected.path);
  }
  const personalPath = settingsPath(env);
  const personalText = await readOptional(personalPath);
  if (personalText !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(personalText); }
    catch { error ||= `invalid settings file: ${personalPath}`; warnings.push(`invalid settings file ignored: ${personalPath}`); parsed = undefined; }
    if (parsed !== undefined) {
      const result = validateConfig(parsed, config);
      warnings.push(...result.warnings.map((warning) => `${personalPath}: ${warning}`));
      if (result.error || !result.value) { error ||= `${personalPath}: ${result.error || "invalid settings"}`; warnings.push(`${personalPath}: ${result.error || "invalid settings"}`); }
      else { config = result.value; paths.push(personalPath); }
    }
  }
  return { config, warnings, paths, error };
}
async function readOptional(path: string): Promise<string | undefined> { try { return await readFile(path, "utf8"); } catch { return undefined; } }
