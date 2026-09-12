/**
 * Resolution helpers for model, tools, cwd, and prompt.
 *
 * These deterministically resolve the effective configuration for each child spawn.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getChildExtensionConfigPath, resolveChildExtensions } from "./child-extensions.js";
import {
  ALLOWED_CHILD_BUILTINS,
  type AgentConfig,
  type AllowedChildBuiltin,
  type CwdResolutionResult,
  DEFAULT_BUILD_TOOLS,
  type ModelResolutionResult,
  type TaskItem,
  type ToolResolutionResult,
} from "./types.js";

// ─── Model Resolution ────────────────────────────────────────────────────────

export interface ModelRegistry {
  resolve(modelStr: string): { provider: string; id: string } | undefined;
  getParentModel(): { provider: string; id: string } | undefined;
}

/**
 * Resolve the model for a child spawn.
 * Priority: task.model → agent.model → parent model
 *
 * Accepted forms:
 * - exact "provider/model-id"
 * - exact unique bare "model-id" (only if uniquely resolvable)
 *
 * Rejected: fuzzy aliases, partial substrings, ambiguous bare ids
 */
export function resolveModel(
  task: TaskItem,
  agent: AgentConfig,
  registry: ModelRegistry,
): ModelResolutionResult {
  const warnings: string[] = [];

  // Try task.model first
  if (task.model) {
    const resolved = registry.resolve(task.model);
    if (resolved) {
      return { model: `${resolved.provider}/${resolved.id}`, warnings };
    }
    warnings.push(`Task model "${task.model}" not found or ambiguous, trying agent model`);
  }

  // Try agent.model
  if (agent.model) {
    const resolved = registry.resolve(agent.model);
    if (resolved) {
      return { model: `${resolved.provider}/${resolved.id}`, warnings };
    }
    warnings.push(
      `Agent "${agent.name}" model "${agent.model}" not available, falling back to parent model`,
    );
  }

  // Fall back to parent model
  const parentModel = registry.getParentModel();
  if (parentModel) {
    return { model: `${parentModel.provider}/${parentModel.id}`, warnings };
  }

  // No model available at all — this is fatal
  return { model: undefined, warnings: [...warnings, "No model available (parent model not set)"] };
}

// ─── Tool Resolution ─────────────────────────────────────────────────────────

/**
 * Inputs for validating agent-declared tools against what a child process can
 * actually run.
 *
 * A child's real toolset is the intersection of two independent keys:
 *
 * 1. `subagents-vflo_settings.json` decides which extensions are loaded into
 *    the child (the spawn is `--no-extensions` plus one `-e` per listed
 *    package). A tool that no loaded extension registers does not exist in
 *    the child at all.
 * 2. The agent's `tools:` frontmatter becomes the child's `--tools` argv.
 *    pi core treats that list as an allowlist for extension tools as well as
 *    built-ins, so an extension tool is active only when its name is passed
 *    through here.
 *
 * Both keys must match for an extension tool to be usable. The resolver can
 * only verify the second key plus that the tool exists in the parent; the
 * first key is checked against resolved child extension paths when the caller
 * supplies them, producing a warning (not an error) on mismatch.
 */
export interface ToolResolutionOptions {
  /**
   * Extension tool name → path of the extension entry point that registered
   * it, from the parent's `pi.getAllTools()`. Synthetic sources
   * (`<builtin:…>`, `<sdk:…>`) are excluded by the caller.
   */
  extensionToolSources?: Map<string, string>;
  /** Extension entry-point paths that will be loaded into the child process. */
  childExtensionPaths?: string[];
}

/**
 * Resolve the tool list for a child spawn.
 *
 * Declared tools are validated per-key:
 * - built-in tools must be in ALLOWED_CHILD_BUILTINS;
 * - extension tools must be active in the parent session. Declaring a tool
 *   that is neither is a hard error. A declared extension tool whose providing
 *   extension is not loaded into the child only warns: the child still starts,
 *   but the model cannot call a tool that does not exist there.
 *
 * When the agent declares no tools, only built-in tools are inherited from the
 * parent. Extension tools stay off unless an agent explicitly declares them,
 * so default and specialist agents keep least-privilege toolsets and their
 * prompts stay free of unrelated extension tool guidelines.
 */
export function resolveTools(
  agent: AgentConfig,
  parentActiveToolNames: string[],
  options: ToolResolutionOptions = {},
): ToolResolutionResult {
  const warnings: string[] = [];

  // If agent declares tools explicitly, validate them
  if (agent.tools && agent.tools.length > 0) {
    const invalid = agent.tools.filter(
      (t) =>
        !ALLOWED_CHILD_BUILTINS.includes(t as AllowedChildBuiltin) &&
        !parentActiveToolNames.includes(t),
    );
    if (invalid.length > 0) {
      return {
        tools: [],
        warnings,
        error: `Agent "${agent.name}" declares invalid tools: ${invalid.join(", ")}. Allowed: built-in tools (${ALLOWED_CHILD_BUILTINS.join(", ")}) or tools active in the current parent session (extension tools)`,
      };
    }

    warnOnUnbackedExtensionTools(agent.tools, options, warnings);

    return { tools: [...agent.tools], warnings };
  }

  // Inherit only built-in tools from the parent
  const inheritedBuiltins = parentActiveToolNames.filter((name) =>
    ALLOWED_CHILD_BUILTINS.includes(name as AllowedChildBuiltin),
  );

  if (inheritedBuiltins.length > 0) {
    return { tools: inheritedBuiltins, warnings };
  }

  // Fallback to DEFAULT_BUILD_TOOLS
  warnings.push("No built-in tools inherited from parent, using default build tools");
  return { tools: [...DEFAULT_BUILD_TOOLS], warnings };
}

// ─── Cwd Resolution ──────────────────────────────────────────────────────────

/**
 * Warn (never error) about declared extension tools whose providing extension
 * is not among the extensions loaded into the child.
 *
 * The declared name flows into the child's --tools as pure permission; pi core
 * activates it only if something actually registers it there. Without the
 * backing extension the tool is silently absent, so surface the mismatch at
 * spawn time instead of at first tool call. The parent's and the child's
 * entry-point resolution both come from each package's `pi.extensions` field,
 * so exact paths match in practice; a path mismatch costs at worst a spurious
 * warning, never a false pass.
 */
function warnOnUnbackedExtensionTools(
  declaredTools: string[],
  options: ToolResolutionOptions,
  warnings: string[],
): void {
  if (!options.extensionToolSources || !options.childExtensionPaths) return;

  // Both sides are absolute in practice, but symlinks (linked repos, macOS
  // /tmp), trailing separators, or relative settings entries can make the
  // same entry point differ textually. Canonicalize best-effort before
  // comparing; on any fs error fall back to lexical resolution. A leftover
  // mismatch costs at worst a spurious warning, never a false pass.
  const childPaths = options.childExtensionPaths.map(canonicalEntryPath);

  for (const tool of declaredTools) {
    if (ALLOWED_CHILD_BUILTINS.includes(tool as AllowedChildBuiltin)) continue;
    const sourcePath = options.extensionToolSources.get(tool);
    if (sourcePath && !childPaths.includes(canonicalEntryPath(sourcePath))) {
      warnings.push(
        `Tool "${tool}" is provided by ${sourcePath}, which is not listed in ${getChildExtensionConfigPath()}; the child will not have it`,
      );
    }
  }
}

/** Best-effort canonicalization for entry-point path comparison. */
function canonicalEntryPath(entryPath: string): string {
  try {
    return fs.realpathSync.native(entryPath);
  } catch {
    // Non-existent or inaccessible path: keep the resolved spelling.
    return path.resolve(entryPath);
  }
}

/**
 * Derive the two-key validation inputs from the live parent session.
 *
 * Combines the child extension list (settings file → what CAN exist in a
 * child) with a map of each parent-active extension tool to the entry point
 * that registered it. Built-ins and SDK synthetic sources ("<builtin:…>",
 * "<sdk:…>") are excluded — only real extension paths are meaningful for the
 * child-extension comparison.
 */
export function buildToolResolutionOptions(pi: ExtensionAPI): ToolResolutionOptions {
  const extensionToolSources = new Map<string, string>();
  for (const tool of pi.getAllTools()) {
    if (!tool.sourceInfo.path.startsWith("<")) {
      extensionToolSources.set(tool.name, tool.sourceInfo.path);
    }
  }
  return { extensionToolSources, childExtensionPaths: resolveChildExtensions().paths };
}

/**
 * Resolve working directory for a child spawn.
 * Priority: task.cwd → parent cwd
 */
export function resolveCwd(task: TaskItem, parentCwd: string): CwdResolutionResult {
  if (!task.cwd) {
    return { cwd: parentCwd };
  }

  // Resolve relative paths against parent cwd
  const resolved = path.isAbsolute(task.cwd)
    ? task.cwd
    : path.resolve(parentCwd, task.cwd);

  // Validate existence and type
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return { cwd: parentCwd, error: `cwd "${resolved}" is not a directory` };
    }
  } catch {
    return { cwd: parentCwd, error: `cwd "${resolved}" does not exist` };
  }

  return { cwd: resolved };
}
