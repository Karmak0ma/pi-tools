import { ExtensionSelectorComponent, keyHint, rawKeyHint, type ExtensionCommandContext, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { clearBaselines, resetSemanticNudges, setDcpToolActive, type DcpRuntime } from "../runtime.ts";
import { isEnabledForModel } from "../config/models.ts";
import { defaults, type EffectiveConfig } from "../config/defaults.ts";
import { pickReceiptStyle } from "../ui/receipt-picker.ts";
import { settingsPath, writeSettings } from "../config/settings.ts";

const CANCEL = "Cancel without saving";
const SAVE = "Save and close";

export async function settingsCommand(ctx: ExtensionCommandContext, pi: ExtensionAPI, runtime: DcpRuntime): Promise<void> {
  if (!ctx.hasUI) { ctx.ui.notify(`pi-dcp settings require an interactive UI. Edit ${settingsPath()} directly.`, "info"); return; }
  let draft = structuredClone(runtime.config) as EffectiveConfig;
  while (true) {
    const choice = await selectMenu(ctx, "pi-dcp settings", menuOptions(draft));
    if (!choice || choice === CANCEL) return;
    if (choice === SAVE) {
      try { await writeSettings(draft, settingsPath()); }
      catch (error) { ctx.ui.notify(`Could not save ${settingsPath()}: ${error instanceof Error ? error.message : String(error)}`, "error"); continue; }
      await runtime.mutex.runExclusive(() => applyConfig(runtime, pi, draft, ctx));
      ctx.ui.notify(`pi-dcp settings saved to ${settingsPath()}.`, "info");
      return;
    }
    if (choice.startsWith("Extension: ")) { draft.enabled = await chooseToggle(ctx, "Extension", draft.enabled); continue; }
    if (choice.startsWith("Commands: ")) { draft.commands.enabled = await chooseToggle(ctx, "Commands", draft.commands.enabled); continue; }
    if (choice.startsWith("Minimum context: ")) { const value = await numberInput(ctx, "Minimum context percentage", String(draft.nudge.minContextPercent), 1, draft.nudge.maxContextPercent); if (value !== undefined) draft.nudge.minContextPercent = value; continue; }
    if (choice.startsWith("Maximum context: ")) { const value = await numberInput(ctx, "Maximum context percentage", String(draft.nudge.maxContextPercent), draft.nudge.minContextPercent, draft.nudge.criticalContextPercent - 1); if (value !== undefined) draft.nudge.maxContextPercent = value; continue; }
    if (choice.startsWith("Critical context: ")) { const value = await numberInput(ctx, "Critical context percentage", String(draft.nudge.criticalContextPercent), draft.nudge.maxContextPercent + 1, 100); if (value !== undefined) draft.nudge.criticalContextPercent = value; continue; }
    if (choice.startsWith("Turns between nudges: ")) { const value = await numberInput(ctx, "Turns between nudges", String(draft.nudge.turnsBetweenNudges), 1, 1000); if (value !== undefined) draft.nudge.turnsBetweenNudges = value; continue; }
    if (choice.startsWith("Turn nudge frequency: ")) { const value = await numberInput(ctx, "User turns before semantic nudge", String(draft.nudge.turnNudgeFrequency), 1, 1000); if (value !== undefined) draft.nudge.turnNudgeFrequency = value; continue; }
    if (choice.startsWith("Iteration nudge threshold: ")) { const value = await numberInput(ctx, "Iterations before semantic nudge", String(draft.nudge.iterationNudgeThreshold), 1, 1000); if (value !== undefined) draft.nudge.iterationNudgeThreshold = value; continue; }
    if (choice.startsWith("Minimum nudge savings: ")) { const value = await numberInput(ctx, "Minimum estimated savings tokens", String(draft.nudge.minPotentialSavingsTokens), 1, 10000000); if (value !== undefined) draft.nudge.minPotentialSavingsTokens = value; continue; }
    if (choice.startsWith("Compression permission: ")) { const value = await ctx.ui.select("Compression permission", ["allow — model may compress", "ask — confirm before compression", "deny — disable compression", "Back"]); if (value?.startsWith("allow")) draft.compress.permission = "allow"; else if (value?.startsWith("ask")) draft.compress.permission = "ask"; else if (value?.startsWith("deny")) draft.compress.permission = "deny"; continue; }
    if (choice.startsWith("Automatic pruning: ")) { draft.manualMode.automaticStrategies = await chooseToggle(ctx, "Automatic pruning", draft.manualMode.automaticStrategies); continue; }
    if (choice.startsWith("Recent-turn protection: ")) { const turns = await chooseTurns(ctx, draft.turnProtection.turns); if (turns !== undefined) { draft.turnProtection.enabled = turns > 0; if (turns > 0) draft.turnProtection.turns = turns; } continue; }
    if (choice.startsWith("Protect complete user messages: ")) { draft.compress.protectUserMessages = await chooseToggle(ctx, "Protect complete user messages", draft.compress.protectUserMessages); continue; }
    if (choice.startsWith("Prune notifications: ")) { const value = await ctx.ui.select("Prune notification level", ["off", "minimal", "summary", "detailed", "Back"]); if (value && value !== "Back") draft.pruneNotification = value as EffectiveConfig["pruneNotification"]; continue; }
    if (choice.startsWith("Notification channel: ")) { const value = await ctx.ui.select("Notification channel", ["chat — transcript message", "toast — popup notification", "both — transcript and popup", "Back"]); if (value?.startsWith("chat")) draft.pruneNotificationType = "chat"; else if (value?.startsWith("toast")) draft.pruneNotificationType = "toast"; else if (value?.startsWith("both")) draft.pruneNotificationType = "both"; continue; }
    if (choice.startsWith("Receipt style: ")) { const style = await pickReceiptStyle(ctx, draft.receiptStyle); if (style) draft.receiptStyle = style; continue; }
    if (choice.startsWith("Protected tools: ")) { const value = await listInput(ctx, "Protected tool names", draft.compress.protectedTools); if (value !== undefined) draft.compress.protectedTools = value; continue; }
    if (choice.startsWith("Protected paths: ")) { const value = await listInput(ctx, "Protected file glob patterns", draft.protectedFilePatterns); if (value !== undefined) draft.protectedFilePatterns = value; continue; }
    if (choice === "Reset visible settings to defaults") { const confirmed = await ctx.ui.confirm("Reset pi-dcp settings?", "This resets the settings shown in this menu. Save and close to persist the reset."); if (confirmed) draft = { ...visibleDefaults(), disabledModels: draft.disabledModels }; }
  }
}

function menuOptions(config: EffectiveConfig): string[] { return [
  `Extension: ${config.enabled ? "enabled" : "disabled"}`,
  `Commands: ${config.commands.enabled ? "enabled" : "disabled"}`,
  `Minimum context: ${config.nudge.minContextPercent}%`,
  `Maximum context: ${config.nudge.maxContextPercent}%`,
  `Critical context: ${config.nudge.criticalContextPercent}%`,
  `Turns between nudges: ${config.nudge.turnsBetweenNudges}`,
  `Turn nudge frequency: ${config.nudge.turnNudgeFrequency}`,
  `Iteration nudge threshold: ${config.nudge.iterationNudgeThreshold}`,
  `Minimum nudge savings: ${config.nudge.minPotentialSavingsTokens}`,
  `Compression permission: ${config.compress.permission}`,
  `Automatic pruning: ${config.manualMode.automaticStrategies ? "enabled" : "disabled"}`,
  `Recent-turn protection: ${config.turnProtection.enabled ? `${config.turnProtection.turns} turns` : "off"}`,
  `Protect complete user messages: ${config.compress.protectUserMessages ? "on" : "off"}`,
  `Prune notifications: ${config.pruneNotification}`,
  `Notification channel: ${config.pruneNotificationType}`,
  `Receipt style: ${config.receiptStyle}`,
  `Protected tools: ${config.compress.protectedTools.length ? config.compress.protectedTools.join(", ") : "none"}`,
  `Protected paths: ${config.protectedFilePatterns.length ? config.protectedFilePatterns.join(", ") : "none"}`,
  "Reset visible settings to defaults",
  SAVE,
  CANCEL,
]; }

/**
 * The main menu with one extra key: Ctrl+S picks "Save and close" from any row,
 * so the user does not have to scroll to the bottom after an edit.
 *
 * ctx.ui.select cannot take extra keys, so in the TUI we show Pi's own
 * ExtensionSelectorComponent through ctx.ui.custom and only add the key. This
 * keeps the look and the other keys identical to every other select dialog.
 * The key is fixed to ctrl+s: Pi has no generic "save" binding (its ctrl+s
 * bindings are scoped to the model and thinking selectors), and ctrl+s is what
 * those selectors use, so it is the key users already expect for "save".
 * Other modes (RPC, print) have no key events and keep the plain select.
 *
 * The Ctrl+S hint goes in the grey key-hint line at the bottom, next to the
 * other keys. The selector has no option for extra hints, so we rewrite that
 * line. It is the third child from the end ([hints, Spacer, DynamicBorder]).
 * If a Pi update changes that layout, the setText check fails and the menu
 * still works; only the hint is missing (Ctrl+S itself still saves).
 */
async function selectMenu(ctx: ExtensionCommandContext, title: string, options: string[]): Promise<string | undefined> {
  if (ctx.mode !== "tui") return ctx.ui.select(title, options);
  return ctx.ui.custom<string | undefined>((tui, _theme, _keybindings, done) => {
    const selector = new ExtensionSelectorComponent(title, options, (option) => done(option), () => done(undefined), { tui });
    const hints = selector.children[selector.children.length - 3];
    // Duck-typed on purpose: Pi and this extension can load separate copies of
    // pi-tui, so `instanceof Text` is false even for the real hint line.
    if (hints && "setText" in hints && typeof hints.setText === "function") {
      // Same order and spacing as Pi's own line, with save before cancel.
      hints.setText([rawKeyHint("↑↓", "navigate"), keyHint("tui.select.confirm", "select"), rawKeyHint("ctrl+s", "save"), keyHint("tui.select.cancel", "cancel")].join("  "));
    }
    const handleInput = selector.handleInput.bind(selector);
    selector.handleInput = (data: string) => { if (matchesKey(data, "ctrl+s")) done(SAVE); else { handleInput(data); tui.requestRender(); } };
    return selector;
  });
}

async function chooseToggle(ctx: ExtensionCommandContext, title: string, current: boolean): Promise<boolean> { const choice = await ctx.ui.select(title, ["on", "off", "Back"]); if (choice === "on") return true; if (choice === "off") return false; return current; }
async function chooseTurns(ctx: ExtensionCommandContext, current: number): Promise<number | undefined> { const choice = await ctx.ui.select("Recent-turn protection", ["off", "2 turns", "4 turns", "6 turns", "8 turns", "custom…", "Back"]); if (!choice || choice === "Back") return undefined; if (choice === "off") return 0; if (choice === "custom…") return numberInput(ctx, "Recent turns to protect", String(current), 1, 100); return Number(choice.split(" ")[0]); }
async function numberInput(ctx: ExtensionCommandContext, title: string, current: string, minimum: number, maximum: number): Promise<number | undefined> { while (true) { const raw = await ctx.ui.input(title, current); if (raw === undefined) return undefined; const value = Number(raw.trim().replace(/%$/, "")); if (Number.isInteger(value) && value >= minimum && value <= maximum) return value; ctx.ui.notify(`Enter a whole number from ${minimum} to ${maximum}.`, "error"); } }
async function listInput(ctx: ExtensionCommandContext, title: string, current: string[]): Promise<string[] | undefined> { const raw = await ctx.ui.input(`${title} (comma-separated; blank clears)`, current.join(", ")); if (raw === undefined) return undefined; return [...new Set(raw.split(",").map((item) => item.trim()).filter(Boolean))]; }
function visibleDefaults(): EffectiveConfig { const config = structuredClone(defaults) as unknown as EffectiveConfig; return config; }
function applyConfig(runtime: DcpRuntime, pi: ExtensionAPI, config: EffectiveConfig, ctx: ExtensionCommandContext): void { runtime.config = config; runtime.configPaths = [...new Set([...runtime.configPaths, settingsPath()])]; runtime.generation++; clearBaselines(runtime); runtime.lastNudgeTurn = undefined; resetSemanticNudges(runtime); const blocked = runtime.warnedReasonCodes.has("capability_missing") || runtime.warnedReasonCodes.has("tool_collision") || runtime.warnedReasonCodes.has("startup_error"); runtime.valid = !blocked && !runtime.reduced.corruptReason && config.enabled; runtime.lastReadiness = runtime.valid ? { ready: false, reason: "state_invalidated", generation: runtime.generation } : { ready: false, reason: "extension_disabled", generation: runtime.generation }; try { setDcpToolActive(pi, runtime.valid && isEnabledForModel(config, ctx.model) && config.compress.permission !== "deny"); } catch { /* best effort */ } }
