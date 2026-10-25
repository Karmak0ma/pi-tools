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
  // The split shares Pi's tab. Keep that tab's title; only our pane and Agents
  // entry are named review, so opening a review never renames the conversation.
  await run(["pane", "report-agent", paneId, "--source", "vflo.review", "--agent", "review", "--state", "idle"], { allowEmpty: true });
  let closing;
  return {
    // Exit can be requested by both a key and a signal. Release only once;
    // its child process keeps Node alive until the release request completes.
    close: () => closing ||= run(["pane", "release-agent", paneId, "--source", "vflo.review", "--agent", "review"], { allowEmpty: true }),
  };
}
