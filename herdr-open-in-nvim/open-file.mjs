#!/usr/bin/env node
/**
 * Herdr link-handler action: open the Ctrl+clicked file link in nvim.
 *
 * Herdr runs this with no TTY and gives the raw OSC 8 URI in
 * HERDR_PLUGIN_CLICKED_URL. We turn it into an absolute file path and an
 * optional line, then ask Herdr to open this plugin's `nvim` pane entrypoint
 * as a split to the right of the clicked pane. See herdr-plugin.toml for why
 * it is a plugin pane.
 *
 * Errors cannot be printed to the user (no TTY), so they go to a Herdr toast.
 * stderr still lands in `herdr plugin log list --plugin vflo.open-in-nvim`.
 *
 * Plain .mjs with no dependencies: Herdr runs it with `node` directly, and
 * there is too little code to justify a build step.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Herdr sets HERDR_BIN_PATH for plugin commands; it is the portable way back in. */
const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const PLUGIN_ID = process.env.HERDR_PLUGIN_ID || "vflo.open-in-nvim";

// ─── Herdr CLI ───────────────────────────────────────────────────────────────

/**
 * Run one herdr command and return the parsed `.result`, or throw.
 * The error envelope can be on stdout or stderr depending on the Herdr
 * version, so a non-zero exit is reported with both streams.
 */
function herdr(args) {
  const res = spawnSync(HERDR, args, { encoding: "utf8", timeout: 10_000 });
  if (res.error) throw new Error(`herdr ${args[0]} failed: ${res.error.message}`);
  if (res.status !== 0) {
    const detail = `${res.stderr || ""}${res.stdout || ""}`.trim();
    throw new Error(`herdr ${args.slice(0, 2).join(" ")} failed: ${detail}`);
  }
  try {
    return JSON.parse(res.stdout).result;
  } catch {
    // Some commands print nothing useful on success; callers that need the
    // result check for undefined.
    return undefined;
  }
}

/** Best effort: a failing toast must not hide the original error. */
function toast(title, body) {
  spawnSync(HERDR, ["notification", "show", title, "--body", body], { timeout: 5_000 });
}

// ─── Link -> file ────────────────────────────────────────────────────────────

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Turn a clicked URI into `{ path, line }`. `path` is absolute and may not
 * exist; the caller decides what to do then.
 *
 * Accepted shapes (they match the regex in herdr-plugin.toml):
 *   file:///abs/a%20b.rs            Pi tool headers (percent-encoded)
 *   plans/x.md, /abs/x.md           Markdown hrefs in agent replies
 *   x.md#L42, x.md#L42-L50          GitHub-style fragment
 *   x.md:42, x.md:42:7              compiler-style suffix (column dropped:
 *                                   nvim's `+N` only takes a line)
 *
 * @param {string} uri  raw OSC 8 URI
 * @param {string} baseCwd  directory that relative paths are relative to
 */
export function resolveLink(uri, baseCwd) {
  let rest = uri;
  let line;

  // A '#' in a real file name would be percent-encoded in a URL, and agents
  // do not write such names, so the first '#' starts the fragment.
  const hash = rest.indexOf("#");
  if (hash !== -1) {
    const match = /^L(\d+)/.exec(rest.slice(hash + 1));
    if (match) line = Number(match[1]);
    rest = rest.slice(0, hash);
  }

  let filePath;
  if (rest.startsWith("file://")) {
    filePath = fileURLToPath(rest);
  } else {
    // marked (Pi's Markdown parser) percent-encodes hrefs, so "a b.md"
    // arrives as "a%20b.md". A malformed escape means it was not encoded.
    try {
      filePath = decodeURIComponent(rest);
    } catch {
      filePath = rest;
    }
    // Relative hrefs are relative to the agent's cwd, which the caller gives.
    filePath = path.resolve(baseCwd, filePath);
  }

  // Strip ":LINE[:COL]" only when the literal path is not a file, so a file
  // whose real name ends in ":12" still opens.
  if (!isFile(filePath)) {
    // Lazy `.*?`: a greedy one would read "x.rs:42:7" as file "x.rs:42".
    const match = /^(.*?):(\d+)(?::\d+)?$/.exec(filePath);
    if (match && isFile(match[1])) {
      filePath = match[1];
      line ??= Number(match[2]);
    }
  }

  return { path: filePath, line };
}

// ─── nvim lookup ─────────────────────────────────────────────────────────────

/**
 * Absolute path to nvim. PATH first, then common user install dirs.
 *
 * Why the fallbacks: the plugin inherits the Herdr server's PATH, and that
 * PATH comes from a non-login shell, so dirs that only ~/.profile adds
 * (here ~/bin, where nvim is linked) are missing.
 */
function findNvim() {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  dirs.push(path.join(os.homedir(), "bin"), path.join(os.homedir(), ".local", "bin"));
  for (const dir of dirs) {
    const candidate = path.join(dir, "nvim");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

// ─── main ────────────────────────────────────────────────────────────────────

function main() {
  const uri = process.env.HERDR_PLUGIN_CLICKED_URL;
  if (!uri) throw new Error("HERDR_PLUGIN_CLICKED_URL is not set; run this from a link click.");

  let context = {};
  try {
    context = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
  } catch {
    // Fall back to the plain env vars below.
  }

  // For link clicks Herdr builds the context from the CLICKED pane, so
  // focused_pane_id is that pane even if focus was somewhere else.
  const paneId = context.focused_pane_id || process.env.HERDR_PANE_ID;
  if (!paneId) throw new Error("No clicked pane id in the plugin context.");

  // Relative hrefs are written by the agent, so they are relative to the
  // agent PROCESS cwd. `foreground_cwd` is that process; `cwd` is the pane's
  // shell, which can differ if pi was started with a path argument.
  const pane = herdr(["pane", "get", paneId])?.pane ?? {};
  const baseCwd =
    pane.foreground_cwd || pane.cwd || context.focused_pane_cwd || context.workspace_cwd || os.homedir();

  const { path: filePath, line } = resolveLink(uri, baseCwd);

  // ls headers link directories. The user asked to ignore them, silently.
  if (isDirectory(filePath)) return;
  if (!isFile(filePath)) {
    toast("Open in nvim: file not found", filePath);
    process.exitCode = 1;
    return;
  }

  const nvim = findNvim();
  if (!nvim) {
    toast("Open in nvim: nvim not found", "Not on PATH, ~/bin, or ~/.local/bin.");
    process.exitCode = 1;
    return;
  }

  // nvim's cwd = the agent's cwd, so project-relative tools (:find, pickers,
  // LSP root detection) behave as if nvim was started next to the agent.
  const env = [`VFLO_NVIM_BIN=${nvim}`, `VFLO_NVIM_FILE=${filePath}`];
  if (line) env.push(`VFLO_NVIM_LINE=${line}`);
  herdr([
    "plugin", "pane", "open",
    "--plugin", PLUGIN_ID,
    "--entrypoint", "nvim",
    "--placement", "split",
    "--target-pane", paneId,
    "--direction", "right",
    "--cwd", isDirectory(baseCwd) ? baseCwd : path.dirname(filePath),
    "--focus",
    ...env.flatMap((kv) => ["--env", kv]),
  ]);
}

// Only run when executed, so resolveLink can be imported for a quick check.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (err) {
    console.error(err?.stack || String(err));
    toast("Open in nvim failed", err?.message || String(err));
    process.exitCode = 1;
  }
}
