import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { emptyState, reduceEnvelope, type ReducedState } from "./reducer.ts";
import { isOperationEnvelope, LEGACY_OPERATION_CUSTOM_TYPE, OPERATION_CUSTOM_TYPE } from "./operations.ts";

export interface Reconstruction {
  state: ReducedState;
  operationEntries: number;
  legacyOperationEntries: number;
  legacyIgnored: boolean;
}

/**
 * Replay only v2 entries physically present on the selected branch. v1 entries
 * remain in raw history but are deliberately not interpreted as v2 state.
 */
export function reconstructFromBranch(entries: readonly SessionEntry[], _sessionId?: string): Reconstruction {
  let state: ReducedState = emptyState();
  let operationEntries = 0;
  let legacyOperationEntries = 0;
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    if (entry.customType === LEGACY_OPERATION_CUSTOM_TYPE) {
      legacyOperationEntries++;
      // Do not reduce or reject legacy state. Restoring raw history is the
      // clean-break behavior and avoids applying old authorization semantics.
      continue;
    }
    if (entry.customType !== OPERATION_CUSTOM_TYPE) continue;
    operationEntries++;
    if (!isOperationEnvelope(entry.data)) {
      state = { ...state, corruptReason: "state_schema_unknown" };
      break;
    }
    state = reduceEnvelope(state, entry.data);
    if (state.corruptReason) break;
  }
  return { state, operationEntries, legacyOperationEntries, legacyIgnored: legacyOperationEntries > 0 };
}
