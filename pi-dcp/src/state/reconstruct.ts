import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { emptyState, reduceEnvelope, type ReducedState } from "./reducer.ts";
import { isOperationEnvelope } from "./operations.ts";
export interface Reconstruction { state: ReducedState; operationEntries: number; }
/** Canonical replay is intentionally branch-local: never call this with getEntries(). */
export function reconstructFromBranch(entries: readonly SessionEntry[], sessionId?: string): Reconstruction { let state: ReducedState = emptyState(); let operationEntries = 0; for (const entry of entries) { if (entry.type !== "custom" || entry.customType !== "pi-dcp.operation") continue; operationEntries++; if (!isOperationEnvelope(entry.data)) { state = { ...state, corruptReason: "state_schema_unknown" }; break; } if (sessionId && entry.data.sessionId !== sessionId) { state = { ...state, corruptReason: "state_conflict" }; break; } state = reduceEnvelope(state, entry.data); if (state.corruptReason) break; } return { state, operationEntries }; }
