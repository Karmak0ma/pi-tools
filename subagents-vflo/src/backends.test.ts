import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { FakeRpcChild } from "./fake-rpc-child.js";
import { createBackend, createDefaultBackend } from "./backends.js";
import { NESTING_DEPTH_ENV } from "./runner.js";
import { HERDR_ENV_VAR, HERDR_PANE_ID_VAR, type HerdrClient } from "./herdr.js";
import { MAX_NESTING_DEPTH } from "./types.js";

describe("DefaultBackend", () => {
  it("wraps the RPC runner: handle exposes process/control and the result", async () => {
    const child = new FakeRpcChild();
    const backend = createDefaultBackend();
    const handle = await backend.spawn({
      resolvedTools: ["bash"],
      resolvedCwd: "/tmp",
      agentName: "worker",
      agentPrompt: "",
      taskText: "task",
      spawnProcess: (() => child) as any,
    });

    expect(handle.process).toBe(child);
    expect(handle.control).toBeDefined();
    expect(handle.control!.sendMessage).toBeDefined();
    expect(handle.control!.abort).toBeDefined();

    const result = await handle.result;
    expect(result.exitCode).toBe(0);
  });

  // A resume must contain the real Pi context, not merely pass a path flag.
  // Private forks also keep a still-open original child from sharing writes.
  it("forks completed RPC history and refuses a missing history without spawning", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-continuation-"));
    try {
      const original = SessionManager.create(dir, dir);
      original.appendMessage({ role: "user", content: "remember blue lantern", timestamp: 1 });
      const stop = fs.readFileSync(new URL("./fixtures/real-pi-session.jsonl", import.meta.url), "utf8")
        .split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((entry) => entry.message?.stopReason === "stop");
      original.appendMessage(stop.message);
      const source = original.getSessionFile()!;
      const before = fs.readFileSync(source, "utf8");
      let forkFile = "";
      const spawnProcess = vi.fn((_command: string, args: string[]) => {
        forkFile = args[args.indexOf("--session") + 1];
        expect(forkFile).not.toBe(source);
        const fork = SessionManager.open(forkFile);
        expect(fork.getSessionId()).not.toBe(original.getSessionId());
        expect(fork.buildSessionContext().messages).toEqual(original.buildSessionContext().messages);
        return new FakeRpcChild();
      });
      const spec = {
        resolvedTools: ["read"], resolvedCwd: dir, agentName: "worker", agentPrompt: "",
        taskText: "what did I ask you to remember?", parentSessionDir: dir,
        continueFrom: source, spawnProcess: spawnProcess as any,
      };
      const handle = await createDefaultBackend().spawn(spec);
      expect((await handle.result).sessionFile).toBe(forkFile);
      expect(fs.readFileSync(source, "utf8")).toBe(before);
      const missing = await createDefaultBackend().spawn({ ...spec, continueFrom: path.join(dir, "missing") });
      await expect(missing.result).rejects.toThrow();
      expect(spawnProcess).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maps a crashing RPC child to a failed result, never a completion", async () => {
    // The child emits one mid-turn message, then crashes with a non-zero
    // exit: the exit-code → failure mapping must survive the backend move.
    const child = new FakeRpcChild(
      [{ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [] } }],
      { closeCode: 1, stderr: "segmentation fault\n" },
    );
    const handle = await createDefaultBackend().spawn({
      resolvedTools: ["bash"],
      resolvedCwd: "/tmp",
      agentName: "worker",
      agentPrompt: "",
      taskText: "task",
      spawnProcess: (() => child) as any,
    });

    const result = await handle.result;
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("Child exited with code 1");
    expect(result.errorMessage).toContain("segmentation fault");
  });

  it("resolves aborted when the tool signal aborts a still-running RPC child", async () => {
    const child = new FakeRpcChild(
      [{ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [] } }],
      { stayOpen: true },
    );
    const controller = new AbortController();
    const handle = await createDefaultBackend().spawn({
      resolvedTools: ["bash"],
      resolvedCwd: "/tmp",
      agentName: "worker",
      agentPrompt: "",
      taskText: "task",
      spawnProcess: (() => child) as any,
      signal: controller.signal,
    });

    expect(handle.process).toBe(child);
    controller.abort(); // child is mid-turn and stays open

    const result = await handle.result;
    expect(result.stopReason).toBe("aborted");
    expect(child.exitCode).toBe(143);
  });

  it("returns a refused handle at the nesting limit without spawning", async () => {
    vi.stubEnv(NESTING_DEPTH_ENV, String(MAX_NESTING_DEPTH));
    try {
      const backend = createDefaultBackend();
      const handle = await backend.spawn({
        resolvedTools: ["bash"],
        resolvedCwd: "/tmp",
        agentName: "worker",
        agentPrompt: "",
        taskText: "task",
        spawnProcess: () => {
          throw new Error("must not spawn a child at the depth limit");
        },
      });

      expect(handle.control).toBeUndefined();
      const result = await handle.result;
      expect(result.exitCode).toBe(1);
      expect(result.errorMessage).toContain("nesting depth limit");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("createBackend selection", () => {
  it("uses the RPC runner outside Herdr — the existing non-Herdr path unchanged", async () => {
    vi.stubEnv(HERDR_ENV_VAR, "");
    vi.stubEnv(HERDR_PANE_ID_VAR, "");
    try {
      const child = new FakeRpcChild();
      const backend = createBackend();
      const handle = await backend.spawn({
        resolvedTools: ["bash"],
        resolvedCwd: "/tmp",
        agentName: "worker",
        agentPrompt: "",
        taskText: "task",
        spawnProcess: (() => child) as any,
      });
      // The fallback is exactly the old runner: the fake RPC child is the
      // spawned process and the result comes from the RPC flow.
      expect(handle.process).toBe(child);
      expect((await handle.result).exitCode).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("uses the Herdr backend inside a Herdr workspace", async () => {
    vi.stubEnv(HERDR_ENV_VAR, "1");
    vi.stubEnv(HERDR_PANE_ID_VAR, "wJ:pH");
    const fake: HerdrClient = {
      paneSplit: async () => ({ paneId: "wJ:p1" }),
      paneZoom: async () => {},
      agentStart: async () => {},
      agentWait: async () => {},
      agentGet: async () => ({ agentStatus: "idle", lifecycleHookAuthority: true }),
      agentPrompt: async () => {},
      paneGet: async () => ({ state: "exists" as const, agentStatus: "working" }),
      paneClose: async () => {},
      paneLayout: async () => [{ paneId: "wJ:pH", width: 216 }],
    };
    const backend = createBackend({ herdrCli: fake });
    const handle = await backend.spawn({
      resolvedTools: ["read"],
      resolvedCwd: "/repo",
      agentName: "explore",
      agentPrompt: "",
      taskText: "task",
    });

    // The Herdr path spawned a pane instead of an RPC child process.
    expect(handle.process).toBeUndefined();
    expect(handle.control).toBeDefined();
    handle.control!.abort();
    expect((await handle.result).stopReason).toBe("aborted");
  });
});