import { hashJson } from "../util/hash.ts";

export type ReasonCode =
  | "capability_missing" | "config_layer_invalid" | "state_schema_unknown" | "state_conflict"
  | "projection_unsupported" | "join_ambiguous" | "protocol_invalid" | "snapshot_missing"
  | "snapshot_stale" | "snapshot_mismatch" | "range_invalid" | "range_overlap"
  | "content_protected" | "block_partial" | "placeholder_invalid" | "summary_invalid"
  | "permission_denied" | "permission_unavailable" | "manual_nonce_required" | "tool_collision"
  | "append_best_effort" | "provider_adapter_unsupported" | "startup_error";

export interface Diagnostic {
  reason: ReasonCode;
  counts?: Record<string, number>;
  durationMs?: number;
  confidence?: "reported" | "heuristic";
}

export interface Logger {
  diagnostic(diagnostic: Diagnostic): void;
}

export function createLogger(extensionVersion: string, sink: (line: string) => void = () => undefined): Logger {
  return {
    diagnostic(diagnostic) {
      const safe = {
        extensionVersion,
        reason: diagnostic.reason,
        counts: diagnostic.counts,
        durationMs: diagnostic.durationMs,
        confidence: diagnostic.confidence,
      };
      sink(JSON.stringify(safe));
    },
  };
}

export function safeSessionHash(sessionId: string): string { return hashJson(["session", sessionId]); }
export function safeBranchHash(branchId: string | null): string { return hashJson(["branch", branchId]); }
