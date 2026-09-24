import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { NESTING_DEPTH_ENV, createSubagentSessionDir, currentNestingDepth, runChild, nestingDepthRefusal } from "./runner.js";
import { FakeRpcChild as FakeChild } from "./fake-rpc-child.js";
import { MAX_NESTING_DEPTH } from "./types.js";

function findInstalledPackageDir(packageName: string): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const packageDir = path.join(directory, "node_modules", packageName);
    if (fs.existsSync(path.join(packageDir, "package.json"))) return packageDir;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Cannot locate Pi host package ${packageName}; re-verify the /resume listing invariant manually`);
}

describe("runChild nesting depth guard", () => {
  it("counts subagent generations from the env marker", () => {
    expect(currentNestingDepth({})).toBe(0);
    expect(currentNestingDepth({ [NESTING_DEPTH_ENV]: "1" })).toBe(1);
    // Corrupted markers degrade to top-level, never to "block everything".
    expect(currentNestingDepth({ [NESTING_DEPTH_ENV]: "abc" })).toBe(0);
    expect(currentNestingDepth({ [NESTING_DEPTH_ENV]: "-3" })).toBe(0);
  });

  it("refuses at the limit and allows below it, as a pure policy check", () => {
    expect(nestingDepthRefusal("worker", {})).toBeNull();
    expect(nestingDepthRefusal("worker", { [NESTING_DEPTH_ENV]: "1" })).toBeNull();
    const refusal = nestingDepthRefusal("worker", { [NESTING_DEPTH_ENV]: String(MAX_NESTING_DEPTH) });
    expect(refusal?.exitCode).toBe(1);
    expect(refusal?.errorMessage).toContain("worker");
  });

  it("refuses to spawn when already at the depth limit", async () => {
    const refusalEvents: any[] = [];
    vi.stubEnv(NESTING_DEPTH_ENV, String(MAX_NESTING_DEPTH));
    try {
      const result = await runChild({
        resolvedTools: ["bash"],
        resolvedCwd: "/tmp",
        agentName: "worker",
        agentPrompt: "",
        taskText: "task",
        // The guard must fire before any process is created.
        spawnProcess: () => {
          throw new Error("must not spawn a child at the depth limit");
        },
        onEvent(event) {
          refusalEvents.push(event);
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.errorMessage).toContain("nesting depth limit");
      expect(refusalEvents).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("allows spawns below the depth limit", async () => {
    vi.stubEnv(NESTING_DEPTH_ENV, String(MAX_NESTING_DEPTH - 1));
    try {
      const child = new FakeChild();
      const childEvents: any[] = [];
      const result = await runChild({
        resolvedTools: ["bash"],
        resolvedCwd: "/tmp",
        agentName: "worker",
        agentPrompt: "",
        taskText: "task",
        spawnProcess: ((_command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
          expect(options.env?.[NESTING_DEPTH_ENV]).toBe(String(MAX_NESTING_DEPTH));
          return child;
        }) as any,
        onEvent(event) {
          childEvents.push(event);
        },
      });

      expect(result.exitCode).toBe(0);
      expect(childEvents.length).toBeGreaterThan(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("runChild session storage", () => {
  it("keeps nested child JSONL out of Pi's parent session listing", async () => {
    // Use the installed host implementation rather than duplicating its
    // directory scan here. This guards the /resume invariant that lets child
    // directories live below the parent's project session directory.
    const hostPackageDir = findInstalledPackageDir("@earendil-works/pi-coding-agent");
    const hostSessionManagerPath = path.join(hostPackageDir, "dist/core/session-manager.js");
    if (!fs.existsSync(hostSessionManagerPath)) {
      throw new Error("Pi host session-manager.js layout changed; re-verify the /resume listing invariant manually");
    }
    const { SessionManager } = await import(pathToFileURL(hostSessionManagerPath).href);
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-vflo-agent-dir-"));
    const parentSessionDir = path.join(agentDir, "sessions", "--tmp-subagents-vflo-session-list--");
    fs.mkdirSync(parentSessionDir, { recursive: true });
    const cwd = "/tmp/subagents-vflo-session-list";
    const parentSessionFile = path.join(parentSessionDir, "20260101_120000_parent.jsonl");
    const childSessionDir = fs.mkdtempSync(path.join(parentSessionDir, "pi-subagent-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    try {
      const sessionHeader = (id: string) =>
        JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T12:00:00.000Z", cwd });
      const userMessage = (id: string, text: string) =>
        JSON.stringify({
          type: "message",
          id,
          parentId: null,
          timestamp: "2026-01-01T12:00:01.000Z",
          message: { role: "user", content: [{ type: "text", text }] },
        });
      fs.writeFileSync(parentSessionFile, `${sessionHeader("parent")}\n${userMessage("parent-message", "parent")}\n`);
      fs.writeFileSync(
        path.join(childSessionDir, "20260101_120001_child.jsonl"),
        `${sessionHeader("child")}\n${userMessage("child-message", "child")}\n`,
      );

      const sessions = await SessionManager.list(cwd, parentSessionDir);
      expect(sessions.map((session: { path: string }) => session.path)).toEqual([parentSessionFile]);

      // Interactive /resume uses listAll() for the default project session
      // directory. Verify that path too, not only the custom-directory branch.
      const allSessions = await SessionManager.listAll();
      expect(allSessions.map((session: { path: string }) => session.path)).toEqual([parentSessionFile]);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("falls back to /tmp when the parent session directory is unavailable", async () => {
    const blockingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-vflo-blocking-root-"));
    const blockingPath = path.join(blockingRoot, "not-a-directory");
    fs.writeFileSync(blockingPath, "");
    let childSessionDir = "";
    try {
      childSessionDir = await createSubagentSessionDir(blockingPath);
      expect(path.dirname(childSessionDir)).toBe(os.tmpdir());
    } finally {
      if (childSessionDir) fs.rmSync(childSessionDir, { recursive: true, force: true });
      fs.rmSync(blockingRoot, { recursive: true, force: true });
    }
  });

  it("creates an isolated child directory below the parent Pi session directory", async () => {
    const parentSessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-vflo-parent-session-"));
    let childSessionDir = "";
    try {
      const child = new FakeChild([]);
      const result = await runChild({
        resolvedTools: ["bash"],
        resolvedCwd: "/tmp",
        agentName: "worker",
        agentPrompt: "",
        taskText: "task",
        parentSessionDir,
        spawnProcess: ((_command: string, args: string[]) => {
          const sessionDirFlag = args.indexOf("--session-dir");
          childSessionDir = args[sessionDirFlag + 1];
          return child;
        }) as any,
      });

      expect(result.lifecycle).toBe("closed");
      expect(path.dirname(childSessionDir)).toBe(parentSessionDir);
      expect(path.basename(childSessionDir)).toMatch(/^pi-subagent-/);
      expect(fs.existsSync(childSessionDir)).toBe(true);
      expect(fs.readdirSync(parentSessionDir).filter((entry) => entry.endsWith(".jsonl"))).toEqual([]);
    } finally {
      fs.rmSync(parentSessionDir, { recursive: true, force: true });
    }
  });
});

describe("runChild extension UI transport", () => {
  it("observes before callback, writes one child-bound response, and keeps it out of command acks", async () => {
    const child = new FakeChild();
    let spawnedArgs: string[] = [];
    let spawnedEnv: NodeJS.ProcessEnv | undefined;
    const events: any[] = [];
    const callbackOrder: number[] = [];
    let firstResponse = false;
    let secondResponse: boolean | undefined;

    const result = await runChild({
      resolvedTools: ["bash"],
      resolvedCwd: "/tmp",
      resolvedModel: "openai-codex/gpt-6-luna",
      thinking: "max",
      agentName: "worker",
      agentPrompt: "",
      taskText: "task",
      spawnProcess: ((_command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
        spawnedArgs = args;
        spawnedEnv = options.env;
        return child;
      }) as any,
      onEvent(event) {
        events.push(event);
      },
      onExtensionUIRequest(request, channel) {
        callbackOrder.push(events.length);
        if (request.method !== "select") throw new Error("expected select request");
        firstResponse = channel.respond({ type: "extension_ui_response", id: request.id, value: request.options[1] });
        secondResponse = channel.respond({ type: "extension_ui_response", id: request.id, value: request.options[0] });
      },
    });

    expect(result.exitCode).toBe(0);
    expect(spawnedArgs).not.toContain("--no-session");
    expect(spawnedArgs.slice(spawnedArgs.indexOf("--model"), spawnedArgs.indexOf("--model") + 2)).toEqual([
      "--model",
      "openai-codex/gpt-6-luna",
    ]);
    expect(spawnedArgs.slice(spawnedArgs.indexOf("--thinking"), spawnedArgs.indexOf("--thinking") + 2)).toEqual([
      "--thinking",
      "max",
    ]);
    expect(spawnedEnv?.PI_SESSION_FILE).toBeUndefined();
    // A top-level parent (no marker) spawns a first-generation child.
    expect(spawnedEnv?.[NESTING_DEPTH_ENV]).toBe("1");
    const sessionDirFlag = spawnedArgs.indexOf("--session-dir");
    expect(sessionDirFlag).toBeGreaterThanOrEqual(0);
    const sessionDir = spawnedArgs[sessionDirFlag + 1];
    expect(sessionDir.startsWith(path.join(os.tmpdir(), "pi-subagent-"))).toBe(true);
    fs.rmSync(sessionDir, { recursive: true, force: true });
    expect(callbackOrder).toEqual([1]);
    expect(firstResponse).toBe(true);
    expect(secondResponse).toBe(false);
    expect(child.responses).toEqual([{ type: "extension_ui_response", id: "ui-1", value: "Deny" }]);
    expect(events.map((event) => event.type)).toContain("extension_ui_request");
  });

  it("clears a transient WebSocket error after Pi retries and settles successfully", async () => {
    const child = new FakeChild([
      {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "WebSocket error",
          content: [],
        },
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "toolUse",
          content: [{ type: "toolCall", name: "bash", arguments: { command: "true" } }],
        },
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Recovered successfully" }],
        },
      },
      { type: "agent_settled" },
    ]);
    let sessionDir = "";

    const result = await runChild({
      resolvedTools: ["bash"],
      resolvedCwd: "/tmp",
      agentName: "worker",
      agentPrompt: "",
      taskText: "task",
      spawnProcess: ((_command: string, args: string[], _options: { env?: NodeJS.ProcessEnv }) => {
        const sessionDirFlag = args.indexOf("--session-dir");
        sessionDir = args[sessionDirFlag + 1];
        return child;
      }) as any,
    });

    fs.rmSync(sessionDir, { recursive: true, force: true });
    expect(result.exitCode).toBe(0);
    expect(result.stopReason).toBe("stop");
    expect(result.errorMessage).toBeUndefined();
    expect(result.finalOutput).toContain("Recovered successfully");
    expect(result.toolCalls).toEqual([{ name: "bash", argsPreview: '{"command":"true"}' }]);
  });

  it("uses only the final normal stop text after an aborted assistant turn", async () => {
    const child = new FakeChild([
      {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "aborted",
          content: [{ type: "text", text: "discarded partial answer" }],
        },
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "final answer after guidance" }],
        },
      },
      { type: "agent_settled" },
    ], { closeCode: 1, stderr: "late transport close" });
    let sessionDir = "";

    const result = await runChild({
      resolvedTools: ["bash"],
      resolvedCwd: "/tmp",
      agentName: "worker",
      agentPrompt: "",
      taskText: "task",
      spawnProcess: ((_command: string, args: string[], _options: { env?: NodeJS.ProcessEnv }) => {
        const sessionDirFlag = args.indexOf("--session-dir");
        sessionDir = args[sessionDirFlag + 1];
        return child;
      }) as any,
    });

    fs.rmSync(sessionDir, { recursive: true, force: true });
    expect(result.lifecycle).toBe("completed");
    expect(result.finalOutput).toBe("final answer after guidance");
    expect(result.finalOutput).not.toContain("discarded partial");
  });

  it("reports an unrecovered aborted turn as closed with a useful reason", async () => {
    const child = new FakeChild([
      {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "aborted",
          content: [{ type: "text", text: "partial work" }],
        },
      },
      { type: "agent_settled" },
    ]);
    let sessionDir = "";

    const result = await runChild({
      resolvedTools: ["bash"],
      resolvedCwd: "/tmp",
      agentName: "worker",
      agentPrompt: "",
      taskText: "task",
      spawnProcess: ((_command: string, args: string[], _options: { env?: NodeJS.ProcessEnv }) => {
        const sessionDirFlag = args.indexOf("--session-dir");
        sessionDir = args[sessionDirFlag + 1];
        return child;
      }) as any,
    });

    fs.rmSync(sessionDir, { recursive: true, force: true });
    expect(result.lifecycle).toBe("closed");
    expect(result.errorMessage).toContain("interrupted");
    expect(result.finalOutput).toBe("");
  });

  it("reports an unexpected child process exit as a terminal failure", async () => {
    const child = new FakeChild([{ type: "agent_settled" }], { closeCode: 1, stderr: "child crashed" });
    let sessionDir = "";

    const result = await runChild({
      resolvedTools: ["bash"],
      resolvedCwd: "/tmp",
      agentName: "worker",
      agentPrompt: "",
      taskText: "task",
      spawnProcess: ((_command: string, args: string[], _options: { env?: NodeJS.ProcessEnv }) => {
        const sessionDirFlag = args.indexOf("--session-dir");
        sessionDir = args[sessionDirFlag + 1];
        return child;
      }) as any,
    });

    fs.rmSync(sessionDir, { recursive: true, force: true });
    expect(result.lifecycle).toBe("failed");
    expect(result.errorMessage).toContain("child crashed");
  });

  it("keeps an unrecovered terminal assistant error", async () => {
    const child = new FakeChild([
      {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "Provider failed",
          content: [],
        },
      },
      { type: "agent_settled" },
    ]);
    let sessionDir = "";

    const result = await runChild({
      resolvedTools: ["bash"],
      resolvedCwd: "/tmp",
      agentName: "worker",
      agentPrompt: "",
      taskText: "task",
      spawnProcess: ((_command: string, args: string[], _options: { env?: NodeJS.ProcessEnv }) => {
        const sessionDirFlag = args.indexOf("--session-dir");
        sessionDir = args[sessionDirFlag + 1];
        return child;
      }) as any,
    });

    fs.rmSync(sessionDir, { recursive: true, force: true });
    expect(result.exitCode).toBe(0);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("Provider failed");
  });
});
