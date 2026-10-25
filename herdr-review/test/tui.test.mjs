import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const hasPty = process.platform === "linux" && spawnSync("script", ["--version"]).status === 0;

test("standalone startup publishes a terminal title that sidebar plugins can keep rendering", { skip: !hasPty, timeout: 15_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-title-pty-"));
  const root = path.join(dir, "repo"), session = path.join(dir, "session");
  await mkdir(root); await mkdir(session);
  execFileSync("git", ["init", "--quiet", root]);
  await writeFile(path.join(root, "sample.txt"), "source\n");
  await writeFile(path.join(session, "connection.json"), JSON.stringify({ root }));
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  const app = fileURLToPath(new URL("../src/tui.mjs", import.meta.url));
  // A real PTY reaches main(), not just a mock lifecycle call. Radar derives
  // its state-title tokens from terminal output, not report-agent or --title.
  // Disable live Herdr registration so this test cannot relabel a real pane.
  const child = spawn("script", ["-q", "-e", "-c", `${quote(process.execPath)} ${quote(app)}`, "/dev/null"], {
    cwd: root,
    env: { ...process.env, HERDR_ENV: "", HERDR_PLUGIN_ID: "", VFLO_REVIEW_DIR: session },
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await rm(dir, { recursive: true, force: true });
  });
  let output = "", quitting = false;
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (data) => {
    output += data;
    if (!quitting && output.includes("sample.txt")) {
      quitting = true;
      child.stdin.write("\x03");
    }
  });
  child.stderr.on("data", (data) => { output += data; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, 0, output);
  assert.ok(output.includes("\x1b]2;review\x07"), "publish a nonempty terminal title, not a transient custom token");
  assert.ok(output.includes("\x1b[?1049l"), "closing still restores the terminal");
});
