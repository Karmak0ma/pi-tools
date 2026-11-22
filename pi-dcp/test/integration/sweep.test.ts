import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildSessionProjection } from "@earendil-works/pi-coding-agent";
import { sweepCommand } from "../../src/commands/sweep.ts";
import { defaults } from "../../src/config/defaults.ts";
import { createRuntime } from "../../src/runtime.ts";
import { emptyRequestLayout, emptyState, outgoingPrune, reduceEnvelope } from "../../src/state/reducer.ts";
import { createEnvelope } from "../../src/state/operations.ts";

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
        getBranch: () => entries,
        buildSessionProjection: () => { hostProjectionCalls++; return buildSessionProjection(entries, "result-1"); },
      },
    } as any;

    await sweepCommand("", ctx, pi, runtime);

    expect(hostProjectionCalls).toBe(1);
    expect(appended).toHaveLength(1);
    expect((appended[0] as any).operation.decisions).toEqual([expect.objectContaining({ toolCallId: "read-edited", kind: "sweep-output" })]);
    expect(notices).toContain("pi-dcp swept 1 tool output(s).");
    // A sweep is an explicit request, so its claim changes the next request at once.
    // A sweep output is immediate, so the request layout does not decide it.
    expect(outgoingPrune(runtime.reduced, "read-edited", emptyRequestLayout())?.output?.kind).toBe("sweep-output");
  } finally {
    if (previousStatsDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousStatsDir;
    await rm(statsDir, { recursive: true, force: true });
  }
});

it("sweep switches on an automatic claim that still waits, without counting it again", async () => {
  const entries = [
    { type: "message", id: "user-1", parentId: null, timestamp: new Date(1).toISOString(), message: { role: "user", content: "inspect the file", timestamp: 1 } },
    { type: "message", id: "assistant-1", parentId: "user-1", timestamp: new Date(2).toISOString(), message: { role: "assistant", content: [{ type: "toolCall", id: "read-now", name: "read", arguments: { path: "src/now.ts" } }], api: "test", provider: "test", model: "model", stopReason: "toolUse", timestamp: 2 } },
    { type: "message", id: "result-1", parentId: "assistant-1", timestamp: new Date(3).toISOString(), message: { role: "toolResult", toolCallId: "read-now", toolName: "read", content: [{ type: "text", text: "file contents" }], isError: false, timestamp: 3 } },
  ] as any[];
  const appended: any[] = [];
  const statsDir = await mkdtemp(join(tmpdir(), "pi-dcp-sweep-waiting-test-"));
  const previousStatsDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = statsDir;
  try {
    const pi = { appendEntry: (_type: string, data: unknown) => { appended.push(data); } } as any;
    const runtime = createRuntime(pi);
    runtime.sessionId = "session-1";
    runtime.config = structuredClone(defaults) as any;
    // An automatic decision recorded earlier. No compression has followed it, so it waits.
    runtime.reduced = reduceEnvelope(emptyState(), createEnvelope({ type: "tools.pruned", decisions: [{ toolCallId: "read-now", kind: "dedup-output", estimatedTokens: 50 }] }, "session-1", "0.2.0"));
    const ctx = {
      cwd: "/tmp",
      ui: { notify: () => {} },
      sessionManager: { buildContextEntries: () => entries, getBranch: () => entries, buildSessionProjection: () => buildSessionProjection(entries as any, "result-1") },
    } as any;

    await sweepCommand("", ctx, pi, runtime);

    // The sweep carries no tokens: the dedup decision already counted them.
    expect(appended[0].operation.decisions).toEqual([{ toolCallId: "read-now", kind: "sweep-output", estimatedTokens: 0 }]);
    expect(outgoingPrune(runtime.reduced, "read-now", emptyRequestLayout())?.output).toBeDefined();
    expect(runtime.reduced.savings.deduplication.tokens).toBe(50);
    expect(runtime.reduced.savings.sweep).toEqual({ events: 0, tokens: 0 });
  } finally {
    if (previousStatsDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousStatsDir;
    await rm(statsDir, { recursive: true, force: true });
  }
});
