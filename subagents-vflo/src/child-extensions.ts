/**
 * Child Extension Resolution
 *
 * Resolves which extensions should be loaded by child subagent processes.
 *
 * Strategy: read a user-provided config file (subagents-vflo_settings.json) that
 * explicitly lists the extensions the user wants subagents to have access to.
 * The format matches ~/.pi/agent/settings.json (packages array).
 *
 * This gives users full control over what runs in subagent child processes
 * without needing a blocklist heuristic.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Config File Resolution ──────────────────────────────────────────────────

/**
 * Config file name for subagent extension settings.
 * Located in ~/.pi/agent/ alongside the main settings.json.
 */
const CONFIG_FILENAME = "subagents-vflo_settings.json";

interface SubagentSettings {
  /** Extensions to load in child subagent processes (same format as pi settings.packages) */
  packages?: Array<string | { source: string; extensions?: string[] }>;
}

function getConfigPath(): string {
  return path.join(os.homedir(), ".pi", "agent", CONFIG_FILENAME);
}

function readConfig(): SubagentSettings | null {
  try {
    const configPath = getConfigPath();
    const raw = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as SubagentSettings;
  } catch {
    return null;
  }
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
 * Given a package directory, resolve its extension entry points to absolute paths.
 */
function resolveExtensionEntryPoints(packageDir: string): string[] {
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
      } else {
        entries.push(resolved);
      }
    }
  }
  return entries;
}

// ─── Public API ──────────────────────────────────────────────────────────────

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
