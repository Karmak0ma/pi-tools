import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { runChild } from "./runner.js";

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  responses: any[] = [];

  constructor() {
    super();
    this.stdin.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n")) {
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.type === "prompt") {
          this.stdout.write(JSON.stringify({ type: "response", id: message.id, success: true }) + "\n");
          this.stdout.write(JSON.stringify({
            type: "extension_ui_request",
            id: "ui-1",
            method: "select",
            title: "Danger",
            options: ["Allow once", "Deny"],
          }) + "\n");
          this.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\n");
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

describe("runChild extension UI transport", () => {
  it("observes before callback, writes one child-bound response, and keeps it out of command acks", async () => {
    const child = new FakeChild();
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
      spawnProcess: (() => child) as any,
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
    expect(callbackOrder).toEqual([1]);
    expect(firstResponse).toBe(true);
    expect(secondResponse).toBe(false);
    expect(child.responses).toEqual([{ type: "extension_ui_response", id: "ui-1", value: "Deny" }]);
    expect(events.map((event) => event.type)).toContain("extension_ui_request");
  });
});
