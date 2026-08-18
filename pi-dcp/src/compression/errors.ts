import type { BaselineSnapshot } from "../identity/types.ts";
import { latestBaseline, type DcpRuntime } from "../runtime.ts";
import { blockReasonText, buildEligibility, compressibleSegments, type UnitBlockReason } from "./eligibility.ts";

export interface CompressionErrorExtra {
  stage?: string;
  id?: string;
  rangeIndex?: number;
  byTool?: string;
  byPattern?: string;
  hint?: string;
  baseline?: BaselineSnapshot;
  cause?: UnitBlockReason;
}

/**
 * Keep tool failures useful to the model without echoing message content.
 * The inventory comes only from the immutable request baseline and reduced
 * block metadata; it never reads or summarizes the session file.
 */
export function buildErrorText(runtime: DcpRuntime, reason: string, extra: CompressionErrorExtra = {}): string {
  const stage = extra.stage ? ` (${extra.stage})` : "";
  const diagnosis = diagnosisFor(reason, extra, runtime);
  const lines = [`pi-dcp: ${reason}${stage} — ${diagnosis}`];

  if (reason === "compression_unavailable") {
    lines.push(guidanceForReadiness(extra.stage));
    return lines.join("\n");
  }
  const baseline = extra.baseline || latestBaseline(runtime);
  if (reason === "baseline_unavailable") {
    lines.push("Re-issue compress on the next turn, after the context transform publishes labels again.");
    appendInventory(lines, baseline, runtime);
    return lines.join("\n");
  }
  if (reason === "range_invalid" || reason === "range_overlap") {
    lines.push("Re-issue compress with labels from this list.");
    appendInventory(lines, baseline, runtime);
    return lines.join("\n");
  }
  if (reason === "block_partial") {
    lines.push("Select the whole block or none of it.");
    appendInventory(lines, baseline, runtime);
    return lines.join("\n");
  }
  if (reason === "content_protected") {
    lines.push(extra.id ? `Drop ${extra.id} from the range, or split around it; it is marked BLOCKED inline.` : "Choose a range excluding protected units; protected units are marked BLOCKED inline.");
    appendInventory(lines, baseline, runtime);
    return lines.join("\n");
  }
  if (reason === "placeholder_invalid" || reason === "summary_invalid") {
    lines.push("Fix the summary and retry; see the tool description for placeholder rules.");
    appendInventory(lines, baseline, runtime);
    return lines.join("\n");
  }
  if (reason === "permission_denied" || reason === "permission_unavailable") {
    lines.push(`Compression permission is ${runtime.config.compress.permission}; ask your operator to change it.`);
    return lines.join("\n");
  }
  lines.push("Retry the request after correcting the reported problem; use only labels visible in the current context.");
  return lines.join("\n");
}

function diagnosisFor(reason: string, extra: CompressionErrorExtra, runtime: DcpRuntime): string {
  switch (reason) {
    case "compression_unavailable": return `${extra.stage || runtime.lastReadiness?.reason || "state_invalidated"}. No aliases were published for the current request.`;
    case "baseline_unavailable": return "No baseline could be recovered for this tool call.";
    case "range_invalid": return `"${extra.id || "unknown"}" is not a current label.`;
    case "range_overlap": return `Range ${extra.rangeIndex ?? "unknown"} overlaps an earlier range.`;
    case "block_partial": return `Range ${extra.rangeIndex ?? "unknown"} intersects block ${extra.id || "unknown"} partially.`;
    case "content_protected": {
      const unit = extra.id || `at range ${extra.rangeIndex ?? "unknown"}`;
      const why = extra.cause ? blockReasonText(extra.cause) : "is protected";
      return `Unit ${unit} ${why}.`;
    }
    case "placeholder_invalid": return extra.hint || "The summary has an invalid nested block placeholder.";
    case "summary_invalid": return extra.hint || "The summary is invalid.";
    case "permission_denied": case "permission_unavailable": return "Compression permission is not available.";
    case "protocol_version": return "The compression parameters do not match the current tool schema.";
    default: return extra.stage ? `The operation failed at ${extra.stage}.` : "The operation could not be completed.";
  }
}

function guidanceForReadiness(reason = "state_invalidated"): string {
  if (reason === "provider_adapter_unsupported") return "Retry after reloading pi-dcp.";
  if (reason === "alias_overflow") return "Retry is unavailable because the session exceeded 9999 units.";
  if (reason === "projection_unsupported" || reason === "join_ambiguous" || reason === "protocol_invalid") return "Another extension modified the context; retry on the next request.";
  return "Retry on a later request after the context transform is ready.";
}

function appendInventory(lines: string[], baseline: BaselineSnapshot | undefined, runtime: DcpRuntime): void {
  if (!baseline) return;
  // Report the compressible mNNNN segments, not a first-last span: a span can
  // straddle a BLOCKED unit and advertise a range the model is not actually
  // allowed to select in one call.
  const eligibility = buildEligibility(baseline.units, { turnProtection: runtime.config.turnProtection, protectUserMessages: runtime.config.compress.protectUserMessages });
  const segments = compressibleSegments(baseline.units, eligibility);
  lines.push(`Compressible labels right now: ${segments.length ? segments.join(", ") : "none"}.`);
  const blocks = [...baseline.blockAliases.values()].filter((block) => {
    const state = runtime.reduced.blocks.get(block.blockId);
    return state ? state.active && state.available : baseline.activeBlockIds.includes(block.blockId);
  });
  lines.push(`Active blocks: ${blocks.length ? blocks.map((block) => `${block.alias} (${block.topic})`).join(", ") : "none"}.`);
}
