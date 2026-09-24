/**
 * Child Extension Resolution
 *
 * Resolves which extensions should be loaded by child subagent processes.
 *
 * Strategy: read a user-provided config file (subagents-vflo_settings.json) that
 * explicitly lists the extensions the user wants subagents to have access to
 * and optional model/thinking defaults for built-in agents. The packages format
 * matches ~/.pi/agent/settings.json (packages array).
 *
 * This gives users full control over what runs in subagent child processes
 * without needing a blocklist heuristic.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  THINKING_LEVELS,
  type BuiltinAgentModelSettings,
  type BuiltinAgentThinkingSettings,
  type ThinkingLevel,
} from "./types.js";

// ─── Config File Resolution ──────────────────────────────────────────────────

/**
 * Config file name for subagent extension settings.
 * Located in ~/.pi/agent/ alongside the main settings.json.
 */
const CONFIG_FILENAME = "subagents-vflo_settings.json";

interface SubagentSettings {
  /** Extensions to load in child subagent processes (same format as pi settings.packages) */
  packages?: Array<string | { source: string; extensions?: string[] }>;
  /** Default models for the built-in agents. */
  models?: Record<string, unknown>;
  /** Default thinking levels for the built-in agents. */
  thinking?: Record<string, unknown>;
}

function getConfigPath(): string {
  return path.join(os.homedir(), ".pi", "agent", CONFIG_FILENAME);
}

function readConfig(configPath = getConfigPath()): SubagentSettings | null {
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as SubagentSettings;
  } catch {
    return null;
  }
}

/**
 * Read model and thinking defaults for built-in agents from the shared settings.
 *
 * Keep these separate from child extension resolution: models and thinking
 * levels are applied per delegated task, while extension package paths are
 * cached for the parent session. Ignore malformed values so a bad setting does
 * not break dispatch.
 */
export function getConfiguredAgentSettings(configPath = getConfigPath()): {
  models: BuiltinAgentModelSettings;
  thinking: BuiltinAgentThinkingSettings;
} {
  const settings = readConfig(configPath);
  const models = settings?.models;
  const thinking = settings?.thinking;
  const configured: {
    models: BuiltinAgentModelSettings;
    thinking: BuiltinAgentThinkingSettings;
  } = { models: {}, thinking: {} };

  for (const name of ["explore", "build"] as const) {
    const model = models && typeof models === "object" && !Array.isArray(models)
      ? models[name]
      : undefined;
    if (typeof model === "string" && model.trim()) configured.models[name] = model.trim();

    const level = thinking && typeof thinking === "object" && !Array.isArray(thinking)
      ? thinking[name]
      : undefined;
    if (typeof level === "string" && THINKING_LEVELS.includes(level as ThinkingLevel)) {
      configured.thinking[name] = level as ThinkingLevel;
    }
  }

  return configured;
}

// ─── Package Extension Resolution ────────────────────────────────────────────

interface PackageJson {
  name?: string;
  pi?: {
    extensions?: string[];
    themes?: string[];
  };
}

function readPackageJson(packageDir: string): PackageJson | null {
  try {
    const raw = fs.readFileSync(path.join(packageDir, "package.json"), "utf-8");
    return JSON.parse(raw) as PackageJson;
  } catch {
    return null;
  }
}

/**
 * Resolve a package source to its filesystem directory.
 * Handles:
 * - Absolute paths: /path/to/extension
 * - Home-relative paths: ~/path/to/extension
 * - npm packages: npm:@scope/name or npm:name
 * - git packages: git:github.com/user/repo
 */
export function resolvePackageDir(source: string): string | null {
  // Pi settings commonly use ~/... package paths. Child resolution must expand
  // these itself because the path is passed directly to spawn, without a shell.
  const filesystemSource = source === "~"
    ? os.homedir()
    : source.startsWith("~/")
      ? path.join(os.homedir(), source.slice(2))
      : source;

  if (path.isAbsolute(filesystemSource)) {
    if (fs.existsSync(filesystemSource)) return filesystemSource;
    return null;
  }

  // npm package
  if (source.startsWith("npm:")) {
    const pkgName = source.slice(4).replace(/@[\d^~>=<.*]+$/, ""); // strip version
    // Try global node_modules
    const globalPaths = [
      path.join(os.homedir(), ".pi", "agent", "node_modules", pkgName),
      // Pi's package manager installs user packages here.
      path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", pkgName),
      // Standard global node_modules (npm -g)
      ...require("module").globalPaths.map((p: string) => path.join(p, pkgName)),
    ];
    for (const p of globalPaths) {
      if (fs.existsSync(p)) return p;
    }
    // Also try the node_modules alongside pi itself
    try {
      const piModulesBase = path.dirname(require.resolve("@earendil-works/pi-coding-agent/package.json"));
      const piGlobalModules = path.dirname(piModulesBase);
      const candidate = path.join(piGlobalModules, pkgName);
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* ignore */ }
    return null;
  }

  // git package
  if (source.startsWith("git:")) {
    const repoPath = source.slice(4).replace(/@[^/]+$/, ""); // strip version tag
    const gitDir = path.join(os.homedir(), ".pi", "agent", "git", repoPath);
    if (fs.existsSync(gitDir)) return gitDir;
    return null;
  }

  // Relative path (shouldn't happen from settings, but handle)
  return null;
}

/**
 * One-level discovery of extension files inside a directory that has neither
 * its own package.json "pi.extensions" manifest nor an index.ts/js.
 *
 * Mirrors real pi's own fallback for this exact shape (package-manager.js:
 * collectResourceFiles -> collectAutoExtensionEntries in
 * @earendil-works/pi-coding-agent), traced line-by-line rather than assumed:
 * a manifest-declared "pi.extensions" directory entry that has no index file
 * of its own is scanned ONE level deep only. Direct .ts/.js files in that
 * directory load as-is. A SUBdirectory of it loads only if that subdirectory
 * itself has an index.ts/js (real pi also accepts an inner package.json
 * manifest at that same level -- deliberately not replicated here since no
 * package in this allowlist nests a manifest two levels deep; a subdirectory
 * with neither is silently skipped, exactly matching real pi's own behavior,
 * not a gap introduced here).
 *
 * This fixes @henryqw/pi-herdr-rename specifically: its manifest declares
 * "./extensions", and the only file inside is named rename.ts, not index.ts.
 *
 * Known shared hazard, not introduced by this function: a ".d.ts" file's
 * name also ends in ".ts", so it would be treated as an entry point. Real
 * pi's own isExtensionFile() has the identical hazard (plain suffix check,
 * no ".d.ts" exclusion) -- not fixed here, since fixing it would diverge
 * from, rather than match, real pi's behavior.
 */
function discoverExtensionFilesOneLevel(dir: string): string[] {
  const discovered: string[] = [];
  let dirEntries: fs.Dirent[];
  try {
    dirEntries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return discovered;
  }
  // fs.readdirSync order is not guaranteed to be stable across platforms/filesystems.
  // Sort so the resulting -e flag order (and therefore extension load order) is
  // deterministic across runs, independent of raw directory-entry order.
  const sorted = [...dirEntries].sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of sorted) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules") continue;
    const fullPath = path.join(dir, entry.name);
    // Real pi's collectFiles/collectAutoExtensionEntries statSync-resolves symlinks
    // rather than trusting Dirent.isFile()/isDirectory() (which report the link
    // itself, not its target) -- matched here so a symlinked entry isn't silently
    // dropped the way the pre-fix resolver already silently dropped rename.ts.
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const stats = fs.statSync(fullPath);
        isDir = stats.isDirectory();
        isFile = stats.isFile();
      } catch {
        continue;
      }
    }
    if (isFile && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
      discovered.push(fullPath);
    } else if (isDir) {
      const indexTs = path.join(fullPath, "index.ts");
      const indexJs = path.join(fullPath, "index.js");
      if (fs.existsSync(indexTs)) discovered.push(indexTs);
      else if (fs.existsSync(indexJs)) discovered.push(indexJs);
    }
  }
  return discovered;
}

/**
 * Given a package directory, resolve its extension entry points to absolute paths.
 */
export function resolveExtensionEntryPoints(packageDir: string): string[] {
  const pkg = readPackageJson(packageDir);
  if (!pkg?.pi?.extensions) {
    // Fall back: check if index.ts exists
    const indexTs = path.join(packageDir, "index.ts");
    if (fs.existsSync(indexTs)) return [indexTs];
    const indexJs = path.join(packageDir, "index.js");
    if (fs.existsSync(indexJs)) return [indexJs];
    return [];
  }

  const entries: string[] = [];
  for (const ext of pkg.pi.extensions) {
    // Skip disabled entries (prefixed with -)
    if (ext.startsWith("-")) continue;

    const resolved = path.resolve(packageDir, ext);
    if (fs.existsSync(resolved)) {
      // Could be a directory (check for index.ts/js inside)
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        const indexTs = path.join(resolved, "index.ts");
        const indexJs = path.join(resolved, "index.js");
        if (fs.existsSync(indexTs)) entries.push(indexTs);
        else if (fs.existsSync(indexJs)) entries.push(indexJs);
        else entries.push(...discoverExtensionFilesOneLevel(resolved));
      } else {
        entries.push(resolved);
      }
    }
  }
  return entries;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Tell the user when a configured child extension could not be resolved.
 *
 * This is intentionally a warning, not an exception: one optional extension
 * must not prevent every subagent from starting. Keep this at the resolver
 * boundary because this module has the complete configured-source list and can
 * report both failure modes (missing package directory and package with no
 * discoverable entry point) in one message.
 *
 * resolveChildExtensions() caches its result for the parent process lifetime,
 * so this warning is emitted once per resolution, not once per child spawn.
 */
export function warnOnUnresolvedChildExtensions(sources: string[]): void {
  if (sources.length === 0) return;

  const listedSources = sources.map((source) => JSON.stringify(source)).join(", ");
  console.warn(
    `[subagents-vflo] Could not resolve configured child extension package(s): ${listedSources}. ` +
      `They will not be loaded into child processes; check ${getChildExtensionConfigPath()}.`,
  );
}

export interface ChildExtensionResolution {
  /** Resolved absolute paths to extension entry points for child processes. */
  paths: string[];
  /** Sources that couldn't be resolved to a filesystem path. */
  unresolved: string[];
}

/**
 * Resolve extensions for child subagent processes.
 *
 * Reads ~/.pi/agent/subagents-vflo_settings.json which uses the same format as
 * the main pi settings (packages array). Only extensions explicitly listed in
 * this file will be loaded in child processes.
 *
 * If the config file doesn't exist or has no packages, no extensions are loaded
 * (child processes run with --no-extensions only). Provider extensions must be
 * listed here when their models are used by a child process.
 *
 * Results are cached for the lifetime of the process since the config doesn't
 * change during a session.
 */
let cachedResolution: ChildExtensionResolution | null = null;

export function resolveChildExtensions(): ChildExtensionResolution {
  if (cachedResolution) return cachedResolution;

  const result: ChildExtensionResolution = {
    paths: [],
    unresolved: [],
  };

  const config = readConfig();
  if (!config?.packages) {
    cachedResolution = result;
    return result;
  }

  for (const entry of config.packages) {
    const source = typeof entry === "string" ? entry : entry.source;

    // Resolve to filesystem
    const packageDir = resolvePackageDir(source);
    if (!packageDir) {
      result.unresolved.push(source);
      continue;
    }

    // Resolve entry points
    const entryPoints = resolveExtensionEntryPoints(packageDir);
    if (entryPoints.length === 0) {
      result.unresolved.push(source);
    } else {
      result.paths.push(...entryPoints);
    }
  }

  warnOnUnresolvedChildExtensions(result.unresolved);
  cachedResolution = result;
  return result;
}

/**
 * Reset the cached resolution (for testing).
 */
export function resetChildExtensionCache(): void {
  cachedResolution = null;
}

/**
 * Get the expected config file path (for user-facing messages).
 */
export function getChildExtensionConfigPath(): string {
  return getConfigPath();
}
