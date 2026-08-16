import { defaults, type EffectiveConfig } from "./defaults.ts";

const known = new Set(Object.keys(defaults));
const excluded = new Set(["mode", "experimental", "tokenizer", "aggregate", "checkpoint", "cache", "prompt", "nativeCompactionCancellation", "compaction"]);

export interface ConfigValidation { value?: EffectiveConfig; warnings: string[]; error?: string; }

export function validateConfig(input: unknown, base: EffectiveConfig = defaults as unknown as EffectiveConfig): ConfigValidation {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return { warnings: [], error: "configuration must be an object" };
  const warnings: string[] = [];
  const forbidden = findExcludedKey(input as Record<string, unknown>);
  if (forbidden) return { warnings, error: `unsupported configuration key: ${forbidden}` };
  for (const key of Object.keys(input)) {
    if (!known.has(key)) warnings.push(`unknown configuration key: ${key}`);
  }
  try {
    const value = mergeConfig(base, input as Record<string, unknown>, warnings);
    return { value, warnings };
  } catch (error) {
    return { warnings, error: error instanceof Error ? error.message : String(error) };
  }
}

export function mergeConfig(base: EffectiveConfig, patch: Record<string, unknown>, warnings: string[] = []): EffectiveConfig {
  const result: EffectiveConfig = JSON.parse(JSON.stringify(base)) as EffectiveConfig;
  for (const [key, raw] of Object.entries(patch)) {
    if (!known.has(key)) continue;
    if (key === "protectedFilePatterns") { result.protectedFilePatterns = stringArray(raw, key); continue; }
    if (key === "enabled" || key === "debug") { result[key] = booleanValue(raw, key) as never; continue; }
    if (key === "nudge") { mergeNudge(result.nudge, raw, warnings); continue; }
    if (key === "pruneNotification") { result.pruneNotification = enumValue(raw, ["off", "minimal", "summary", "detailed"], key); continue; }
    if (key === "pruneNotificationType") { result.pruneNotificationType = enumValue(raw, ["chat", "toast", "both"], key); continue; }
    const target = result[key as "commands" | "manualMode" | "turnProtection" | "compress" | "strategies" | "summary"] as unknown as Record<string, unknown>;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${key} must be an object`);
    for (const [child, childValue] of Object.entries(raw as Record<string, unknown>)) {
      if (!(child in target)) { warnings.push(`unknown configuration key: ${key}.${child}`); continue; }
      if (child === "protectedTools" || child === "protectedFilePatterns") target[child] = stringArray(childValue, `${key}.${child}`);
      else if (child === "modelMaxLimits" || child === "modelMinLimits") target[child] = limitsMap(childValue, `${key}.${child}`);
      else if (child === "permission") target[child] = enumValue(childValue, ["allow", "ask", "deny"], `${key}.${child}`);
      else if (child === "maxContextLimit" || child === "minContextLimit") { target[child] = limitValue(childValue, `${key}.${child}`); if (typeof childValue === "string") result.nudge[child === "maxContextLimit" ? "maxContextPercent" : "minContextPercent"] = Number(childValue.slice(0, -1)); }
      else if (child === "nudgeFrequency") { target[child] = positiveInteger(childValue, `${key}.${child}`); result.nudge.turnsBetweenNudges = target[child] as number; }
      else if (typeof target[child] === "boolean") target[child] = booleanValue(childValue, `${key}.${child}`);
      else target[child] = positiveInteger(childValue, `${key}.${child}`);
    }
  }
  if (result.compress.minContextLimit === 0 || result.compress.maxContextLimit === 0) throw new Error("context limits must be positive");
  if (typeof result.compress.minContextLimit === typeof result.compress.maxContextLimit) { const minLimit = comparableLimit(result.compress.minContextLimit); const maxLimit = comparableLimit(result.compress.maxContextLimit); if (minLimit > maxLimit) throw new Error("minContextLimit cannot exceed maxContextLimit"); }
  if (result.nudge.minContextPercent > result.nudge.maxContextPercent) throw new Error("nudge.minContextPercent cannot exceed nudge.maxContextPercent");
  if (result.nudge.maxContextPercent >= result.nudge.criticalContextPercent) throw new Error("nudge.maxContextPercent must be below nudge.criticalContextPercent");
  if (result.compress.nudgeFrequency < 1 || result.compress.iterationNudgeThreshold < 1) throw new Error("nudge limits must be positive");
  return result;
}

function mergeNudge(target: EffectiveConfig["nudge"], raw: unknown, warnings: string[] = []): void { if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("nudge must be an object"); for (const [child, value] of Object.entries(raw as Record<string, unknown>)) { if (child === "minContextPercent" || child === "maxContextPercent" || child === "criticalContextPercent") target[child] = percentageValue(value, `nudge.${child}`); else if (child === "turnsBetweenNudges") target.turnsBetweenNudges = positiveInteger(value, "nudge.turnsBetweenNudges"); else if (child === "type") warnings.push("deprecated configuration key ignored: nudge.type"); else throw new Error(`unknown configuration key: nudge.${child}`); } }
function percentageValue(value: unknown, key: string): number { if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100) throw new Error(`${key} must be an integer from 1 to 100`); return value; }
function booleanValue(value: unknown, key: string): boolean { if (typeof value !== "boolean") throw new Error(`${key} must be boolean`); return value; }
function stringArray(value: unknown, key: string): string[] { if (!Array.isArray(value) || value.some((x) => typeof x !== "string")) throw new Error(`${key} must be a string array`); return [...value]; }
function positiveInteger(value: unknown, key: string): number { if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`${key} must be a positive integer`); return value; }
function enumValue<T extends string>(value: unknown, values: readonly T[], key: string): T { if (typeof value !== "string" || !values.includes(value as T)) throw new Error(`${key} has an invalid value`); return value as T; }
function limitsMap(value: unknown, key: string): Record<string, number | string> { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${key} must be an object`); const out: Record<string, number | string> = {}; for (const [k, v] of Object.entries(value)) out[k] = limitValue(v, `${key}.${k}`); return out; }
function limitValue(value: unknown, key: string): number | string { if (typeof value === "number" && Number.isInteger(value) && value > 0) return value; if (typeof value === "string" && /^\d+%$/.test(value) && Number(value.slice(0, -1)) >= 1 && Number(value.slice(0, -1)) <= 100) return value; throw new Error(`${key} must be a positive integer or percentage`); }
function comparableLimit(value: number | string): number { return typeof value === "number" ? value : Number(value.slice(0, -1)); }
function findExcludedKey(value: Record<string, unknown>, prefix = ""): string | undefined { for (const [key, child] of Object.entries(value)) { const path = prefix ? `${prefix}.${key}` : key; if (excluded.has(key)) return path; if (child && typeof child === "object" && !Array.isArray(child)) { const nested = findExcludedKey(child as Record<string, unknown>, path); if (nested) return nested; } } return undefined; }
