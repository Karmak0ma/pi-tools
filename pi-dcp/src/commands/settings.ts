import type { ExtensionCommandContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clearBaselines, setDcpToolActive, type DcpRuntime } from "../runtime.ts";
import { defaults, type EffectiveConfig } from "../config/defaults.ts";
import { settingsPath, writeSettings } from "../config/settings.ts";

const CANCEL = "Cancel without saving";
const SAVE = "Save and close";

export async function settingsCommand(ctx: ExtensionCommandContext, pi: ExtensionAPI, runtime: DcpRuntime): Promise<void> {
  if (!ctx.hasUI) { ctx.ui.notify(`pi-dcp settings require an interactive UI. Edit ${settingsPath()} directly.`, "info"); return; }
  let draft = structuredClone(runtime.config) as EffectiveConfig;
  while (true) {
    const choice = await ctx.ui.select("pi-dcp settings", menuOptions(draft));
    if (!choice || choice === CANCEL) return;
    if (choice === SAVE) {
      try { await writeSettings(draft, settingsPath()); }
      catch (error) { ctx.ui.notify(`Could not save ${settingsPath()}: ${error instanceof Error ? error.message : String(error)}`, "error"); continue; }
      await runtime.mutex.runExclusive(() => applyConfig(runtime, pi, draft));
      ctx.ui.notify(`pi-dcp settings saved to ${settingsPath()}.`, "info");
      return;
    }
    if (choice.startsWith("Extension: ")) { draft.enabled = await chooseToggle(ctx, "Extension", draft.enabled); continue; }
    if (choice.startsWith("Commands: ")) { draft.commands.enabled = await chooseToggle(ctx, "Commands", draft.commands.enabled); continue; }
    if (choice.startsWith("Minimum context: ")) { const value = await numberInput(ctx, "Minimum context percentage", String(draft.nudge.minContextPercent), 1, draft.nudge.maxContextPercent); if (value !== undefined) draft.nudge.minContextPercent = value; continue; }
    if (choice.startsWith("Maximum context: ")) { const value = await numberInput(ctx, "Maximum context percentage", String(draft.nudge.maxContextPercent), draft.nudge.minContextPercent, draft.nudge.criticalContextPercent - 1); if (value !== undefined) draft.nudge.maxContextPercent = value; continue; }
    if (choice.startsWith("Critical context: ")) { const value = await numberInput(ctx, "Critical context percentage", String(draft.nudge.criticalContextPercent), draft.nudge.maxContextPercent + 1, 100); if (value !== undefined) draft.nudge.criticalContextPercent = value; continue; }
    if (choice.startsWith("Turns between nudges: ")) { const value = await numberInput(ctx, "Turns between nudges", String(draft.nudge.turnsBetweenNudges), 1, 1000); if (value !== undefined) draft.nudge.turnsBetweenNudges = value; continue; }
    if (choice.startsWith("Compression permission: ")) { const value = await ctx.ui.select("Compression permission", ["allow — model may compress", "ask — confirm before compression", "deny — disable compression", "Back"]); if (value?.startsWith("allow")) draft.compress.permission = "allow"; else if (value?.startsWith("ask")) draft.compress.permission = "ask"; else if (value?.startsWith("deny")) draft.compress.permission = "deny"; continue; }
    if (choice.startsWith("Automatic pruning: ")) { draft.manualMode.automaticStrategies = await chooseToggle(ctx, "Automatic pruning", draft.manualMode.automaticStrategies); continue; }
    if (choice.startsWith("Recent-turn protection: ")) { const turns = await chooseTurns(ctx, draft.turnProtection.turns); if (turns !== undefined) { draft.turnProtection.enabled = turns > 0; if (turns > 0) draft.turnProtection.turns = turns; } continue; }
    if (choice.startsWith("Protect complete user messages: ")) { draft.compress.protectUserMessages = await chooseToggle(ctx, "Protect complete user messages", draft.compress.protectUserMessages); continue; }
    if (choice.startsWith("Prune notifications: ")) { const value = await ctx.ui.select("Prune notification level", ["off", "minimal", "summary", "detailed", "Back"]); if (value && value !== "Back") draft.pruneNotification = value as EffectiveConfig["pruneNotification"]; continue; }
    if (choice.startsWith("Notification channel: ")) { const value = await ctx.ui.select("Notification channel", ["chat — transcript message", "toast — popup notification", "both — transcript and popup", "Back"]); if (value?.startsWith("chat")) draft.pruneNotificationType = "chat"; else if (value?.startsWith("toast")) draft.pruneNotificationType = "toast"; else if (value?.startsWith("both")) draft.pruneNotificationType = "both"; continue; }
    if (choice.startsWith("Protected tools: ")) { const value = await listInput(ctx, "Protected tool names", draft.compress.protectedTools); if (value !== undefined) draft.compress.protectedTools = value; continue; }
    if (choice.startsWith("Protected paths: ")) { const value = await listInput(ctx, "Protected file glob patterns", draft.protectedFilePatterns); if (value !== undefined) draft.protectedFilePatterns = value; continue; }
    if (choice === "Reset visible settings to defaults") { const confirmed = await ctx.ui.confirm("Reset pi-dcp settings?", "This resets the settings shown in this menu. Save and close to persist the reset."); if (confirmed) draft = visibleDefaults(); }
  }
}

function menuOptions(config: EffectiveConfig): string[] { return [
  `Extension: ${config.enabled ? "enabled" : "disabled"}`,
  `Commands: ${config.commands.enabled ? "enabled" : "disabled"}`,
  `Minimum context: ${config.nudge.minContextPercent}%`,
  `Maximum context: ${config.nudge.maxContextPercent}%`,
  `Critical context: ${config.nudge.criticalContextPercent}%`,
  `Turns between nudges: ${config.nudge.turnsBetweenNudges}`,
  `Compression permission: ${config.compress.permission}`,
  `Automatic pruning: ${config.manualMode.automaticStrategies ? "enabled" : "disabled"}`,
  `Recent-turn protection: ${config.turnProtection.enabled ? `${config.turnProtection.turns} turns` : "off"}`,
  `Protect complete user messages: ${config.compress.protectUserMessages ? "on" : "off"}`,
  `Prune notifications: ${config.pruneNotification}`,
  `Notification channel: ${config.pruneNotificationType}`,
  `Protected tools: ${config.compress.protectedTools.length ? config.compress.protectedTools.join(", ") : "none"}`,
  `Protected paths: ${config.protectedFilePatterns.length ? config.protectedFilePatterns.join(", ") : "none"}`,
  "Reset visible settings to defaults",
  SAVE,
  CANCEL,
]; }

async function chooseToggle(ctx: ExtensionCommandContext, title: string, current: boolean): Promise<boolean> { const choice = await ctx.ui.select(title, ["on", "off", "Back"]); if (choice === "on") return true; if (choice === "off") return false; return current; }
async function chooseTurns(ctx: ExtensionCommandContext, current: number): Promise<number | undefined> { const choice = await ctx.ui.select("Recent-turn protection", ["off", "2 turns", "4 turns", "6 turns", "8 turns", "custom…", "Back"]); if (!choice || choice === "Back") return undefined; if (choice === "off") return 0; if (choice === "custom…") return numberInput(ctx, "Recent turns to protect", String(current), 1, 100); return Number(choice.split(" ")[0]); }
async function numberInput(ctx: ExtensionCommandContext, title: string, current: string, minimum: number, maximum: number): Promise<number | undefined> { while (true) { const raw = await ctx.ui.input(title, current); if (raw === undefined) return undefined; const value = Number(raw.trim().replace(/%$/, "")); if (Number.isInteger(value) && value >= minimum && value <= maximum) return value; ctx.ui.notify(`Enter a whole number from ${minimum} to ${maximum}.`, "error"); } }
async function listInput(ctx: ExtensionCommandContext, title: string, current: string[]): Promise<string[] | undefined> { const raw = await ctx.ui.input(`${title} (comma-separated; blank clears)`, current.join(", ")); if (raw === undefined) return undefined; return [...new Set(raw.split(",").map((item) => item.trim()).filter(Boolean))]; }
function visibleDefaults(): EffectiveConfig { const config = structuredClone(defaults) as unknown as EffectiveConfig; return config; }
function applyConfig(runtime: DcpRuntime, pi: ExtensionAPI, config: EffectiveConfig): void { runtime.config = config; runtime.configPaths = [...new Set([...runtime.configPaths, settingsPath()])]; runtime.generation++; clearBaselines(runtime); runtime.lastNudgeTurn = undefined; const blocked = runtime.warnedReasonCodes.has("capability_missing") || runtime.warnedReasonCodes.has("tool_collision") || runtime.warnedReasonCodes.has("startup_error"); runtime.valid = !blocked && !runtime.reduced.corruptReason && config.enabled; try { setDcpToolActive(pi, runtime.valid && config.compress.permission !== "deny"); } catch { /* best effort */ } }
