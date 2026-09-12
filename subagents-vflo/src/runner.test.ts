import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { NESTING_DEPTH_ENV, currentNestingDepth, runChild, nestingDepthRefusal } from "./runner.js";
import { MAX_NESTING_DEPTH } from "./types.js";

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  responses: any[] = [];

  constructor(
    private readonly promptEvents: any[] = [
      {
        type: "extension_ui_request",
        id: "ui-1",
        method: "select",
        title: "Danger",
        options: ["Allow once", "Deny"],
      },
      { type: "agent_settled" },
    ],
  ) {
    super();
    this.stdin.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n")) {
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.type === "prompt") {
          this.stdout.write(JSON.stringify({ type: "response", id: message.id, success: true }) + "\n");
          for (const event of this.promptEvents) {
            this.stdout.write(JSON.stringify(event) + "\n");
          }
          queueMicrotask(() => {
            this.exitCode = 0;
            this.emit("close", 0);
          });
        } else if (message.type === "extension_ui_response") {
          this.responses.push(message);
        }
      }
    });
  }

  kill(): boolean {
    this.exitCode = 143;
    this.emit("close", this.exitCode);
    return true;
  }
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
