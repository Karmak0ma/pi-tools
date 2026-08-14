import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface CapabilityResult { ok: boolean; missing: string[]; }

export function checkCommandCapabilities(pi: ExtensionAPI): CapabilityResult { const missing: string[] = []; if (typeof pi.registerCommand !== "function") missing.push("registerCommand"); return { ok: missing.length === 0, missing }; }

export function checkFactoryCapabilities(pi: ExtensionAPI): CapabilityResult {
  const missing: string[] = [];
  for (const [name, value] of Object.entries({
    on: pi.on, appendEntry: pi.appendEntry, registerTool: pi.registerTool, registerCommand: pi.registerCommand,
    getActiveTools: pi.getActiveTools, setActiveTools: pi.setActiveTools, sendUserMessage: pi.sendUserMessage,
  })) if (typeof value !== "function") missing.push(name);
  return { ok: missing.length === 0, missing };
}

export function checkContextCapabilities(ctx: ExtensionContext): CapabilityResult {
  const missing: string[] = [];
  const session = ctx.sessionManager as unknown as Record<string, unknown>;
  for (const name of ["getLeafId", "getBranch", "buildContextEntries"]) if (typeof session[name] !== "function") missing.push(`sessionManager.${name}`);
  for (const [name, value] of Object.entries({ getContextUsage: ctx.getContextUsage, isProjectTrusted: ctx.isProjectTrusted, isIdle: ctx.isIdle, reload: (ctx as unknown as { reload?: unknown }).reload, confirm: ctx.ui?.confirm })) if (name !== "reload" && typeof value !== "function") missing.push(name);
  if (!ctx.ui || typeof ctx.ui.confirm !== "function") missing.push("ui.confirm");
  return { ok: missing.length === 0, missing };
}
