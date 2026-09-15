/**
 * Live smoke test for the exact Herdr argv sequences the Herdr backend sends.
 * Run from inside a Herdr pane only. Creates one pane, boots a bare pi TUI,
 * confirms a real prompt submission (the same `--wait` confirm mode used for
 * the child's first task prompt in submitInitialPrompt()), exercises the
 * corrective `agent send-keys enter` nudge so its argv shape is proven
 * against the real binary, then closes the pane and verifies the child is
 * gone. Cleans up after itself.
 *
 * This issues one real model call, so it is not network/cost-free. The pane
 * is closed right after send-keys, typically mid-turn (the child's own
 * response is still in flight) — this script checks argv acceptance and
 * cleanup, not turn completion.
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

  // Mirrors HerdrCli.agentPrompt's confirm mode (submitInitialPrompt's
  // submission): submit and wait for the pane to leave idle. On a healthy
  // run this should NOT stall.
  const prompted = await herdr([
    "agent", "prompt", name, "reply with exactly: smoke ok",
    "--wait", "--until", "working", "--until", "blocked", "--timeout", "8000",
  ]);
  console.log("prompt confirmed, agent_status:", prompted.result.agent.agent_status);

  // Mirrors HerdrCli.agentSendKeys (submitInitialPrompt's corrective nudge
  // on a stall). Not expected to change anything here since the prompt
  // above already confirmed; this just proves the argv shape is accepted.
  await herdr(["agent", "send-keys", name, "enter"]);
  console.log("send-keys ok");
} finally {
  if (paneId) {
    await herdr(["pane", "close", paneId]);
    const after = await herdr(["pane", "get", paneId]).then(() => "STILL EXISTS", (e) => e.message);
    console.log("after close:", after);
    if (!/not_found/.test(after)) process.exitCode = 1;
  }
  rmSync(sessionDir, { recursive: true, force: true });
}
