import { isCompressionParams, type CompressionParams } from "./schema.ts";
import { compressSummaryMarker } from "../transform/tools.ts";

export type SummaryValidation = { ok: true } | { ok: false; reason: "summary_invalid" };
export function validateCompressionShape(value: unknown): value is CompressionParams { return isCompressionParams(value); }
export function validateSummary(summary: string, maxChars = 100000): SummaryValidation {
  if (summary.length < 1 || summary.length > maxChars) return { ok: false, reason: "summary_invalid" };
  if ([...summary].some((char) => (char.charCodeAt(0) < 0x20 && char !== "\n" && char !== "\r" && char !== "\t") || char === "\u007f")) return { ok: false, reason: "summary_invalid" };
  if (summary.includes("\u0000") || summary.includes("<|im_")) return { ok: false, reason: "summary_invalid" };
  // Backstop for the redaction marker. pi-dcp no longer writes this string into
  // the model's view of its own past compress calls (transform/tools.ts), but a
  // model that learned the pattern in an earlier session can still emit it, and
  // storing it would silently replace a whole range with one meaningless line.
  // Matched on trimmed EQUALITY, not `includes`: a summary that legitimately
  // discusses this very redaction must stay valid.
  if (summary.trim() === compressSummaryMarker()) return { ok: false, reason: "summary_invalid" };
  if ([...summary.matchAll(/\(b(\d+)\)/g)].some((match) => match[1].length !== 4)) return { ok: false, reason: "summary_invalid" };
  if (summary.replace(/\(b\d{4}\)/g, "").trim().length === 0) return { ok: false, reason: "summary_invalid" };
  return { ok: true };
}
