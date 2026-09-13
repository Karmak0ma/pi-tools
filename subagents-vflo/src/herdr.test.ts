import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HERDR_ENV_VAR,
  HERDR_PANE_ID_VAR,
  HerdrCli,
  type HerdrCommandResult,
  isHerdrEnvironment,
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

afterEach(() => {
  vi.unstubAllEnvs();
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