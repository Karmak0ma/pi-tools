import type { BaselineSnapshot } from "../identity/types.ts";
import { latestBaseline, type DcpRuntime } from "../runtime.ts";
import { blockReasonText, buildEligibility, compressibleRangeLabels, type UnitBlockReason } from "./eligibility.ts";
import { MAX_NESTED_DEPTH } from "../state/operations.ts";

export interface CompressionErrorExtra {
  stage?: string;
  id?: string;
  rangeIndex?: number;
  byTool?: string;
  byPattern?: string;
  hint?: string;
  limit?: number;
  baseline?: BaselineSnapshot;
  cause?: UnitBlockReason;
  blocked?: readonly { id: string; rangeIndex: number; cause: UnitBlockReason }[];
  splits?: readonly { rangeIndex: number; requested: string; segments: readonly string[]; blockBounded?: boolean }[];
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
    lines.push("Re-issue compress with ranges from this list (each item is startId-endId, or one label for a single unit).");
    appendInventory(lines, baseline, runtime);
    return lines.join("\n");
  }
  if (reason === "block_partial") {
    lines.push("Select the whole block or none of it.");
    appendInventory(lines, baseline, runtime);
    return lines.join("\n");
  }
  if (reason === "content_protected") {
    if (extra.blocked?.length) {
      lines.push("Blocked units in your request:");
      for (const unit of extra.blocked) lines.push(`- ${unit.id} (range ${unit.rangeIndex}) ${blockReasonText(unit.cause)}.`);
    }
    if (extra.splits?.some((split) => split.blockBounded)) {
      // A model that writes b-labels often assumes the walls are hidden inside
      // those blocks. Blocks are never split by a wall, so the walls sit between them.
      lines.push("The BLOCKED units lie between the selected blocks; they are visible in context, not inside blocks. Blocks on different sides of a wall cannot be merged into one range.");
    }
    if (extra.splits?.length) {
      // Give the exact replacement ranges: the retry then only needs one
      // summary per segment, with no label arithmetic by the model. When no range
      // has a segment left, offering a replacement would be false, so say to drop them.
      const anySegment = extra.splits.some((split) => split.segments.length > 0);
      lines.push(anySegment
        ? "Retry now with the blocked units left out. Replace each rejected range with these ranges (one summary each; nothing else in the request changes):"
        : "No rejected range can be split into a mergeable range. Remove the rejected ranges and re-issue compress with the other ranges, if any:");
      // An empty list means the only runs left are single blocks, or no unit is compressible. Both mean: nothing to merge here.
      for (const split of extra.splits) lines.push(`- range ${split.rangeIndex} (${split.requested}) -> ${split.segments.length ? split.segments.join(", ") : "no mergeable segment; remove this range and leave its blocks unchanged"}`);
    } else {
      lines.push(extra.id ? `Drop ${extra.id} from the range, or split around it, and retry now.` : "Choose ranges that exclude blocked units and retry now.");
    }
    appendInventory(lines, baseline, runtime);
    return lines.join("\n");
  }
  if (reason === "summary_invalid") {
    lines.push(extra.hint || "Fix the summary and retry.");
    appendInventory(lines, baseline, runtime);
    return lines.join("\n");
  }
  if (reason === "single_block_rewrite") {
    // A rewrite of one block only shortens its summary. In a live session those
    // shorter summaries lost detail, so the call is refused and the block stays as it is or merges.
    lines.push(`Do not rewrite block ${extra.id || "unknown"} alone. Merge it with neighbouring blocks or raw units in one range, or leave it unchanged. Re-issue compress with the corrected ranges.`);
    appendInventory(lines, baseline, runtime);
    return lines.join("\n");
  }
  if (reason === "nesting_limit_exceeded") {
    // The merged block would be deeper than the stored limit. Only a range that
    // avoids the deepest block avoids this, so the model must choose another range.
    lines.push("Do not merge this range. Choose a range that leaves out the deeply merged block, or compress raw units only.");
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
      if (extra.blocked && extra.blocked.length > 1) return `${extra.blocked.length} units in the requested range(s) cannot be compressed. Nothing was compressed.`;
      const unit = extra.id || `at range ${extra.rangeIndex ?? "unknown"}`;
      const why = extra.cause ? blockReasonText(extra.cause) : "is protected";
      return `Unit ${unit} ${why}. Nothing was compressed.`;
    }
    case "single_block_rewrite": return `Range ${extra.rangeIndex ?? "unknown"} would rewrite block ${extra.id || "unknown"} alone. Nothing was compressed.`;
    case "nesting_limit_exceeded": return `Range ${extra.rangeIndex ?? "unknown"} would create a block nested deeper than ${extra.limit ?? MAX_NESTED_DEPTH} levels.`;
    case "summary_invalid": return "The summary is invalid.";
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
  // Report runs, not a first-last span: a span can straddle a BLOCKED unit and
  // advertise a range the model is not allowed to select in one call. The runs
  // are written in the labels the request shows (a block is its bNNNN, never the
  // mNNNN units inside it) and drop single-block runs, which the tool refuses.
  // runtime.reduced is the same state the tool validates against.
  const eligibility = buildEligibility(baseline.units, { turnProtection: runtime.config.turnProtection, protectUserMessages: runtime.config.compress.protectUserMessages });
  // Known gap, not handled here: a unit with no provider-visible content gets no
  // inline label (see injectInlineLabels in transform/labels.ts), but this list
  // can still name it. The random test in compressible-inventory.test.ts builds
  // only text messages for that reason.
  const ranges = compressibleRangeLabels(baseline, runtime.reduced, eligibility);
  lines.push(`Compressible ranges right now: ${ranges.length ? ranges.join(", ") : "none"}.`);
  const blocks = [...baseline.blockAliases.values()].filter((block) => {
    const state = runtime.reduced.blocks.get(block.blockId);
    return state ? state.active && state.available : baseline.activeBlockIds.includes(block.blockId);
  });
  lines.push(`Active blocks: ${blocks.length ? blocks.map((block) => `${block.alias} (${block.topic})`).join(", ") : "none"}.`);
}
