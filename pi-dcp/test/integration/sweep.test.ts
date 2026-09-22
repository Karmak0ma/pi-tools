import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildSessionProjection } from "@earendil-works/pi-coding-agent";
import { sweepCommand } from "../../src/commands/sweep.ts";
import { defaults } from "../../src/config/defaults.ts";
import { createRuntime } from "../../src/runtime.ts";

it("uses Pi 0.87 host projection for sweep after a context edit", async () => {
  const originalToolCall = { type: "toolCall", id: "read-original", name: "read", arguments: { path: "src/example.ts" } };
  const editedToolCall = { type: "toolCall", id: "read-edited", name: "read", arguments: { path: "src/edited.ts" } };
  const entries = [
    { type: "message", id: "user-1", parentId: null, timestamp: new Date(1).toISOString(), message: { role: "user", content: "inspect the file", timestamp: 1 } },
    { type: "message", id: "assistant-1", parentId: "user-1", timestamp: new Date(2).toISOString(), message: { role: "assistant", content: [originalToolCall], api: "test", provider: "test", model: "model", stopReason: "toolUse", timestamp: 2 } },
    { type: "context_edit", id: "edit-1", parentId: "assistant-1", timestamp: new Date(3).toISOString(), targetId: "assistant-1", replacement: { content: [editedToolCall] } },
    { type: "message", id: "result-1", parentId: "edit-1", timestamp: new Date(4).toISOString(), message: { role: "toolResult", toolCallId: "read-edited", toolName: "read", content: [{ type: "text", text: "file contents" }], isError: false, timestamp: 4 } },
  ] as any[];
  const appended: unknown[] = [];
  const notices: string[] = [];
  let hostProjectionCalls = 0;
  const previousStatsDir = process.env.PI_CODING_AGENT_DIR;
  const statsDir = await mkdtemp(join(tmpdir(), "pi-dcp-sweep-pi087-test-"));
  process.env.PI_CODING_AGENT_DIR = statsDir;
  try {
    const pi = { appendEntry: (_type: string, data: unknown) => { appended.push(data); } } as any;
    const runtime = createRuntime(pi);
    runtime.sessionId = "session-1";
    runtime.config = structuredClone(defaults) as any;
    const ctx = {
      cwd: "/tmp",
      ui: { notify: (text: string) => { notices.push(text); } },
      sessionManager: {
        buildContextEntries: () => entries,
        buildSessionProjection: () => { hostProjectionCalls++; return buildSessionProjection(entries, "result-1"); },
      },
    } as any;

    await sweepCommand("", ctx, pi, runtime);

    expect(hostProjectionCalls).toBe(1);
    expect(appended).toHaveLength(1);
    expect((appended[0] as any).operation.decisions).toEqual([expect.objectContaining({ toolCallId: "read-edited", kind: "sweep-output" })]);
    expect(notices).toContain("pi-dcp swept 1 tool output(s).");
  } finally {
    if (previousStatsDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousStatsDir;
    await rm(statsDir, { recursive: true, force: true });
  }
});
