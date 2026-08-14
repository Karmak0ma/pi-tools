import { isCompressionParams, type CompressionParams } from "./schema.ts";

export type SummaryValidation = { ok: true } | { ok: false; reason: "summary_invalid" };
export function validateCompressionShape(value: unknown): value is CompressionParams { return isCompressionParams(value); }
export function validateSummary(summary: string, maxChars = 100000): SummaryValidation {
  if (summary.length < 1 || summary.length > maxChars) return { ok: false, reason: "summary_invalid" };
  if ([...summary].some((char) => (char.charCodeAt(0) < 0x20 && char !== "\n" && char !== "\r" && char !== "\t") || char === "\u007f")) return { ok: false, reason: "summary_invalid" };
  if (summary.includes("\u0000") || summary.includes("<|im_")) return { ok: false, reason: "summary_invalid" };
  if ([...summary.matchAll(/\(b(\d+)\)/g)].some((match) => match[1].length !== 4)) return { ok: false, reason: "summary_invalid" };
  if (summary.replace(/\(b\d{4}\)/g, "").trim().length === 0) return { ok: false, reason: "summary_invalid" };
  return { ok: true };
}
