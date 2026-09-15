import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HERDR_ENV_VAR,
  HERDR_PANE_ID_VAR,
  HerdrCli,
  PI_CODING_AGENT_DIR_VAR,
  resolveHerdrAgentStateExtension,
  type HerdrCommandResult,
  isHerdrEnvironment,
  isHerdrPromptStalled,
  selectBackendKind,
} from "./herdr.js";

// ─── Detection ───────────────────────────────────────────────────────────────

describe("Herdr environment detection", () => {
  it("detects Herdr only when HERDR_ENV is exactly 1", () => {
    expect(isHerdrEnvironment({ [HERDR_ENV_VAR]: "1" })).toBe(true);
    expect(isHerdrEnvironment({ [HERDR_ENV_VAR]: "0" })).toBe(false);
    expect(isHerdrEnvironment({ [HERDR_ENV_VAR]: "" })).toBe(false);
    expect(isHerdrEnvironment({ [HERDR_ENV_VAR]: "true" })).toBe(false);
    expect(isHerdrEnvironment({})).toBe(false);
  });

  it("requires both the workspace marker and an anchor pane id for the herdr backend", () => {
    expect(selectBackendKind({ [HERDR_ENV_VAR]: "1", [HERDR_PANE_ID_VAR]: "w:p1" })).toBe("herdr");
    // No pane id to anchor a split: fall back instead of failing at spawn.
    expect(selectBackendKind({ [HERDR_ENV_VAR]: "1" })).toBe("default");
    expect(selectBackendKind({ [HERDR_PANE_ID_VAR]: "w:p1" })).toBe("default");
    expect(selectBackendKind({})).toBe("default");
  });
});

// ─── CLI client ──────────────────────────────────────────────────────────────

type RecordedCall = { args: string[]; timeoutMs: number };

function makeRunner(
  responder: (args: string[]) => HerdrCommandResult | Promise<HerdrCommandResult>,
): { runner: any; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const runner = async (args: string[], timeoutMs: number): Promise<HerdrCommandResult> => {
    calls.push({ args, timeoutMs });
    const res = await responder(args);
    return res;
  };
  return { runner, calls };
}

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Herdr lifecycle integration resolution", () => {
  it("resolves the managed extension from Pi's default directory", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-vflo-home-"));
    tempDirs.push(homeDir);
    const extensionPath = path.join(homeDir, ".pi", "agent", "extensions", "herdr-agent-state.ts");
    fs.mkdirSync(path.dirname(extensionPath), { recursive: true });
    fs.writeFileSync(extensionPath, "// test integration");
    // Node's os.homedir() follows HOME on POSIX and USERPROFILE on Windows.
    // Stubbing both keeps the production default branch under test without
    // changing the resolver's public API or relying on the real home directory.
    vi.stubEnv("HOME", homeDir);
    vi.stubEnv("USERPROFILE", homeDir);
    const expected = fs.realpathSync.native(extensionPath);
    expect(resolveHerdrAgentStateExtension({})).toBe(expected);
    // An empty override has the same meaning as an unset override in Pi's
    // environment contract and must not produce a relative `extensions/...`
    // lookup from the test process's current working directory.
    expect(resolveHerdrAgentStateExtension({ [PI_CODING_AGENT_DIR_VAR]: "" })).toBe(expected);
    // Pi also expands a leading tilde in an explicit override.
    expect(resolveHerdrAgentStateExtension({ [PI_CODING_AGENT_DIR_VAR]: "~/.pi/agent" })).toBe(expected);

    const bareTildeExtension = path.join(homeDir, "extensions", "herdr-agent-state.ts");
    fs.mkdirSync(path.dirname(bareTildeExtension), { recursive: true });
    fs.writeFileSync(bareTildeExtension, "// test integration");
    expect(resolveHerdrAgentStateExtension({ [PI_CODING_AGENT_DIR_VAR]: "~" }))
      .toBe(fs.realpathSync.native(bareTildeExtension));
  });

  it("resolves the managed extension from PI_CODING_AGENT_DIR", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-vflo-herdr-"));
    tempDirs.push(agentDir);
    const extensionPath = path.join(agentDir, "extensions", "herdr-agent-state.ts");
    fs.mkdirSync(path.dirname(extensionPath), { recursive: true });
    fs.writeFileSync(extensionPath, "// test integration");

    expect(resolveHerdrAgentStateExtension({ [PI_CODING_AGENT_DIR_VAR]: agentDir }))
      .toBe(fs.realpathSync.native(extensionPath));
  });

  it("resolves a relative override against the child working directory", () => {
    const childCwd = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-vflo-child-cwd-"));
    tempDirs.push(childCwd);
    const extensionPath = path.join(childCwd, "relative-agent", "extensions", "herdr-agent-state.ts");
    fs.mkdirSync(path.dirname(extensionPath), { recursive: true });
    fs.writeFileSync(extensionPath, "// test integration");

    expect(resolveHerdrAgentStateExtension(
      { [PI_CODING_AGENT_DIR_VAR]: "relative-agent" },
      childCwd,
    )).toBe(fs.realpathSync.native(extensionPath));
  });

  it("returns null instead of injecting a missing integration path", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-vflo-herdr-"));
    tempDirs.push(agentDir);

    expect(resolveHerdrAgentStateExtension({ [PI_CODING_AGENT_DIR_VAR]: agentDir })).toBeNull();
  });

  it("returns null when the managed extension path is a directory", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-vflo-herdr-"));
    tempDirs.push(agentDir);
    const extensionPath = path.join(agentDir, "extensions", "herdr-agent-state.ts");
    fs.mkdirSync(extensionPath, { recursive: true });

    expect(resolveHerdrAgentStateExtension({ [PI_CODING_AGENT_DIR_VAR]: agentDir })).toBeNull();
  });

  it("returns null for a broken managed-extension symlink", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-vflo-herdr-"));
    tempDirs.push(agentDir);
    const extensionPath = path.join(agentDir, "extensions", "herdr-agent-state.ts");
    fs.mkdirSync(path.dirname(extensionPath), { recursive: true });
    fs.symlinkSync(path.join(agentDir, "missing-herdr-agent-state.ts"), extensionPath);

    expect(resolveHerdrAgentStateExtension({ [PI_CODING_AGENT_DIR_VAR]: agentDir })).toBeNull();
  });
});

describe("HerdrCli", () => {
  it("splits the current pane without stealing focus and injects env vars", async () => {
    const { runner, calls } = makeRunner(() => ({
      exitCode: 0,
      stdout: JSON.stringify({ result: { pane: { pane_id: "wJ:pX" } } }),
      stderr: "",
    }));
    const cli = new HerdrCli(runner);

    const pane = await cli.paneSplit({
      direction: "right",
      cwd: "/repo",
      env: { PI_SUBAGENTS_VFLO_DEPTH: "1" },
    });

    expect(pane.paneId).toBe("wJ:pX");
    expect(calls[0].args).toEqual([
      "pane", "split", "--current", "--direction", "right", "--ratio", "0.5",
      "--cwd", "/repo", "--no-focus", "--env", "PI_SUBAGENTS_VFLO_DEPTH=1",
    ]);
  });

  it("rejects a split whose response lacks a pane id", async () => {
    const { runner } = makeRunner(() => ({
      exitCode: 0,
      stdout: JSON.stringify({ result: {} }),
      stderr: "",
    }));
    const cli = new HerdrCli(runner);
    await expect(cli.paneSplit({ direction: "down", cwd: "/repo", env: {} })).rejects.toThrow("no pane id");
  });

  it("starts a pi agent with kind, pane, timeout, and passthrough args", async () => {
    const { runner, calls } = makeRunner(() => ({
      exitCode: 0,
      stdout: JSON.stringify({ result: { agent: { name: "sa-x" } } }),
      stderr: "",
    }));
    const cli = new HerdrCli(runner);

    await cli.agentStart("sa-x", "wJ:pX", ["--session-dir", "/tmp/s"], 60_000);

    expect(calls[0].args.slice(0, 8)).toEqual([
      "agent", "start", "sa-x", "--kind", "pi", "--pane", "wJ:pX", "--timeout",
    ]);
    expect(calls[0].args).toContain("60000");
    expect(calls[0].args.slice(-3)).toEqual(["--", "--session-dir", "/tmp/s"]);
    // Runner timeout leaves slack over the CLI's own readiness timeout.
    expect(calls[0].timeoutMs).toBe(70_000);
  });

  it("submits prompts without --wait so completion is decided by the watcher", async () => {
    const { runner, calls } = makeRunner(() => ({
      exitCode: 0,
      stdout: JSON.stringify({ result: { type: "ok" } }),
      stderr: "",
    }));
    const cli = new HerdrCli(runner);

    await cli.agentPrompt("sa-x", "do the thing\nwith two lines");

    expect(calls[0].args).toEqual(["agent", "prompt", "sa-x", "do the thing\nwith two lines"]);
  });

  it("rejects a prompt when the agent is blocked", async () => {
    const runner = async (): Promise<HerdrCommandResult> => ({
      exitCode: 1,
      stdout: JSON.stringify({ error: { code: "agent_blocked", message: "at a dialog" } }),
      stderr: "",
    });
    const cli = new HerdrCli(runner as any);
    await expect(cli.agentPrompt("sa-x", "hello")).rejects.toThrow("agent_blocked");
  });

  it("adds --wait/--until/--timeout only when a confirmation window is requested", async () => {
    const { runner, calls } = makeRunner(() => ({
      exitCode: 0,
      stdout: JSON.stringify({ result: { type: "ok" } }),
      stderr: "",
    }));
    const cli = new HerdrCli(runner);

    await cli.agentPrompt("sa-x", "map the repo", { confirmWithinMs: 8_000 });

    expect(calls[0].args).toEqual([
      "agent", "prompt", "sa-x", "map the repo",
      "--wait", "--until", "working", "--until", "blocked", "--timeout", "8000",
    ]);
    // Runner timeout leaves slack over the CLI's own confirmation window.
    expect(calls[0].timeoutMs).toBe(18_000);
  });

  it("surfaces a stalled confirmed submission as agent_prompt_stalled", async () => {
    const runner = async (): Promise<HerdrCommandResult> => ({
      exitCode: 1,
      stdout: JSON.stringify({ error: { code: "agent_prompt_stalled", message: "no state change observed" } }),
      stderr: "",
    });
    const cli = new HerdrCli(runner as any);

    const failure = await cli.agentPrompt("sa-x", "map the repo", { confirmWithinMs: 8_000 }).catch((e) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(isHerdrPromptStalled(failure)).toBe(true);
    expect(isHerdrPromptStalled(new Error("unrelated"))).toBe(false);
  });

  it("sends raw terminal keys to an agent", async () => {
    const { runner, calls } = makeRunner(() => ({
      exitCode: 0,
      stdout: JSON.stringify({ result: { type: "ok" } }),
      stderr: "",
    }));
    const cli = new HerdrCli(runner);

    await cli.agentSendKeys("sa-x", ["enter"]);

    expect(calls[0].args).toEqual(["agent", "send-keys", "sa-x", "enter"]);
  });



  it("returns agent_status from pane get result", async () => {
    const runner = async (): Promise<HerdrCommandResult> => ({
      exitCode: 0,
      stdout: JSON.stringify({ result: { pane: { pane_id: "wJ:pX", agent_status: "working" } } }),
      stderr: "",
    });
    const cli = new HerdrCli(runner as any);
    await expect(cli.paneGet("wJ:pX")).resolves.toEqual({ state: "exists", agentStatus: "working" });
  });

  it("classifies pane_not_found as gone", async () => {
    const runner = async (): Promise<HerdrCommandResult> => ({
      exitCode: 1,
      stdout: JSON.stringify({ error: { code: "pane_not_found" } }),
      stderr: "",
    });
    const cli = new HerdrCli(runner as any);
    await expect(cli.paneGet("wJ:pX")).resolves.toEqual({ state: "gone" });
  });

  it("throws on unexpected pane get errors", async () => {
    const runner = async (): Promise<HerdrCommandResult> => ({
      exitCode: 1,
      stdout: JSON.stringify({ error: { code: "server_unavailable" } }),
      stderr: "",
    });
    const cli = new HerdrCli(runner as any);
    await expect(cli.paneGet("wJ:pX")).rejects.toThrow("server_unavailable");
  });

  it("tolerates closing an already-closed pane but surfaces other failures", async () => {
    let code = "pane_not_found";
    const runner = async (): Promise<HerdrCommandResult> => ({
      exitCode: 1,
      stdout: JSON.stringify({ error: { code } }),
      stderr: "",
    });
    const cli = new HerdrCli(runner as any);
    await expect(cli.paneClose("wJ:pX")).resolves.toBeUndefined();

    code = "server_unavailable";
    await expect(cli.paneClose("wJ:pX")).rejects.toThrow("server_unavailable");
  });

  it("reads pane rectangles from the layout", async () => {
    const runner = async (): Promise<HerdrCommandResult> => ({
      exitCode: 0,
      stdout: JSON.stringify({
        result: {
          layout: {
            panes: [
              { pane_id: "wJ:pH", rect: { width: 216, height: 58, x: 0, y: 0 } },
              { pane_id: "wJ:pX", rect: { width: 108, height: 58, x: 216 } },
            ],
            focused_pane_id: "wJ:pH",
          },
        },
      }),
      stderr: "",
    });
    const cli = new HerdrCli(runner as any);

    const panes = await cli.paneLayout("wJ:pH");
    expect(panes).toEqual([
      { paneId: "wJ:pH", width: 216, height: 58 },
      { paneId: "wJ:pX", width: 108, height: 58 },
    ]);
  });

  it("surfaces non-JSON usage errors with the CLI message", async () => {
    const runner = async (): Promise<HerdrCommandResult> => ({
      exitCode: 2,
      stdout: "",
      stderr: "error: unexpected argument '--bogus' found",
    });
    const cli = new HerdrCli(runner as any);
    await expect(cli.paneGet("wJ:pX")).rejects.toThrow(/unexpected argument/);
  });
});