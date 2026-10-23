import type { EffectiveConfig } from "./defaults.ts";

/**
 * Use the full provider/model ID so equal IDs from different providers do not
 * disable each other. IDs can contain slashes; do not split or normalize them.
 * Keep this policy separate from runtime health: switching models must never
 * revive a session disabled by corruption or a missing host capability.
 */
export function isEnabledForModel(config: EffectiveConfig, model?: { provider: string; id: string }): boolean {
  return config.enabled && (!model || !config.disabledModels.includes(`${model.provider}/${model.id}`));
}
