/**
 * Live smoke test for the exact Herdr argv sequences the Herdr backend sends.
 * Run from inside a Herdr pane only. Creates one pane, boots a pi TUI with the
 * managed lifecycle hook, waits until the hook owns an idle state (the
 * backend's readiness gate), submits a real prompt in
 * fire-and-forget mode, then closes the pane and verifies the child is gone.
 * Cleans up after itself.
 *
 * This issues one real model call, so it is not network/cost-free. The pane
 * is closed shortly after prompt submission, typically mid-turn (the child's
 * own response is still in flight) — this script checks the readiness gate,
 * prompt argv, and cleanup, not turn completion.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sessionDir = mkdtempSync(join(tmpdir(), "pi-smoke-herdr-"));
let paneId;

/** Raw invocation that never throws, for inspecting the failure shape itself. */
function herdrRaw(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.HERDR_BIN_PATH || "herdr", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function herdr(args) {
  const { code, stdout, stderr } = await herdrRaw(args);
  if (code === 0) return JSON.parse(stdout);
  throw new Error(`herdr ${args.join(" ")} exit ${code}: ${stderr || stdout}`);
}

/** Return the first error code found in one CLI output stream. */
function errorCodeFromStream(text) {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed?.error?.code) return parsed.error.code;
    } catch { /* not the envelope line */ }
  }
  return undefined;
}

/**
 * Guard the transport contract parseCliResult() depends on.
 *
 * Which stream carries the {error:{code}} envelope is a herdr implementation
 * detail that already changed once (0.8.2 documented stdout, 0.9.0 uses
 * stderr). Parsing the wrong stream silently strips `herdrCode`, which
 * disables pane-death handling and specific error classification while unit
 * tests stay green. This check asserts an envelope is findable on SOME stream
 * and prints which one, so a future version change is visible here instead of
 * in production.
 */
async function checkErrorEnvelopeShape() {
  const res = await herdrRaw(["pane", "get", "bogus:pane"]);
  const stream = Object.entries({ stdout: res.stdout, stderr: res.stderr })
    .map(([name, text]) => ({ name, code: errorCodeFromStream(text) }))
    .find((candidate) => candidate.code);
  console.log("error envelope:", stream ? `${stream.code} on ${stream.name}` : "NOT FOUND");
  if (stream?.code !== "pane_not_found") {
    throw new Error(`transport contract drift: expected pane_not_found envelope, got ${JSON.stringify(res)}`);
  }
}

try {
  await checkErrorEnvelopeShape();

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

  // Mirrors waitForLifecycleHookIdle in src/herdr-backend.ts. `agent start`
  // and `agent wait --until idle` both accept Herdr's fallback guess, which
  // says idle while Pi may still be loading; a prompt typed then is never
  // submitted. Only a hook-owned idle state proves Pi takes input. This
  // smoke run loads the user's normal extensions (no --no-extensions), so the
  // managed hook in ~/.pi/agent/extensions is loaded. If this loop times out,
  // Herdr has probably renamed `screen_detection_skipped`: the backend would
  // then fail every hooked spawn with a readiness timeout.
  const gateDeadline = Date.now() + 60_000;
  while (true) {
    const agent = (await herdr(["agent", "get", name])).result.agent;
    if (agent.screen_detection_skipped === true && agent.agent_status === "idle") break;
    if (Date.now() > gateDeadline) {
      throw new Error(`readiness contract drift: hook authority never seen: ${JSON.stringify(agent)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  console.log("agent idle under lifecycle-hook authority");

  // Mirrors submitInitialPrompt: submit without Herdr's fixed 5s prompt
  // confirmation race. The session JSONL and monitor deadline own the task
  // observation after this command is accepted.
  await herdr(["agent", "prompt", name, "run bash sleep 3, then reply with exactly: smoke ok"]);
  console.log("prompt accepted");

  // This is the live check the unit fakes cannot provide: the fire-and-forget
  // prompt must make the named child leave idle. If this times out, the smoke
  // script catches the exact failure the startup deadline is meant to report.
  const working = await herdr(["agent", "wait", name, "--until", "working", "--timeout", "10000"]);
  console.log("prompt started, agent_status:", working.result.agent.agent_status);
} finally {
  if (paneId) {
    try {
      await herdr(["pane", "close", paneId]);
      const after = await herdr(["pane", "get", paneId]).then(() => "STILL EXISTS", (e) => e.message);
      console.log("after close:", after);
      if (!/not_found/.test(after)) process.exitCode = 1;
    } catch (error) {
      // Cleanup must not mask the original smoke failure or skip temp-file
      // removal when the Herdr server disappears during pane close.
      console.error("cleanup failed:", error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
  rmSync(sessionDir, { recursive: true, force: true });
}
