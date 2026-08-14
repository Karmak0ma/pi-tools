import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkCommandCapabilities, checkFactoryCapabilities } from "./capabilities.ts";
import { createRuntime, disableRuntime } from "./runtime.ts";
import { registerLifecycle } from "./lifecycle.ts";
import { registerCommands } from "./commands/index.ts";

export default function piDcp(pi: ExtensionAPI): void {
  const runtime = createRuntime(pi);
  const commandCapability = checkCommandCapabilities(pi);
  if (!commandCapability.ok) {
    disableRuntime(runtime, "capability_missing");
    runtime.logger.diagnostic({ reason: "capability_missing", counts: { missing: commandCapability.missing.length } });
    return;
  }
  try { registerCommands(pi, runtime); }
  catch { disableRuntime(runtime, "startup_error"); runtime.logger.diagnostic({ reason: "startup_error", counts: { commands: 1 } }); return; }
  const capability = checkFactoryCapabilities(pi);
  if (!capability.ok) {
    disableRuntime(runtime, "capability_missing");
    runtime.logger.diagnostic({ reason: "capability_missing", counts: { missing: capability.missing.length } });
    return;
  }
  try { registerLifecycle(pi, runtime); }
  catch { disableRuntime(runtime, "startup_error"); runtime.logger.diagnostic({ reason: "startup_error", counts: { lifecycle: 1 } }); }
}
