import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface CapabilityResult { ok: boolean; missing: string[]; }

export function checkCommandCapabilities(pi: ExtensionAPI): CapabilityResult { const missing: string[] = []; if (typeof pi.registerCommand !== "function") missing.push("registerCommand"); return { ok: missing.length === 0, missing }; }

export function checkFactoryCapabilities(pi: ExtensionAPI): CapabilityResult {
  const missing: string[] = [];
  for (const [name, value] of Object.entries({
    on: pi.on, appendEntry: pi.appendEntry, registerTool: pi.registerTool, registerCommand: pi.registerCommand,
    sendUserMessage: pi.sendUserMessage,
  })) if (typeof value !== "function") missing.push(name);
  return { ok: missing.length === 0, missing };
}

export function checkContextCapabilities(ctx: ExtensionContext): CapabilityResult {
  const missing: string[] = [];
  const session = ctx.sessionManager as unknown as Record<string, unknown>;
  for (const name of ["getLeafId", "getBranch", "buildContextEntries"]) if (typeof session[name] !== "function") missing.push(`sessionManager.${name}`);
  for (const [name, value] of Object.entries({ getContextUsage: ctx.getContextUsage, isProjectTrusted: ctx.isProjectTrusted, isIdle: ctx.isIdle, reload: (ctx as unknown as { reload?: unknown }).reload })) if (name !== "reload" && typeof value !== "function") missing.push(name);

  // Confirmation is a policy-dependent execution capability, not a startup
  // capability. `allow` compression and all read-only context transforms work
  // in print/JSON/headless contexts, while `ask` deliberately checks
  // `ctx.hasUI` immediately before the mutation and returns
  // `permission_unavailable` when no dialog can be shown. Requiring
  // `ui.confirm` here would therefore disable the extension and remove the
  // compress tool even when the configured policy does not need confirmation.
  if (!ctx.ui) missing.push("ui");
  return { ok: missing.length === 0, missing };
}
