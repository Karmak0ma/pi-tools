import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

export async function runHerdr(args, { allowEmpty = false } = {}) {
  const { stdout } = await execute(process.env.HERDR_BIN_PATH || "herdr", args, { timeout: 10_000, maxBuffer: 1024 * 1024 });
  // Lifecycle hook commands acknowledge success through exit status alone.
  // Queries must still return JSON: treating an empty query as success would
  // hide missing pane/workspace identity and could route a launch incorrectly.
  if (!stdout.trim()) {
    if (allowEmpty) return undefined;
    throw new Error(`Herdr returned no JSON for ${args.slice(0, 2).join(" ")}.`);
  }
  const response = JSON.parse(stdout);
  if (response.error || !response.result) throw new Error(response.error?.message || "Herdr returned no result.");
  return response.result;
}

/**
 * A plugin is not a detected coding agent. Explicit lifecycle reporting gives
 * this user-facing tool its own Agents entry without claiming to be Pi. Use a
 * stable source so release removes only our report, never another reporter's.
 */
export async function registerReviewPane({ run = runHerdr, env = process.env } = {}) {
  // Direct PTY tests and manually launched scripts must never register the
  // inherited calling Pi pane as review. Only Herdr's own plugin launch context
  // identifies a pane that belongs to this application.
  if (env.HERDR_ENV !== "1" || env.HERDR_PLUGIN_ID !== "vflo.review" || env.HERDR_PLUGIN_ENTRYPOINT_ID !== "review") return { close: async () => {} };
  const result = await run(["pane", "current", "--current"]);
  const paneId = result.pane?.pane_id;
  if (!paneId) throw new Error("Herdr did not identify the review pane.");
  // The launcher owns the comparison-specific tab name. This process only
  // reports its pane lifecycle; direct launches must not rename Pi's tab.
  await run(["pane", "report-agent", paneId, "--source", "vflo.review", "--agent", "review", "--state", "idle"], { allowEmpty: true });
  const metadata = ["pane", "report-metadata", paneId, "--source", "vflo.review", "--agent", "review", "--applies-to-source", "vflo.review"];
  let closing;
  // Exit can be requested by both a key and a signal. Clean up only once;
  // the child processes keep Node alive until these requests complete.
  const close = () => closing ||= (async () => {
    try {
      // Only clear our source-scoped presentation. State-title tokens belong
      // to the sidebar plugin; touching them would erase its next frame.
      await run([...metadata, "--clear-title", "--clear-display-agent"], { allowEmpty: true });
    } finally {
      await run(["pane", "release-agent", paneId, "--source", "vflo.review", "--agent", "review"], { allowEmpty: true });
    }
  })();
  try {
    // Lifecycle kind is not a display name. Standard sidebars use this
    // presentation; token-based plugins derive theirs from the terminal title
    // set by tui.mjs. Never write title_idle here: herdr-radar owns that key
    // and replaces it on its next frame, which caused the transient label.
    await run([...metadata, "--title", "review", "--display-agent", "review"], { allowEmpty: true });
  } catch (error) {
    // Startup can fail after lifecycle registration. Do not leave a ghost
    // Agents entry behind, even if metadata cleanup itself also fails.
    await close().catch(() => {});
    throw error;
  }
  return { close };
}
