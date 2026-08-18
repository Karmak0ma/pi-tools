import { resolve } from "node:path";
import { canonicalPlainObject, isPlainObject } from "../util/canonical-json.ts";
import type { CanonicalIndex, CanonicalMessageKey } from "../identity/types.ts";

// Pi 0.84.1's built-ins are read, write, edit, bash, grep, find, and ls.
export const PI_BUILTIN_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);

/**
 * Tools whose output/arguments must never be silently cleared by pi-dcp's
 * own PRUNING strategies (sweep, deduplicate, purge-errors), regardless of
 * what a caller's own `protectedTools` config contains. Mutating tools keep
 * the record of what changed; pi-dcp's own `compress` tool call keeps the
 * record that a compression happened (dedup/purge-errors default their own
 * `protectedTools` to `[]` and rely on this floor); `todo` keeps the task
 * list legible.
 *
 * This set is a floor for `isProtectedTool()` only. It intentionally does
 * NOT apply to compression ranges (`compressProtectedMatch` /
 * `appendProtectedToolContent` below): a range absorbs matching tool output
 * into its summary instead of being blocked by it, so unioning this
 * prune-only floor into that path would make every `compress`/`write`/
 * `edit` call a permanent, unmergeable barrier in history for no benefit -
 * that coupling was the pi-dcp 0.2.0 bug this split fixes.
 */
export const PRUNE_PROTECTED_TOOLS = new Set(["compress", "write", "edit", "todo"]);

const PATH_KEYS = new Set(["path", "filePath", "filepath", "target"]);

export interface ProtectionOptions { protectedTools?: readonly string[]; protectedFilePatterns?: readonly string[]; cwd: string; }
export interface ProtectionMatch { protected: boolean; byTool?: string; byPattern?: string; }

export function extractPaths(value: unknown, cwd: string, seen = new WeakSet<object>()): string[] {
  if (value === null || typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) return value.flatMap((item) => extractPaths(item, cwd, seen));
  if (!isPlainObject(value)) return [];
  const paths: string[] = [];
  for (const [key, child] of Object.entries(value)) { if (PATH_KEYS.has(key) && typeof child === "string") paths.push(resolve(cwd, child)); paths.push(...extractPaths(child, cwd, seen)); }
  return [...new Set(paths)];
}
function globMatch(value: string, pattern: string): boolean { const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "(?:.*/)?").replace(/\*/g, ".*").replace(/\?/g, "."); try { return new RegExp(`^${escaped}$`).test(value); } catch { return true; } }

function matchFilePatterns(args: unknown, options: ProtectionOptions): { protected: boolean; byPattern?: string } {
  const paths = extractPaths(args, options.cwd);
  for (const path of paths) for (const pattern of options.protectedFilePatterns || []) {
    if (globMatch(path, pattern)) return { protected: true, byPattern: pattern };
  }
  return { protected: false };
}

/**
 * Prune-style protection: sweep, deduplicate, purge-errors. Always includes
 * `PRUNE_PROTECTED_TOOLS` as a floor on top of the caller's own
 * `protectedTools` list, so a caller cannot accidentally unprotect a
 * mutating tool by leaving its list empty (the strategy defaults do exactly
 * that and rely on this floor).
 */
export function isProtectedTool(name: string, args: unknown, options: ProtectionOptions): boolean {
  if (PRUNE_PROTECTED_TOOLS.has(name) || (options.protectedTools || []).includes(name)) return true;
  return matchFilePatterns(args, options).protected;
}

/**
 * Compression-range protection: matches only the caller-configured
 * `compress.protectedTools` / `protectedFilePatterns`, with no hardcoded
 * floor. A match here does not block the range - it identifies tool output
 * that `appendProtectedToolContent` must fold into the block summary
 * verbatim, mirroring opencode-dynamic-context-pruning's `appendProtectedTools`.
 */
export function compressProtectedMatch(name: string, args: unknown, options: ProtectionOptions): ProtectionMatch {
  if ((options.protectedTools || []).includes(name)) return { protected: true, byTool: name };
  const paths = matchFilePatterns(args, options);
  if (paths.protected) return { protected: true, byPattern: paths.byPattern };
  return { protected: false };
}

/**
 * Absorb protected tool calls' completed output into the summary verbatim
 * instead of letting them block the range that contains them. Runs once per
 * range, over exactly the range's direct units (nested/consumed blocks
 * already folded their own protected content in at the time they were
 * compressed, via their own summary text).
 */
export function appendProtectedToolContent(
  summary: string,
  units: readonly { messageKeys: readonly CanonicalMessageKey[] }[],
  index: CanonicalIndex,
  options: ProtectionOptions,
): string {
  const seenToolCallIds = new Set<string>();
  const sections: string[] = [];
  for (const unit of units) {
    const messages = index.entries
      .filter((item) => unit.messageKeys.some((key) => key.entryId === item.key.entryId && key.projection === item.key.projection))
      .map((item) => item.message);
    const calls = new Map<string, { name: string; arguments: unknown }>();
    for (const message of messages) if (message.role === "assistant") for (const part of message.content) if (part.type === "toolCall") calls.set(part.id, { name: part.name, arguments: canonicalPlainObject(part.arguments) });
    for (const message of messages) {
      if (message.role !== "toolResult" || seenToolCallIds.has(message.toolCallId)) continue;
      const call = calls.get(message.toolCallId);
      if (!call) continue;
      if (!compressProtectedMatch(call.name, call.arguments, options).protected) continue;
      const text = stringifyToolResultText(message.content);
      if (!text) continue;
      seenToolCallIds.add(message.toolCallId);
      sections.push(`\n### Tool: ${call.name}\n${text}`);
    }
  }
  if (!sections.length) return summary;
  return `${summary}\n\nThe following protected tool output was part of this range and is preserved verbatim:${sections.join("")}`;
}

function stringifyToolResultText(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}
