/**
 * Test-only helper: a fake RPC child pi process, shared by runner and backend
 * tests. Not loaded by pi — only tests import this file.
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

/**
 * Minimal RPC child: acknowledges the prompt, replays the given events, then
 * exits cleanly. `kill()` simulates a signalled death.
 */
export class FakeRpcChild extends EventEmitter {
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
    /** Behavior knobs: crash on close, emit stderr, or keep running. */
    private readonly behavior: { closeCode?: number; stderr?: string; stayOpen?: boolean } = {},
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
          if (this.behavior.stderr) this.stderr.write(this.behavior.stderr);
          if (this.behavior.stayOpen) continue;
          queueMicrotask(() => {
            this.exitCode = this.behavior.closeCode ?? 0;
            this.emit("close", this.exitCode);
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