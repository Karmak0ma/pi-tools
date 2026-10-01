#!/usr/bin/env node
/**
 * Rename the Herdr agent in the focused pane.
 *
 *   node rename-agent.mjs --action   run by the plugin action (no TTY)
 *   node rename-agent.mjs --popup    run by Herdr inside the popup (TTY)
 *
 * The work is split in two because Herdr gives an action command no terminal.
 * The action resolves and validates the target, then asks Herdr to open the
 * popup entrypoint, which owns the input line.
 *
 * The name is stored ONLY by Herdr (`herdr agent rename`). This file keeps no
 * name state of its own, so every Herdr view (sidebar, pane borders, Radar,
 * `agent list`) shows the same name without extra code.
 *
 * Why this is a standalone .mjs and does not import src/herdr.ts: Herdr runs
 * plugin commands with plain `node`, and src/herdr.ts uses TypeScript
 * parameter properties, which Node's built-in type stripping cannot run.
 * The two CLI calls here do not justify a build step for the plugin.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

/** Herdr sets HERDR_BIN_PATH for plugin commands; it is the portable way back in. */
const HERDR = process.env.HERDR_BIN_PATH || "herdr";

/** Env keys that carry the target from the action into the popup process. */
const TARGET_PANE_ENV = "VFLO_RENAME_PANE_ID";
const CURRENT_NAME_ENV = "VFLO_RENAME_CURRENT_NAME";
const AGENT_KIND_ENV = "VFLO_RENAME_AGENT_KIND";

// ─── Herdr CLI ───────────────────────────────────────────────────────────────

/** Parse a stream as one JSON object, or return null. */
function parseJson(text) {
  const trimmed = (text || "").trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Run one herdr command and normalize the result to
 * `{ ok: true, result }` or `{ ok: false, code, message }`.
 *
 * The error envelope is searched on BOTH streams. herdr 0.9.0 writes it to
 * stderr, older versions wrote it to stdout; src/herdr.ts documents how
 * trusting one stream silently lost every error code before.
 */
function herdr(args) {
  const res = spawnSync(HERDR, args, { encoding: "utf8", timeout: 10_000 });
  if (res.error) return { ok: false, code: "spawn_failed", message: res.error.message };
  for (const stream of [res.stdout, res.stderr]) {
    const envelope = parseJson(stream);
    if (envelope?.error) {
      return { ok: false, code: envelope.error.code ?? "error", message: envelope.error.message ?? "" };
    }
  }
  if (res.status !== 0) {
    const line = (res.stderr || res.stdout || "").trim().split("\n", 1)[0];
    return { ok: false, code: "exit_" + res.status, message: line || "no output" };
  }
  return { ok: true, result: parseJson(res.stdout)?.result ?? null };
}

/**
 * Show a short, non-fatal message in the Herdr UI. A failed notification is
 * only logged: the action already failed softly, and a second failure must
 * not turn into a crash.
 */
function notify(title, body) {
  const args = ["notification", "show", title];
  if (body) args.push("--body", body);
  const res = herdr(args);
  if (!res.ok) process.stderr.write(`notification failed: ${res.code}: ${res.message}\n`);
  // Also keep it in the plugin log (`herdr plugin log`) for later diagnosis.
  process.stderr.write(`${title}${body ? `: ${body}` : ""}\n`);
}

// ─── Step 1: action ──────────────────────────────────────────────────────────

function runAction() {
  let context = {};
  try {
    context = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}") ?? {};
  } catch {
    // An unreadable context is treated like a missing focused pane below.
  }

  // focused_pane_id is the pane that had focus when the key was pressed.
  // HERDR_PANE_ID is not used: for an action it is not guaranteed to be the
  // focused pane, and the user wants "the pane I am looking at".
  const paneId = context.focused_pane_id;
  if (!paneId) {
    notify("No focused pane");
    return;
  }

  // `agent get` is the validation AND the source of the current name.
  // context.focused_pane_agent alone is not enough: it has no name.
  const got = herdr(["agent", "get", paneId]);
  if (!got.ok) {
    if (got.code === "agent_not_found") notify("No agent in focused pane");
    else notify("Cannot rename agent", `${got.code}: ${got.message}`);
    return;
  }
  const agent = got.result?.agent ?? {};

  // The target is passed explicitly instead of letting the popup re-read the
  // focused pane: focus can change between the key press and the popup start,
  // and the rename must apply to the pane that was validated here.
  const opened = herdr([
    "plugin", "pane", "open",
    "--plugin", process.env.HERDR_PLUGIN_ID || "vflo.subagents",
    "--entrypoint", "rename-agent",
    "--cwd", path.dirname(fileURLToPath(import.meta.url)),
    "--env", `${TARGET_PANE_ENV}=${paneId}`,
    "--env", `${CURRENT_NAME_ENV}=${agent.name ?? ""}`,
    "--env", `${AGENT_KIND_ENV}=${agent.display_agent ?? agent.agent ?? ""}`,
  ]);
  if (!opened.ok) {
    // ui_busy is the expected case: another Herdr modal is already open.
    notify("Cannot open rename popup", opened.code === "ui_busy" ? "Close the other dialog first" : opened.message);
  }
}

// ─── Step 2: popup ───────────────────────────────────────────────────────────

const ESC = "\x1b";
const CLEAR = `${ESC}[2J${ESC}[H`;
const DIM = `${ESC}[2m`;
const RED = `${ESC}[31m`;
const BOLD = `${ESC}[1m`;
const RESET = `${ESC}[0m`;

function runPopup() {
  const paneId = process.env[TARGET_PANE_ENV];
  const kind = process.env[AGENT_KIND_ENV];
  // Prefill with the current name so a small edit is a small edit.
  let value = process.env[CURRENT_NAME_ENV] ?? "";
  let error = "";

  if (!paneId || !process.stdin.isTTY) {
    // Only reachable when the popup is opened by hand, not through the action.
    process.stderr.write("rename-agent: open this through the rename-current-agent action\n");
    process.exit(1);
  }

  const render = () => {
    process.stdout.write(
      CLEAR +
        ` ${BOLD}Rename agent${RESET} ${DIM}${paneId}${kind ? ` · ${kind}` : ""}${RESET}\n\n` +
        ` > ${value}\n\n` +
        ` ${DIM}Enter rename · Esc cancel · empty clears${RESET}\n` +
        (error ? ` ${RED}${error}${RESET}` : ""),
    );
    // Park the terminal cursor at the end of the input on line 3.
    process.stdout.write(`${ESC}[3;${4 + value.length}H`);
  };

  const exit = (code) => {
    process.stdin.setRawMode(false);
    process.exit(code);
  };

  const submit = () => {
    // Empty input maps to Herdr's own "no name" state (`--clear`, name: null
    // in the socket API). The CLI rejects an empty string, so sending "" would
    // only produce an error; clearing is the native meaning of "no name".
    const name = value.trim();
    const res = herdr(name ? ["agent", "rename", paneId, name] : ["agent", "rename", paneId, "--clear"]);
    if (res.ok) exit(0);
    // Keep the popup open so the user can fix the name. Herdr is the only
    // validator (format, uniqueness, agent gone), so its message is shown as is.
    // Two known codes get a shorter text because Herdr's format message is
    // about 130 characters and would wrap past the bottom of the small popup.
    if (res.code === "invalid_agent_name") error = "Use a-z 0-9 - _, start with a letter, max 32";
    else if (res.code === "agent_not_found") error = "The agent in this pane is gone";
    else error = res.message || res.code;
    render();
  };

  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    // A lone ESC byte is the Escape key. Longer chunks that start with ESC are
    // arrow keys or other escape sequences; the input has no cursor movement,
    // so they are ignored instead of being typed as garbage.
    if (chunk === ESC) return exit(0);
    if (chunk.startsWith(ESC)) return;
    for (const ch of chunk) {
      if (ch === "\r" || ch === "\n") return submit();
      if (ch === "\x03") return exit(0); // Ctrl+C cancels, like Escape.
      if (ch === "\x7f" || ch === "\b") value = value.slice(0, -1);
      else if (ch === "\x15") value = ""; // Ctrl+U clears the line.
      else if (ch >= " ") value += ch;
    }
    error = "";
    render();
  });
  render();
}

if (process.argv.includes("--action")) runAction();
else if (process.argv.includes("--popup")) runPopup();
else {
  process.stderr.write("usage: rename-agent.mjs --action | --popup\n");
  process.exit(2);
}
