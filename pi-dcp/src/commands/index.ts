import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DcpRuntime } from "../runtime.ts";
import { contextCommand } from "./context.ts";
import { statsCommand } from "./stats.ts";
import { manualCommand } from "./manual.ts";
import { activationCommand } from "./blocks.ts";
import { sweepCommand } from "./sweep.ts";
import { settingsCommand } from "./settings.ts";
import { settingsPath } from "../config/settings.ts";
import { debugCommand } from "./debug.ts";
const DCP_COMMANDS = [
  ["menu", "open pi-dcp settings"], ["status", "show status and configuration"], ["debug", "show nudge troubleshooting details"], ["context", "show context usage"], ["stats", "show compression statistics"],
  ["sweep", "prune eligible completed tool outputs"], ["manual", "toggle manual mode"], ["compress", "request model-authored compression"], ["decompress", "restore a compressed block"], ["recompress", "reapply a compressed block"], ["reload", "reload the extension"], ["help", "show status and help"],
] as const;
export function registerCommands(pi: ExtensionAPI, runtime: DcpRuntime): void { pi.registerCommand("dcp", { description: "pi-dcp context compression and pruning", getArgumentCompletions: (prefix) => { const query = prefix.trim().toLowerCase(); return DCP_COMMANDS.filter(([value]) => value.startsWith(query)).map(([value, description]) => ({ value, label: value, description })); }, handler: async (args, ctx) => handleDcp(args, ctx, pi, runtime) }); }
export async function handleDcp(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI, runtime: DcpRuntime): Promise<void> { const tokens = args.trim().split(/\s+/).filter(Boolean); const subcommand = tokens.shift() || "menu"; const rest = tokens.join(" "); if (subcommand === "menu") return settingsCommand(ctx, pi, runtime); if (subcommand === "help" || subcommand === "status") { ctx.ui.notify(`pi-dcp ${runtime.valid ? "enabled" : "disabled"}${runtime.warnedReasonCodes.size ? ` (${[...runtime.warnedReasonCodes].join(", ")})` : ""}; permission ${runtime.config.compress.permission}; manual ${runtime.reduced.manualMode ? "on" : "off"}; config ${runtime.configPaths.join(", ") || "defaults"}; settings ${settingsPath()}. Auto-compaction prerequisite: set compaction.enabled:false.`, "info"); return; } if (subcommand === "debug") return debugCommand(ctx, pi, runtime); if (!runtime.config.commands.enabled) { ctx.ui.notify("pi-dcp commands are disabled. Open /dcp to re-enable them in settings, or edit the personal settings file.", "info"); return; } if (subcommand === "context") return contextCommand(ctx, runtime); if (subcommand === "stats") return statsCommand(ctx, runtime); if (subcommand === "sweep") return sweepCommand(rest, ctx, pi, runtime); if (subcommand === "manual") return manualCommand(rest, ctx, pi, runtime); if (subcommand === "decompress") return activationCommand(rest, false, ctx, pi, runtime); if (subcommand === "recompress") return activationCommand(rest, true, ctx, pi, runtime); if (subcommand === "compress") {
  if (runtime.lastReadiness && !runtime.lastReadiness.ready && runtime.lastReadiness.reason && runtime.lastReadiness.reason !== "state_invalidated") {
    ctx.ui?.notify?.(`pi-dcp: compression unavailable: ${runtime.lastReadiness.reason}. No aliases were published.`, "error");
    return;
  }
  if (runtime.pendingManual) { ctx.ui.notify("A pi-dcp manual request is already pending.", "error"); return; }
  runtime.pendingManual = { focus: rest || undefined, createdAt: Date.now() };
  const request = `Perform exactly one pi-dcp compression pass now.

Choose one or more older, resolved ranges from the visible conversation only. Use only current visible mNNNN or bNNNN labels; do not inspect the session file and do not invent IDs. Keep the latest user intent, active work, unresolved questions, pending tool exchanges, and protected content out of the selected range. Write an exhaustive technical summary preserving decisions, constraints, paths, findings, and verification evidence. If no safe visible labels are available, do not call compress and report that compression is unavailable.${rest ? ` Focus: ${rest}` : ""}`;
  try { pi.sendUserMessage(request, ctx.isIdle() ? undefined : { deliverAs: "followUp" }); runtime.pendingManual = undefined; } catch { runtime.pendingManual = undefined; ctx.ui.notify("pi-dcp could not send the manual request.", "error"); }
  return;
} if (subcommand === "reload") { await ctx.reload(); return; } ctx.ui.notify("Usage: /dcp [menu|status|debug|context|stats|sweep [N]|manual [on|off]|compress [focus]|decompress [N|bNNNN]|recompress [N|bNNNN]|reload]", "error"); }
