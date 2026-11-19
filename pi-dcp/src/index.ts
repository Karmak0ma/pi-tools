import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkCommandCapabilities, checkFactoryCapabilities } from "./capabilities.ts";
import { createRuntime, disableRuntime } from "./runtime.ts";
import { registerLifecycle } from "./lifecycle.ts";
import { registerCommands } from "./commands/index.ts";
import { registerCompressionTool } from "./compression/tool.ts";
import { registerRetrievalTool } from "./retrieval/tool.ts";

export default function piDcp(pi: ExtensionAPI): void {
  const runtime = createRuntime(pi);
  const commandCapability = checkCommandCapabilities(pi);
  if (!commandCapability.ok) {
    disableRuntime(runtime, "capability_missing");
    return;
  }
  try { registerCommands(pi, runtime); }
  catch { disableRuntime(runtime, "startup_error"); return; }

  // Tool definitions are registration-only APIs and are valid while the
  // extension factory is loading. Register the DCP tools before checking the
  // optional lifecycle/action surface so a missing runtime method cannot make
  // the model-facing tools disappear along with the unrelated DCP hooks.
  // search_compressed shares compress's activation (setDcpToolActive), so both
  // are registered together.
  try { registerCompressionTool(pi, runtime); registerRetrievalTool(pi, runtime); }
  catch { disableRuntime(runtime, "startup_error"); return; }

  const capability = checkFactoryCapabilities(pi);
  if (!capability.ok) {
    disableRuntime(runtime, "capability_missing");
    return;
  }
  try { registerLifecycle(pi, runtime); }
  catch { disableRuntime(runtime, "startup_error"); }
}
