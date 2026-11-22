import { resolve } from "node:path";
import { canonicalPlainObject, isPlainObject } from "../util/canonical-json.ts";
import type { CanonicalIndex, CanonicalMessageKey } from "../identity/types.ts";

// The current Pi built-ins are read, write, edit, bash, grep, find, and ls.
export const PI_BUILTIN_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);

/**
 * Tools whose output/arguments must never be silently cleared by pi-dcp's
 * own PRUNING strategies (sweep, deduplicate), regardless of
 * what a caller's own `protectedTools` config contains. Mutating tools keep
 * the record of what changed; pi-dcp's own `compress` tool call keeps the
 * record that a compression happened (dedup defaults its own
 * `protectedTools` to `[]` and rely on this floor); `todo` keeps the task
 * list legible.
 *
 * This set is a floor for `isProtectedTool()` only. It intentionally does
 * NOT apply to compression ranges (`compressProtectedMatch` /
 * `collectProtectedToolSections` below): a range absorbs matching tool output
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
 * Prune-style protection: sweep and deduplicate. Always includes
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
 * that `collectProtectedToolSections` must fold into the block summary
 * verbatim, mirroring opencode-dynamic-context-pruning's `appendProtectedTools`.
 */
export function compressProtectedMatch(name: string, args: unknown, options: ProtectionOptions): ProtectionMatch {
  if ((options.protectedTools || []).includes(name)) return { protected: true, byTool: name };
  const paths = matchFilePatterns(args, options);
  if (paths.protected) return { protected: true, byPattern: paths.byPattern };
  return { protected: false };
}

/**
 * Marker that opens the protected-output text pi-dcp appends to a block
 * summary. Blocks created earlier contain this exact text, so it is a persisted
 * format: changing one character would hide older protected output from
 * extractProtectedSection.
 */
const PROTECTED_SECTION_INTRO = "The following protected tool output was part of this range and is preserved verbatim:";
const PROTECTED_SECTION_START = `\n\n${PROTECTED_SECTION_INTRO}`;

/**
 * Verbatim protected output of one range's own tool calls, as one body string
 * (each call appends "\n### Tool: NAME\nTEXT"). Protected output is absorbed
 * into the summary instead of blocking the range.
 *
 * A range spans its merged child blocks, so `units` includes their raw tool
 * calls too. Calls that a child already covers are skipped: the child stores
 * its own protected output (see extractProtectedSection). Collecting it again
 * from raw history could repeat it with different text, for example after a
 * host edit. A child created before a protection setting existed has no such
 * output, so its stored summary is the authoritative record of what it kept.
 */
export function collectProtectedToolSections(
  units: readonly { messageKeys: readonly CanonicalMessageKey[] }[],
  index: CanonicalIndex,
  options: ProtectionOptions,
  coveredToolCallIds: ReadonlySet<string> = new Set(),
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
      if (message.role !== "toolResult" || seenToolCallIds.has(message.toolCallId) || coveredToolCallIds.has(message.toolCallId)) continue;
      const call = calls.get(message.toolCallId);
      if (!call) continue;
      if (!compressProtectedMatch(call.name, call.arguments, options).protected) continue;
      const text = stringifyToolResultText(message.content);
      if (!text) continue;
      seenToolCallIds.add(message.toolCallId);
      sections.push(`\n### Tool: ${call.name}\n${text}`);
    }
  }
  return sections.join("");
}

/**
 * Append protected output once, after the authored text, under one intro.
 *
 * `bodies` is ordered: each merged child's body first, then the range's own.
 * A body identical to an earlier one is not repeated. Bodies are compared
 * whole and never split: splitting at "### Tool:" would cut verbatim tool
 * output that itself contains such a line. The cost is that two bodies which
 * only partly overlap are both kept, which repeats some text but drops none.
 */
export function appendProtectedSections(summary: string, bodies: readonly string[]): string {
  const kept: string[] = [];
  for (const body of bodies) if (body && !kept.includes(body)) kept.push(body);
  return kept.length ? `${summary}${PROTECTED_SECTION_START}${kept.join("")}` : summary;
}

/**
 * Recover the protected output a block already carries, so that a merge can
 * copy it into its new summary. Without this, merging would drop protected
 * output from the model's view, because the children's summaries disappear.
 *
 * Blocks created by this code have summary = authoredSummary + one protected
 * suffix. The suffix is found by position, so neither the authored text nor
 * tool output can be mistaken for the marker. Legacy blocks, which pasted child
 * summaries in, do not start with their authored text. For them the first
 * marker is used. That can over-carry text pasted after it, which is the safe
 * failure: protected output is never dropped.
 */
export function extractProtectedSection(block: { summary: string; authoredSummary: string }): string {
  const { summary, authoredSummary } = block;
  if (summary.startsWith(authoredSummary)) {
    const suffix = summary.slice(authoredSummary.length);
    return suffix.startsWith(PROTECTED_SECTION_START) ? suffix.slice(PROTECTED_SECTION_START.length) : "";
  }
  const at = summary.indexOf(PROTECTED_SECTION_START);
  return at < 0 ? "" : summary.slice(at + PROTECTED_SECTION_START.length);
}

function stringifyToolResultText(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}
