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
  type AgentConfig,
  type CwdResolutionResult,
  type ModelResolutionResult,
  type TaskItem,
  type ToolResolutionResult,
} from "./types.js";
import { canonicalEntryPath } from "./path-utils.js";
import { currentNestingDepth } from "./runner.js";

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
 * pi core tools. pi itself provides them, so they exist in every child even
 * though the child starts with `--no-extensions`. Mirrors pi's `allToolNames`.
 */
export const CORE_TOOLS: readonly string[] = [
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
];

/**
 * What the resolver must know to decide whether a child can have a tool.
 *
 * The design has two independent settings, each with one job:
 * - `packages` in subagents-vflo_settings.json decides which extensions the
 *   child loads. It is the complete list: nothing else is loaded.
 * - The agent's tool list decides which tools the child may use. It becomes
 *   the child's `--tools` allowlist, unchanged.
 *
 * A listed tool is only useful when an extension in `packages` registers it,
 * so the resolver checks every listed name against these two inputs.
 */
export interface ToolResolutionOptions {
  /**
   * Every tool registered in the parent (active or not) → the source path of
   * the extension that registered it, from `pi.getAllTools()`. Registered, not
   * only active, because some extensions keep their tools off until the model
   * asks (pi-web-access keeps `web_search` off until `web_enable`). The parent
   * must not have to turn a tool on for itself to give it to a child.
   */
  parentToolSources: Map<string, string>;
  /** Extension entry points (or `builtin:<name>`) loaded into the child. */
  childExtensionPaths: string[];
  /**
   * True when this session is itself a subagent. Only changes the error text.
   *
   * Why it matters: a subagent's own tool list is its `--tools` allowlist,
   * and pi registers only allowlisted tools. So a subagent can give its
   * children only tools that are in its own list, even when the extension is
   * loaded (builtin:codemode always is). This ceiling is kept on purpose: a
   * child never gets more than the agent that spawns it. But "no extension
   * registers this tool" is misleading there; the fix is in the spawning
   * agent's tool list.
   */
  parentIsSubagent?: boolean;
}

/**
 * Resolve the tool list for a child spawn. One rule:
 *
 * 1. The agent has a tool list (agent file `tools:`, or for built-in agents
 *    the settings file or the bundled fallback) → use it unchanged.
 * 2. The agent has no list → use the parent's active tools that the child
 *    can have (see canChildHave). Tools from extensions that the child does
 *    not load are dropped without an error: otherwise an agent without a list
 *    would fail whenever the parent has any tool from an extension that is
 *    not in `packages`.
 *
 * Nothing is added and nothing else is filtered. An explicit list is checked
 * strictly: a name that the child cannot have stops the spawn with an error
 * that says how to fix it. Names with `*` are pi tool patterns (for example
 * `mcp__docs__*`); they are passed through unchecked because they may match
 * zero or many tools.
 */
export function resolveTools(
  agent: AgentConfig,
  parentActiveToolNames: string[],
  options: ToolResolutionOptions,
): ToolResolutionResult {
  const childPaths = new Set(options.childExtensionPaths.map(canonicalEntryPath));

  if (!agent.tools || agent.tools.length === 0) {
    const tools = parentActiveToolNames.filter(
      (name) => canChildHave(name, options, childPaths) === "ok",
    );
    return { tools: [...new Set(tools)], warnings: [] };
  }

  const problems: string[] = [];
  for (const name of agent.tools) {
    if (name.includes("*")) continue;
    const check = canChildHave(name, options, childPaths);
    if (check === "unknown") {
      problems.push(
        options.parentIsSubagent
          ? `"${name}": this session is a subagent and does not have this tool. A subagent can only give its ` +
              `children tools from its own tool list: add "${name}" to the tool list of the agent that ` +
              `spawned this session (or check the spelling)`
          : `"${name}": no extension in the parent session registers this tool`,
      );
    } else if (check !== "ok") {
      problems.push(
        `"${name}": its extension ${check.missingExtension} is not in "packages" of ${getChildExtensionConfigPath()}`,
      );
    }
  }
  if (problems.length > 0) {
    return {
      tools: [],
      warnings: [],
      error: `Agent "${agent.name}" lists tools that the child cannot have:\n- ${problems.join("\n- ")}`,
    };
  }
  return { tools: [...new Set(agent.tools)], warnings: [] };
}

type ChildToolCheck = "ok" | "unknown" | { missingExtension: string };

/**
 * Whether the child process will have this tool: a pi core tool, or a tool
 * whose extension (as registered in the parent) is in the child's packages.
 */
function canChildHave(
  name: string,
  options: ToolResolutionOptions,
  childPaths: Set<string>,
): ChildToolCheck {
  if (CORE_TOOLS.includes(name)) return "ok";
  const source = options.parentToolSources.get(name);
  if (!source) return "unknown";
  // Both sides are absolute in practice, but symlinks (linked repos, macOS
  // /tmp) or relative settings entries can spell the same entry point
  // differently. `builtin:<name>` sources compare equal on both sides.
  return childPaths.has(canonicalEntryPath(source)) ? "ok" : { missingExtension: source };
}

/** Build the resolver inputs from the live parent session and the settings file. */
export function buildToolResolutionOptions(pi: ExtensionAPI): ToolResolutionOptions {
  const parentToolSources = new Map<string, string>();
  for (const tool of pi.getAllTools()) {
    parentToolSources.set(tool.name, tool.sourceInfo.path);
  }
  return {
    parentToolSources,
    childExtensionPaths: resolveChildExtensions().paths,
    parentIsSubagent: currentNestingDepth() > 0,
  };
}

// ─── Cwd Resolution ──────────────────────────────────────────────────────────

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
