import { resolve } from "node:path";
import { canonicalPlainObject, isPlainObject } from "../util/canonical-json.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

// Pi 0.84.1's built-ins are read, write, edit, bash, grep, find, and ls.
// Protect mutating tools, the active todo extension, and DCP's own compression
// tool by default. Read-only tools and bash remain compressible because
// protecting bash would prevent compression of most normal coding sessions;
// users can add it explicitly.
export const PI_BUILTIN_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);
export const ALWAYS_PROTECTED_TOOLS = new Set(["compress", "write", "edit", "todo"]);
export const SUMMARY_PROTECTED_TOOLS = new Set(["todo"]);
const PATH_KEYS = new Set(["path", "filePath", "filepath", "target"]);

export interface ProtectionOptions { protectedTools?: readonly string[]; protectedFilePatterns?: readonly string[]; cwd: string; }
export function effectiveProtectedTools(options: ProtectionOptions): Set<string> { return new Set([...ALWAYS_PROTECTED_TOOLS, ...SUMMARY_PROTECTED_TOOLS, ...(options.protectedTools || [])]); }
export function isProtectedTool(name: string, args: unknown, options: ProtectionOptions): boolean { if (effectiveProtectedTools(options).has(name)) return true; const paths = extractPaths(args, options.cwd); return paths.some((path) => (options.protectedFilePatterns || []).some((pattern) => globMatch(path, pattern))); }
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
export function protectUnit(messages: readonly AgentMessage[], options: ProtectionOptions): boolean {
  return messages.some((message) => message.role === "assistant" && message.content.some((part) => part.type === "toolCall" && isProtectedTool(part.name, canonicalPlainObject(part.arguments), options)));
}
