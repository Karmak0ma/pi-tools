/**
 * Live smoke test for the exact Herdr argv sequences the Herdr backend sends.
 * Run from inside a Herdr pane only. Creates one pane, boots a bare pi TUI
 * (no prompt, no model call), verifies Herdr sees it, then closes the pane
 * and verifies the child is gone. Cleans up after itself.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sessionDir = mkdtempSync(join(tmpdir(), "pi-smoke-herdr-"));
let paneId;

function herdr(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.HERDR_BIN_PATH || "herdr", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(JSON.parse(stdout));
      else reject(new Error(`herdr ${args.join(" ")} exit ${code}: ${stderr || stdout}`));
    });
  });
}

try {
  // Mirrors HerdrCli.paneSplit: split current pane, right, no focus steal.
  const split = await herdr([
    "pane", "split", "--current", "--direction", "right", "--ratio", "0.5",
    "--cwd", "/tmp", "--no-focus", "--env", "PI_SMOKE=1",
  ]);
  paneId = split.result.pane.pane_id;
  console.log("split pane:", paneId, "focused:", split.result.pane.focused);

  // Mirrors HerdrCli.agentStart for the same argv the backend builds.
  const name = `smoke-${Date.now().toString(36).slice(-6)}`;
  await herdr(["agent", "start", name, "--kind", "pi", "--pane", paneId, "--timeout", "60000", "--",
    "--session-dir", sessionDir, "--name", "smoke", "--tools", "read"]);
  console.log("agent start: ready");

  const state = await herdr(["pane", "get", paneId]);
  console.log("pane state ok, agent_status:", state.result.pane.agent_status);
} finally {
  if (paneId) {
    await herdr(["pane", "close", paneId]);
    const after = await herdr(["pane", "get", paneId]).then(() => "STILL EXISTS", (e) => e.message);
    console.log("after close:", after);
    if (!/not_found/.test(after)) process.exitCode = 1;
  }
  rmSync(sessionDir, { recursive: true, force: true });
}