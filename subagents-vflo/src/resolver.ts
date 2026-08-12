/**
 * Resolution helpers for model, tools, cwd, and prompt.
 *
 * These deterministically resolve the effective configuration for each child spawn.
 */

import * as fs from "node:fs";
import * as path from "node:path";
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
 * Resolve the tool list for a child spawn.
 * Result is always a built-in-only list. Extension tools and "subagent" are never forwarded.
 */
export function resolveTools(
  agent: AgentConfig,
  parentActiveToolNames: string[],
): ToolResolutionResult {
  const warnings: string[] = [];

  // If agent declares tools explicitly, validate them
  if (agent.tools && agent.tools.length > 0) {
    const invalid = agent.tools.filter(
      (t) => !ALLOWED_CHILD_BUILTINS.includes(t as AllowedChildBuiltin),
    );
    if (invalid.length > 0) {
      return {
        tools: [],
        warnings,
        error: `Agent "${agent.name}" declares invalid tools: ${invalid.join(", ")}. Allowed: ${ALLOWED_CHILD_BUILTINS.join(", ")}`,
      };
    }
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
