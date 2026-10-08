/**
 * Resolution helpers for model, tools, cwd, and prompt.
 *
 * These deterministically resolve the effective configuration for each child spawn.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CODEMODE_TOOL, getChildExtensionConfigPath, resolveChildExtensions } from "./child-extensions.js";
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
import { canonicalEntryPath } from "./path-utils.js";

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
 *    built-ins. The per-agent MCP inheritance policy can add a filtered set
 *    of parent-active MCP names to that allowlist.
 *
 * Both keys must match for an extension tool to be usable. The resolver can
 * only verify the second key plus that the tool exists in the parent; the
 * first key is checked against resolved child extension paths when the caller
 * supplies them, producing a warning (not an error) on mismatch.
 */
export interface ToolResolutionOptions {
  /**
   * Extension tool name → path of the extension entry point that registered
   * it, from the parent's `pi.getAllTools()`. Real extension paths and the
   * `builtin:mcp` identifier are included; other synthetic sources are omitted.
   */
  extensionToolSources?: Map<string, string>;
  /** Extension entry-point paths that will be loaded into the child process. */
  childExtensionPaths?: string[];
  /**
   * Metadata for tools registered by `builtin:mcp`. Parent-active names are
   * checked separately, so registered but inactive tools are never inherited.
   */
  mcpTools?: Map<string, { annotations?: { readOnlyHint?: boolean }; exposure?: string }>;
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
 * Optional tools (`agent.optionalTools`, built-in agents only) are appended
 * when the parent has them active and dropped silently when it does not. They go through the same child-backing check as declared tools.
 *
 * MCP inheritance is a separate, per-agent policy. It only includes MCP tools
 * that are active in the parent and backed by the built-in MCP extension.
 * `read-only` also requires `readOnlyHint: true`; MCP annotations are supplied
 * by the server author and are not a security boundary. Custom agents inherit
 * no MCP tools unless they explicitly declare them in `tools:`.
 */
export function resolveTools(
  agent: AgentConfig,
  parentActiveToolNames: string[],
  options: ToolResolutionOptions = {},
): ToolResolutionResult {
  const result = resolveAgentTools(agent, parentActiveToolNames, options);
  if (result.error) return result;

  // Codemode follows the parent, for every agent and whatever its tools:
  // list says. It grants no new power (a script can only call tools already
  // active in the child), so the per-agent allowlist still decides what the
  // child can do. Agent files do not have to opt in one by one. The child then
  // has codemode active too, so its own subagents (grandchildren) inherit it
  // through this same rule. The spawn loads `builtin:codemode` to back it; see
  // withRequiredChildExtensions().
  if (parentActiveToolNames.includes(CODEMODE_TOOL) && !result.tools.includes(CODEMODE_TOOL)) {
    return { ...result, tools: [...result.tools, CODEMODE_TOOL] };
  }
  return result;
}

/** Per-agent tool resolution, before the parent-inherited codemode rule. */
function resolveAgentTools(
  agent: AgentConfig,
  parentActiveToolNames: string[],
  options: ToolResolutionOptions,
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

    // Optional tools are soft: a parent without pi-dcp must still be able to
    // run explore and build. Passing a name the parent lacks would hard-fail
    // the check above. Drop missing optional tools silently: that is a normal
    // setup, and a warning on every spawn would only be noise.
    const optional = (agent.optionalTools ?? []).filter(
      (tool) => !agent.tools!.includes(tool) && parentActiveToolNames.includes(tool),
    );
    const inheritedMcp = inheritMcpTools(agent, parentActiveToolNames, options);
    const tools = [...new Set([...agent.tools, ...optional, ...inheritedMcp])];

    warnOnUnbackedExtensionTools(tools, options, warnings);

    return { tools, warnings };
  }

  // Inherit built-in tools from the parent; MCP tools use the separate policy above.
  const inheritedBuiltins = parentActiveToolNames.filter((name) =>
    ALLOWED_CHILD_BUILTINS.includes(name as AllowedChildBuiltin),
  );

  const inheritedMcp = inheritMcpTools(agent, parentActiveToolNames, options);
  if (inheritedBuiltins.length > 0) {
    const tools = [...new Set([...inheritedBuiltins, ...inheritedMcp])];
    warnOnUnbackedExtensionTools(tools, options, warnings);
    return { tools, warnings };
  }

  // Fallback to DEFAULT_BUILD_TOOLS
  warnings.push("No built-in tools inherited from parent, using default build tools");
  const tools = [...new Set([...DEFAULT_BUILD_TOOLS, ...inheritedMcp])];
  warnOnUnbackedExtensionTools(tools, options, warnings);
  return { tools, warnings };
}

/** Apply an agent's MCP policy to the parent's active MCP tool set. */
function inheritMcpTools(
  agent: AgentConfig,
  parentActiveToolNames: string[],
  options: ToolResolutionOptions,
): string[] {
  const mcpTools = options.mcpTools;
  if (!agent.mcpToolInheritance || agent.mcpToolInheritance === "none" || !mcpTools) return [];

  return parentActiveToolNames.filter((name) => {
    const info = mcpTools.get(name);
    if (!info || info.exposure === "hidden") return false;
    return agent.mcpToolInheritance !== "read-only" || info.annotations?.readOnlyHint === true;
  });
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
    // The spawn always loads builtin:codemode when codemode is in --tools.
    if (tool === CODEMODE_TOOL) continue;
    const sourcePath = options.extensionToolSources.get(tool);
    if (sourcePath && !childPaths.includes(canonicalEntryPath(sourcePath))) {
      warnings.push(
        `Tool "${tool}" is provided by ${sourcePath}, which is not listed in ${getChildExtensionConfigPath()}; the child will not have it`,
      );
    }
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
  const mcpTools = new Map<string, { annotations?: { readOnlyHint?: boolean }; exposure?: string }>();
  for (const tool of pi.getAllTools()) {
    if (tool.sourceInfo.path === "builtin:mcp") {
      // ToolInfo in older Pi releases does not expose annotations or exposure.
      // In that case Explore fails closed, while Build can still inherit the
      // parent's active MCP tools by name.
      const metadata = tool as typeof tool & {
        annotations?: { readOnlyHint?: boolean };
        exposure?: string;
      };
      // The MCP extension uses a synthetic source path, but the child still
      // needs `builtin:mcp` in its configured package list to register names.
      extensionToolSources.set(tool.name, "builtin:mcp");
      mcpTools.set(tool.name, { annotations: metadata.annotations, exposure: metadata.exposure });
    } else if (!tool.sourceInfo.path.startsWith("<")) {
      extensionToolSources.set(tool.name, tool.sourceInfo.path);
    }
  }
  return { extensionToolSources, childExtensionPaths: resolveChildExtensions().paths, mcpTools };
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
