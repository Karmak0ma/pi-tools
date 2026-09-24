import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHerdrBackend } from "./herdr-backend.js";
import { NESTING_DEPTH_ENV, currentNestingDepth } from "./runner.js";
import { MAX_NESTING_DEPTH } from "./types.js";
import { PI_CODING_AGENT_DIR_VAR } from "./herdr.js";
import type { HerdrClient } from "./herdr.js";
import type { SubagentSpec } from "./backends.js";

// ─── Fake Herdr client ───────────────────────────────────────────────────────

/**
 * In-memory Herdr. Records every CLI call so tests can assert the exact
 * command sequence (split → start → prompt) and simulate server-side events
 * (pane death) and CLI failures.
 */
class FakeHerdr implements HerdrClient {
  paneCounter = 0;
  /** Hook fired inside agentStart so tests can abort the tool mid-startup. */
  onAgentStart: (() => void) | undefined;
  agentStartDelayMs = 0;
  splits: Array<{ direction: string; cwd: string; env: Record<string, string> }> = [];
  started: Array<{ name: string; paneId: string; args: string[]; timeoutMs: number }> = [];
  prompts: Array<{ target: string; text: string }> = [];
  closedPanes: string[] = [];
  paneExists = new Map<string, boolean>();
  paneGetCalls = 0;
  paneGetDelayMs = 0;
  paneGetResults: Array<{ state: "exists" | "gone"; agentStatus?: string }> = [];
  defaultAgentStatus: "idle" | "working" | "blocked" = "working";
  layoutForPane = "";
  layoutWidth = 216;
  agentStartError: Error | undefined;
  agentWaitError: Error | undefined;
  agentPromptError: Error | undefined;
  waits: Array<{ target: string; status: string; timeoutMs: number }> = [];
  failPaneClose = false;

  async paneSplit(options: { direction: "right" | "down"; cwd: string; env: Record<string, string> }) {
    this.splits.push(options);
    const paneId = `wJ:p${++this.paneCounter}`;
    this.paneExists.set(paneId, true);
    return { paneId };
  }

  async agentStart(name: string, paneId: string, args: string[], timeoutMs: number) {
    if (this.agentStartError) throw this.agentStartError;
    this.onAgentStart?.();
    if (this.agentStartDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.agentStartDelayMs));
    this.started.push({ name, paneId, args, timeoutMs });
  }

  async agentWait(target: string, status: string, timeoutMs: number) {
    if (this.agentWaitError) throw this.agentWaitError;
    this.waits.push({ target, status, timeoutMs });
  }

  async agentPrompt(target: string, text: string) {
    if (this.agentPromptError) throw this.agentPromptError;
    this.prompts.push({ target, text });
  }

  async paneGet(paneId: string): Promise<{ state: "exists" | "gone"; agentStatus?: string }> {
    this.paneGetCalls++;
    const result = this.paneGetResults.shift() ?? (
      this.paneExists.get(paneId) !== false ? { state: "exists", agentStatus: this.defaultAgentStatus } : { state: "gone" }
    );
    if (this.paneGetDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.paneGetDelayMs));
    return result;
  }

  async paneClose(paneId: string) {
    if (this.failPaneClose) {
      // Simulate the real-world failure mode: the pane was already gone, the
      // CLI still reported an error.
      this.paneExists.set(paneId, false);
      throw new Error("herdr pane close failed: pane_not_found");
    }
    this.closedPanes.push(paneId);
    this.paneExists.set(paneId, false);
  }

  async paneLayout(paneId: string) {
    this.layoutForPane = paneId;
    return [{ paneId, width: this.layoutWidth, height: 58 }];
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

beforeEach(() => {
  // Keep every child-argv assertion independent of the developer's real Pi
  // installation. The production resolver intentionally checks the default
  // ~/.pi/agent path when this variable is absent, so a local managed hook
  // must not silently change unrelated test expectations.
  const isolatedAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-vflo-herdr-test-"));
  tempDirs.push(isolatedAgentDir);
  vi.stubEnv(PI_CODING_AGENT_DIR_VAR, isolatedAgentDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeSpec(overrides: Partial<SubagentSpec> = {}): SubagentSpec {
  return {
    resolvedModel: "test-provider/test-model",
    resolvedTools: ["read", "bash"],
    resolvedCwd: "/repo",
    agentName: "explore",
    agentPrompt: "You are a scout.",
    taskText: "map the repo",
    childExtensionPaths: ["/ext/a.ts"],
    ...overrides,
  };
}

function makeBackend(fake: FakeHerdr) {
  return createHerdrBackend({
    cli: fake,
    pollIntervalMs: 10,
    errorSettleGraceMs: 50,
    agentStartTimeoutMs: 500,
    startupActivityTimeoutMs: 500,
  });
}

function sessionDirOf(fake: FakeHerdr): string {
  const args = fake.started[0].args;
  return args[args.indexOf("--session-dir") + 1];
}

function appendAssistant(sessionDir: string, message: Record<string, unknown>): void {
  const filePath = path.join(sessionDir, "session.jsonl");
  const entry = JSON.stringify({ type: "message", message: { role: "assistant", ...message } });
  fs.appendFileSync(filePath, entry + "\n");
}

/** "settled" once the handle's result settles, "pending" after ms. */
function settleRace(handle: { result: Promise<unknown> }, ms = 150): Promise<string> {
  return Promise.race([
    handle.result.then(() => "settled"),
    new Promise<string>((resolve) => setTimeout(() => resolve("pending"), ms)),
  ]);
}

async function until(fn: () => boolean, ms = 500): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ─── Herdr child extensions ─────────────────────────────────────────────────

describe("Herdr child extension wiring", () => {
  it("explicitly loads the managed lifecycle integration alongside configured extensions", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-vflo-herdr-"));
    tempDirs.push(agentDir);
    const integrationPath = path.join(agentDir, "extensions", "herdr-agent-state.ts");
    fs.mkdirSync(path.dirname(integrationPath), { recursive: true });
    fs.writeFileSync(integrationPath, "// test integration");
    vi.stubEnv(PI_CODING_AGENT_DIR_VAR, agentDir);

    const fake = new FakeHerdr();
    const handle = await makeBackend(fake).spawn(makeSpec({ agentPrompt: "" }));
    const args = fake.started[0].args;
    const canonicalIntegrationPath = fs.realpathSync.native(integrationPath);

    // --no-extensions keeps unrelated parent extensions out of the isolated
    // child; the managed Herdr hook is the one deliberate exception.
    expect(args).toContain("--no-extensions");
    expect(args).toContain("-e");
    expect(args).toContain("/ext/a.ts");
    expect(args).toContain(canonicalIntegrationPath);
    expect(args.filter((arg) => arg === "-e")).toHaveLength(2);

    appendAssistant(sessionDirOf(fake), { content: [{ type: "text", text: "done" }], stopReason: "stop" });
    await handle.result;
  });

  it("does not add the integration when the configured Pi directory has no managed hook", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-vflo-herdr-"));
    tempDirs.push(agentDir);
    vi.stubEnv(PI_CODING_AGENT_DIR_VAR, agentDir);

    const fake = new FakeHerdr();
    const handle = await makeBackend(fake).spawn(makeSpec({ agentPrompt: "" }));
    const args = fake.started[0].args;

    expect(args).not.toContain("herdr-agent-state.ts");
    expect(args.filter((arg) => arg === "-e")).toHaveLength(1);

    appendAssistant(sessionDirOf(fake), { content: [{ type: "text", text: "done" }], stopReason: "stop" });
    await handle.result;
  });

  it("does not load the same integration twice when configuration uses a symlink", async () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-vflo-herdr-"));
    tempDirs.push(agentDir);
    const integrationPath = path.join(agentDir, "extensions", "herdr-agent-state.ts");
    const configuredLink = path.join(agentDir, "configured-herdr-state.ts");
    fs.mkdirSync(path.dirname(integrationPath), { recursive: true });
    fs.writeFileSync(integrationPath, "// test integration");
    fs.symlinkSync(integrationPath, configuredLink);
    vi.stubEnv(PI_CODING_AGENT_DIR_VAR, agentDir);

    const fake = new FakeHerdr();
    const handle = await makeBackend(fake).spawn(makeSpec({
      agentPrompt: "",
      childExtensionPaths: [configuredLink],
    }));
    const args = fake.started[0].args;
    const extensionValues = args
      .map((arg, index) => arg === "-e" ? args[index + 1] : undefined)
      .filter((value): value is string => value !== undefined);

    // The configured spelling remains in argv and is enough; canonical path
    // comparison prevents the backend from appending a second spelling.
    expect(extensionValues).toEqual([configuredLink]);

    appendAssistant(sessionDirOf(fake), { content: [{ type: "text", text: "done" }], stopReason: "stop" });
    await handle.result;
  });
});

// ─── Happy path ──────────────────────────────────────────────────────────────

describe("HerdrBackend happy path", () => {
  it("stores the child session below the parent Pi session directory", async () => {
    const parentSessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-vflo-parent-session-"));
    tempDirs.push(parentSessionDir);
    const fake = new FakeHerdr();
    const handle = await makeBackend(fake).spawn(makeSpec({ parentSessionDir, agentPrompt: "" }));
    const childSessionDir = sessionDirOf(fake);

    expect(path.dirname(childSessionDir)).toBe(parentSessionDir);
    expect(path.basename(childSessionDir)).toMatch(/^pi-subagent-/);

    appendAssistant(childSessionDir, { content: [{ type: "text", text: "done" }], stopReason: "stop" });
    await handle.result;
    expect(fs.readdirSync(parentSessionDir).filter((entry) => entry.endsWith(".jsonl"))).toEqual([]);
  });

  it("keeps descendant messages scoped to the child that invoked them", async () => {
    const fake = new FakeHerdr();
    const events: any[] = [];
    const handle = await makeBackend(fake).spawn(makeSpec({
      agentPrompt: "",
      onEvent: (event) => events.push(event),
    }));
    const directChildDir = sessionDirOf(fake);
    const grandchildDir = fs.mkdtempSync(path.join(directChildDir, "pi-subagent-"));

    // A descendant can finish while the direct child is still processing its
    // result. Its JSONL is persisted below the direct child's directory, but
    // it is a separate result channel and must not affect this monitor.
    appendAssistant(grandchildDir, {
      content: [{ type: "toolCall", name: "read", arguments: { path: "grandchild-only" } }],
      usage: { input: 100, output: 50, totalTokens: 150 },
      stopReason: "toolUse",
    });
    appendAssistant(grandchildDir, {
      content: [{ type: "text", text: "grandchild result" }],
      usage: { input: 200, output: 75, totalTokens: 275 },
      stopReason: "stop",
    });

    expect(await settleRace(handle, 80)).toBe("pending");
    expect(events.filter((event) => event.type === "message_end")).toEqual([]);

    appendAssistant(directChildDir, {
      content: [{ type: "text", text: "direct child result" }],
      usage: { input: 10, output: 5, totalTokens: 15 },
      stopReason: "stop",
    });

    const result = await handle.result;
    expect(result.finalOutput).toBe("direct child result");
    expect(result.usage).toMatchObject({ turns: 1, input: 10, output: 5, contextTokens: 15 });
    expect(result.toolCalls).toEqual([]);
    expect(events.filter((event) => event.type === "message_end")).toHaveLength(1);
  });

  it("splits a pane, starts pi, injects the task, and delivers the result on a normal settle", async () => {
    vi.stubEnv(NESTING_DEPTH_ENV, "0");
    const fake = new FakeHerdr();
    const events: any[] = [];
    const handle = await makeBackend(fake).spawn(makeSpec({
      resolvedModel: "openai-codex/gpt-6-luna",
      thinking: "max",
      onEvent: (event) => events.push(event),
    }));

    // Spawn sequence: split → agent start → prompt, in order.
    expect(fake.splits).toHaveLength(1);
    expect(fake.splits[0].direction).toBe("right");
    expect(fake.splits[0].cwd).toBe("/repo");
    expect(fake.splits[0].env[NESTING_DEPTH_ENV]).toBe("1");
    expect(fake.started).toHaveLength(1);
    expect(fake.started[0].name).toMatch(/^sa-explore-/);
    expect(fake.waits).toHaveLength(1);
    expect(fake.waits[0]).toMatchObject({ target: fake.started[0].name, status: "idle" });
    expect(fake.waits[0].timeoutMs).toBeGreaterThan(0);
    expect(fake.waits[0].timeoutMs).toBeLessThanOrEqual(500);
    expect(fake.prompts).toEqual([{ target: fake.started[0].name, text: "map the repo" }]);

    // Child argv preserves the shared configuration contract. `--kind pi`
    // makes Herdr resolve its own pi binary, so args[0] must be a pi CLI flag,
    // never a stray executable/script path (see herdr-backend.ts comment on
    // why this must not go through runner.ts's getPiInvocation()).
    const args = fake.started[0].args;
    expect(args[0]).toBe("--session-dir");
    expect(args).toContain("--no-extensions");
    expect(args.slice(args.indexOf("-e"), args.indexOf("-e") + 2)).toEqual(["-e", "/ext/a.ts"]);
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual([
      "--model",
      "openai-codex/gpt-6-luna",
    ]);
    expect(args.slice(args.indexOf("--thinking"), args.indexOf("--thinking") + 2)).toEqual([
      "--thinking",
      "max",
    ]);
    expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual(["--tools", "read,bash"]);
    expect(args).toContain("--append-system-prompt");

    // The child writes its turn to the session JSONL; the watcher completes
    // the task on the normal settle only.
    const sessionDir = sessionDirOf(fake);
    appendAssistant(sessionDir, {
      model: "test-provider/test-model",
      content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }],
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.01 } },
      stopReason: "toolUse",
    });
    appendAssistant(sessionDir, {
      model: "test-provider/test-model",
      content: [{ type: "text", text: "All done." }],
      usage: { input: 20, output: 9, cacheRead: 2, cacheWrite: 0, totalTokens: 29, cost: { total: 0.02 } },
      stopReason: "stop",
    });

    const result = await handle.result;
    expect(result.exitCode).toBe(0);
    expect(result.lifecycle).toBe("completed");
    expect(result.stopReason).toBe("stop");
    expect(result.errorMessage).toBeUndefined();
    expect(result.finalOutput).toBe("All done.");
    expect(result.model).toBe("test-provider/test-model");
    expect(result.usage.turns).toBe(2);
    expect(result.usage.input).toBe(30);
    expect(result.usage.output).toBe(14);
    expect(result.usage.contextTokens).toBe(29);
    expect(result.usage.cost).toBeCloseTo(0.03);
    expect(result.toolCalls).toEqual([{ name: "bash", argsPreview: '{"command":"ls"}' }]);

    // Synthetic events mirror the RPC stream so shared live-summary code works.
    expect(events.filter((e) => e.type === "message_end")).toHaveLength(2);
    // agent_end fires when a turn ends, not for mid-turn toolUse messages.
    expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);

    // The prompt file is disposable once settled; the session history stays.
    const remaining = fs.readdirSync(sessionDir);
    expect(remaining.filter((f) => f.startsWith("prompt-"))).toEqual([]);
    expect(remaining).toContain("session.jsonl");
  });

  it("exposes control, keeps the pane alive after completion, and stops polling", async () => {
    const fake = new FakeHerdr();
    const handle = await makeBackend(fake).spawn(makeSpec({ agentPrompt: "" }));

    expect(handle.control).toBeDefined();
    expect(handle.process).toBeUndefined();

    appendAssistant(sessionDirOf(fake), { content: [{ type: "text", text: "done" }], stopReason: "stop" });
    await handle.result;

    // Completion must not close the pane: the child is a user-owned session.
    expect(fake.closedPanes).toEqual([]);
    // The poll loop is stopped: no pane probes after settle.
    const callsAtSettle = fake.paneGetCalls;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fake.paneGetCalls).toBe(callsAtSettle);
  });
});

// ─── Interruption semantics ─────────────────────────────────────────────────

describe("HerdrBackend interruption semantics", () => {
  it("does not complete on an interrupted turn, and completes after a later normal turn", async () => {
    const fake = new FakeHerdr();
    const events: any[] = [];
    const handle = await makeBackend(fake).spawn(makeSpec({
      agentPrompt: "",
      onEvent: (event) => events.push(event),
    }));
    const sessionDir = sessionDirOf(fake);

    // User presses Escape inside the pane: the turn aborts, the task must not.
    appendAssistant(sessionDir, {
      content: [{ type: "text", text: "partial work that must be discarded" }],
      stopReason: "aborted",
    });
    await until(() => events.some((event) => event.type === "subagent_turn_aborted"));

    // The result remains pending and the logical task is interrupted, not
    // failed. The pane and its watcher are still available for guidance.
    expect(fake.closedPanes).toEqual([]);
    await expect(settleRace(handle, 100)).resolves.toBe("pending");

    // User gives corrective input in the pane; the child completes a turn.
    appendAssistant(sessionDir, { content: [{ type: "text", text: "recovered and finished" }], stopReason: "stop" });
    const result = await handle.result;
    expect(events.filter((event) => event.type === "agent_start").length).toBeGreaterThanOrEqual(1);
    expect(result.lifecycle).toBe("completed");
    expect(result.stopReason).toBe("stop");
    expect(result.exitCode).toBe(0);
    expect(result.finalOutput).toBe("recovered and finished");
    expect(result.finalOutput).not.toContain("partial work");
  });

  it("keeps the pane alive and keeps polling while the task is interrupted", async () => {
    const fake = new FakeHerdr();
    const handle = await makeBackend(fake).spawn(makeSpec({ agentPrompt: "" }));
    appendAssistant(sessionDirOf(fake), { content: [], stopReason: "aborted" });

    await expect(settleRace(handle, 80)).resolves.toBe("pending");
    expect(fake.closedPanes).toEqual([]);
    const calls = fake.paneGetCalls;
    await until(() => fake.paneGetCalls > calls); // watcher still observing
    await expect(settleRace(handle, 20)).resolves.toBe("pending");
  });

  it("survives multiple interrupted turns and returns exactly the final successful turn", async () => {
    const fake = new FakeHerdr();
    const handle = await makeBackend(fake).spawn(makeSpec({ agentPrompt: "" }));
    const sessionDir = sessionDirOf(fake);

    appendAssistant(sessionDir, { content: [{ type: "text", text: "first partial" }], stopReason: "aborted" });
    await until(() => fake.paneGetCalls > 0 && fake.prompts.length === 1);
    await handle.control!.sendMessage("first correction", "steer");
    appendAssistant(sessionDir, { content: [{ type: "text", text: "second partial" }], stopReason: "aborted" });
    await until(() => fake.prompts.length === 2);
    await handle.control!.sendMessage("second correction", "steer");
    appendAssistant(sessionDir, { content: [{ type: "text", text: "final successful answer" }], stopReason: "stop" });

    const result = await handle.result;
    expect(result.lifecycle).toBe("completed");
    expect(result.finalOutput).toBe("final successful answer");
    expect(result.finalOutput).not.toContain("first partial");
    expect(result.finalOutput).not.toContain("second partial");
    expect(fake.prompts.map((prompt) => prompt.text)).toEqual(["map the repo", "first correction", "second correction"]);
  });

  it("ignores a stale pane-death observation when guidance starts a newer turn", async () => {
    const fake = new FakeHerdr();
    fake.paneGetDelayMs = 40;
    fake.paneGetResults.push({ state: "gone" });
    const handle = await makeBackend(fake).spawn(makeSpec({ agentPrompt: "" }));
    const sessionDir = sessionDirOf(fake);

    // Let a poll for the old turn enter paneGet, then interrupt and resume
    // before its deliberately stale "gone" response returns.
    await until(() => fake.paneGetCalls > 0);
    appendAssistant(sessionDir, { content: [], stopReason: "aborted" });
    await handle.control!.sendMessage("continue with the corrected plan", "steer");
    appendAssistant(sessionDir, { content: [{ type: "text", text: "completed after guidance" }], stopReason: "stop" });

    const result = await handle.result;
    expect(result.lifecycle).toBe("completed");
    expect(result.finalOutput).toBe("completed after guidance");
  });

  it("terminates an interrupted task when the parent explicitly cancels it", async () => {
    const fake = new FakeHerdr();
    const events: any[] = [];
    const handle = await makeBackend(fake).spawn(makeSpec({
      agentPrompt: "",
      onEvent: (event) => events.push(event),
    }));
    appendAssistant(sessionDirOf(fake), { content: [], stopReason: "aborted" });
    await until(() => events.some((event) => event.type === "subagent_turn_aborted"));

    handle.control!.abort();
    const result = await handle.result;

    expect(result.lifecycle).toBe("closed");
    expect(result.stopReason).toBe("aborted");
    expect(fake.closedPanes).toHaveLength(1);
  });

  it("does not leave the parent pending forever when a steering command fails", async () => {
    const fake = new FakeHerdr();
    const handle = await makeBackend(fake).spawn(makeSpec({ agentPrompt: "" }));
    fake.agentPromptError = new Error("agent prompt transport failed");

    await expect(handle.control!.sendMessage("guidance", "steer")).rejects.toThrow("transport failed");
    const result = await handle.result;

    expect(result.lifecycle).toBe("failed");
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("transport failed");
  });

  it("resolves aborted — never completed — when the parent aborts a running child", async () => {
    const fake = new FakeHerdr();
    const handle = await makeBackend(fake).spawn(makeSpec({ agentPrompt: "" }));
    const paneId = fake.started[0].paneId;

    handle.control!.abort();
    const result = await handle.result;

    expect(result.lifecycle).toBe("closed");
    expect(result.stopReason).toBe("aborted");
    expect(result.exitCode).toBe(0);
    expect(fake.closedPanes).toContain(paneId);
    // Watcher stopped: no pane polling after settle.
    const calls = fake.paneGetCalls;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.paneGetCalls).toBe(calls);
  });

  it("still resolves aborted when the pane close itself fails", async () => {
    const fake = new FakeHerdr();
    const handle = await makeBackend(fake).spawn(makeSpec({ agentPrompt: "" }));
    fake.failPaneClose = true;

    handle.control!.abort();
    const result = await handle.result;

    // paneClose reported an error, but the poll loop observes the pane as
    // gone; either way a parent-requested close is an abort, not a success.
    expect(result.lifecycle).toBe("closed");
    expect(result.stopReason).toBe("aborted");
  });
});

// ─── Pane death / failure handling ──────────────────────────────────────────

describe("HerdrBackend failure handling", () => {
  it("errors when the pane dies mid-turn", async () => {
    const fake = new FakeHerdr();
    const handle = await makeBackend(fake).spawn(makeSpec({ agentPrompt: "" }));
    appendAssistant(sessionDirOf(fake), { content: [], stopReason: "toolUse" });

    fake.paneExists.set(fake.started[0].paneId, false); // pane killed externally
    const result = await handle.result;

    expect(result.exitCode).toBe(1);
    expect(result.stopReason).not.toBe("stop");
    expect(result.errorMessage).toContain("closed before");
  });

  it("resolves aborted when the pane is closed after an interrupted turn", async () => {
    const fake = new FakeHerdr();
    const handle = await makeBackend(fake).spawn(makeSpec({ agentPrompt: "" }));
    appendAssistant(sessionDirOf(fake), { content: [], stopReason: "aborted" });

    fake.paneExists.set(fake.started[0].paneId, false);
    const result = await handle.result;

    expect(result.lifecycle).toBe("closed");
    expect(result.stopReason).toBe("aborted");
    expect(result.exitCode).toBe(0);
  });

  it("resolves error when the pane dies after an errored turn", async () => {
    const fake = new FakeHerdr();
    const handle = await makeBackend(fake).spawn(makeSpec({ agentPrompt: "" }));
    appendAssistant(sessionDirOf(fake), { content: [], stopReason: "error", errorMessage: "Provider exploded" });

    fake.paneExists.set(fake.started[0].paneId, false);
    const result = await handle.result;

    expect(result.lifecycle).toBe("failed");
    expect(result.stopReason).toBe("error");
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("Provider exploded");
  });

  it("fails a task whose errored turn sits idle past the grace period", async () => {
    const fake = new FakeHerdr();
    const handle = await makeBackend(fake).spawn(makeSpec({ agentPrompt: "" }));
    appendAssistant(sessionDirOf(fake), { content: [], stopReason: "error", errorMessage: "Provider failed" });

    const result = await handle.result;
    expect(result.lifecycle).toBe("failed");
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Provider failed");
    expect(fake.closedPanes).toEqual([]);
  });

  it("lets the child recover from a transient error and complete normally", async () => {
    const fake = new FakeHerdr();
    const handle = await makeBackend(fake).spawn(makeSpec({ agentPrompt: "" }));
    const sessionDir = sessionDirOf(fake);

    appendAssistant(sessionDir, { content: [], stopReason: "error", errorMessage: "WebSocket error" });
    appendAssistant(sessionDir, { content: [{ type: "toolCall", name: "read", arguments: {} }], stopReason: "toolUse" });
    appendAssistant(sessionDir, { content: [{ type: "text", text: "Recovered" }], stopReason: "stop" });

    const result = await handle.result;
    expect(result.stopReason).toBe("stop");
    expect(result.errorMessage).toBeUndefined();
    expect(result.finalOutput).toBe("Recovered");
  });

  it("rejects spawn and closes the leftover pane when the Herdr command fails", async () => {
    const fake = new FakeHerdr();
    fake.agentStartError = new Error("herdr agent start failed: agent_not_ready");
    const backend = makeBackend(fake);

    await expect(backend.spawn(makeSpec())).rejects.toThrow("agent_not_ready");

    // The empty pane left behind by the failed start is closed, and nothing
    // is reported as a completion.
    expect(fake.closedPanes).toHaveLength(1);
    expect(fake.prompts).toEqual([]);
  });

  it("aborts when the tool signal fires while agent start is in flight", async () => {
    const fake = new FakeHerdr();
    const controller = new AbortController();
    fake.onAgentStart = () => controller.abort();

    await expect(makeBackend(fake).spawn(makeSpec({ agentPrompt: "", signal: controller.signal })))
      .rejects.toThrow("aborted during startup");

    // The pane was created before the abort landed; cleanup must close it.
    expect(fake.splits).toHaveLength(1);
    expect(fake.started).toHaveLength(1);
    expect(fake.closedPanes).toHaveLength(1);
    expect(fake.prompts).toEqual([]);
  });

  it("captures the model from a message that carries no usage", async () => {
    const fake = new FakeHerdr();
    const handle = await makeBackend(fake).spawn(makeSpec({ agentPrompt: "" }));
    const sessionDir = sessionDirOf(fake);

    // Real-world shape: model present, usage absent (synthesized/fallback
    // message or a provider that omits usage on non-final turns).
    appendAssistant(sessionDir, { model: "provider/only-model", content: [] });
    appendAssistant(sessionDir, { content: [{ type: "text", text: "done" }], stopReason: "stop" });

    const result = await handle.result;
    expect(result.model).toBe("provider/only-model");
  });

  it("aborts during startup without leaving a pane behind", async () => {
    const fake = new FakeHerdr();
    const controller = new AbortController();
    controller.abort(); // tool call aborted while spawn is in flight

    await expect(makeBackend(fake).spawn(makeSpec({ agentPrompt: "", signal: controller.signal })))
      .rejects.toThrow("aborted during startup");
    expect(fake.splits).toHaveLength(1); // the split raced the abort
    expect(fake.started).toEqual([]);
    expect(fake.closedPanes).toHaveLength(1);
  });

  it("uses a down split for narrow parents and the first-task hint for wide ones", async () => {
    const narrow = new FakeHerdr();
    narrow.layoutWidth = 100;
    vi.stubEnv("HERDR_PANE_ID", "wJ:pH");
    await makeBackend(narrow).spawn(makeSpec({ agentPrompt: "", splitDirection: "right" }));
    expect(narrow.splits[0].direction).toBe("down");
    expect(narrow.layoutForPane).toBe("wJ:pH");

    const wide = new FakeHerdr();
    wide.layoutWidth = 216;
    await makeBackend(wide).spawn(makeSpec({ agentPrompt: "", splitDirection: "down" }));
    expect(wide.splits[0].direction).toBe("down");

    const wideFirst = new FakeHerdr();
    wideFirst.layoutWidth = 216;
    await makeBackend(wideFirst).spawn(makeSpec({ agentPrompt: "" }));
    expect(wideFirst.splits[0].direction).toBe("right");
  });

  it("refuses to spawn at the nesting limit without touching Herdr", async () => {
    vi.stubEnv(NESTING_DEPTH_ENV, String(MAX_NESTING_DEPTH));
    const fake = new FakeHerdr();
    const handle = await makeBackend(fake).spawn(makeSpec({ agentPrompt: "" }));

    const result = await handle.result;
    expect(result.errorMessage).toContain("nesting depth limit");
    expect(fake.splits).toEqual([]);
    expect(fake.started).toEqual([]);
    expect(handle.control).toBeUndefined();
  });

  it("stamps the child pane env with the next nesting generation", async () => {
    vi.stubEnv(NESTING_DEPTH_ENV, "1");
    const fake = new FakeHerdr();
    const handle = await makeBackend(fake).spawn(makeSpec({ agentPrompt: "" }));
    appendAssistant(sessionDirOf(fake), { content: [{ type: "text", text: "done" }], stopReason: "stop" });
    await handle.result;

    expect(fake.splits[0].env[NESTING_DEPTH_ENV]).toBe(String(currentNestingDepth() + 1));
    expect(fake.splits[0].env[NESTING_DEPTH_ENV]).toBe("2");
  });
});

// ─── Initial prompt readiness and startup deadline ──────────────────────────

describe("HerdrBackend initial prompt readiness", () => {
  it("waits for idle before submitting the first prompt and does not use confirmation mode", async () => {
    const fake = new FakeHerdr();
    const handle = await makeBackend(fake).spawn(makeSpec({ agentPrompt: "" }));

    expect(fake.waits).toHaveLength(1);
    expect(fake.waits[0]).toMatchObject({ target: fake.started[0].name, status: "idle" });
    expect(fake.waits[0].timeoutMs).toBeGreaterThan(0);
    expect(fake.waits[0].timeoutMs).toBeLessThanOrEqual(500);
    expect(fake.prompts).toEqual([{ target: fake.started[0].name, text: "map the repo" }]);

    appendAssistant(sessionDirOf(fake), { content: [{ type: "text", text: "done" }], stopReason: "stop" });
    await expect(handle.result).resolves.toMatchObject({ lifecycle: "completed" });
  });

  it("fails startup with a specific notification when Herdr never observes activity", async () => {
    const fake = new FakeHerdr();
    fake.defaultAgentStatus = "idle";
    const backend = createHerdrBackend({
      cli: fake,
      pollIntervalMs: 10,
      errorSettleGraceMs: 50,
      agentStartTimeoutMs: 500,
      startupActivityTimeoutMs: 40,
    });

    const handle = await backend.spawn(makeSpec({ agentPrompt: "" }));
    const result = await handle.result;

    expect(result.lifecycle).toBe("failed");
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain(
      `Subagent startup timed out for Herdr agent "${fake.started[0].name}" in pane "${fake.started[0].paneId}":`,
    );
    expect(result.errorMessage).toContain("within 40ms");
    expect(fake.closedPanes).toHaveLength(1);
  });

  it("clears the startup deadline when the child completes before a status poll", async () => {
    const fake = new FakeHerdr();
    fake.defaultAgentStatus = "idle";
    const backend = createHerdrBackend({
      cli: fake,
      pollIntervalMs: 10,
      errorSettleGraceMs: 50,
      agentStartTimeoutMs: 500,
      startupActivityTimeoutMs: 40,
    });

    const handle = await backend.spawn(makeSpec({ agentPrompt: "" }));
    appendAssistant(sessionDirOf(fake), { content: [{ type: "text", text: "done" }], stopReason: "stop" });
    await expect(handle.result).resolves.toMatchObject({ lifecycle: "completed" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fake.closedPanes).toEqual([]);
  });

  it("keeps the timeout result when failed pane cleanup also fails", async () => {
    const fake = new FakeHerdr();
    fake.defaultAgentStatus = "idle";
    fake.failPaneClose = true;
    const stderr: string[] = [];
    const backend = createHerdrBackend({
      cli: fake,
      pollIntervalMs: 10,
      errorSettleGraceMs: 50,
      agentStartTimeoutMs: 500,
      startupActivityTimeoutMs: 40,
    });

    const handle = await backend.spawn(makeSpec({ agentPrompt: "", onStderr: (data) => stderr.push(data) }));
    const result = await handle.result;

    expect(result.errorMessage).toContain("Subagent startup timed out");
    await until(() => stderr.some((line) => line.includes("startup-timeout pane cleanup failed")));
  });

  it("treats blocked as startup activity and leaves the child available for observation", async () => {
    const fake = new FakeHerdr();
    fake.defaultAgentStatus = "blocked";
    const handle = await makeBackend(fake).spawn(makeSpec({ agentPrompt: "" }));
    await until(() => fake.paneGetCalls > 0);

    appendAssistant(sessionDirOf(fake), { content: [{ type: "text", text: "done" }], stopReason: "stop" });
    const result = await handle.result;

    expect(result.lifecycle).toBe("completed");
  });

  it("reports when agent start exhausts the combined readiness budget", async () => {
    const fake = new FakeHerdr();
    fake.agentStartDelayMs = 300;
    const backend = createHerdrBackend({
      cli: fake,
      pollIntervalMs: 10,
      errorSettleGraceMs: 50,
      agentStartTimeoutMs: 20,
      startupActivityTimeoutMs: 500,
    });

    await expect(backend.spawn(makeSpec({ agentPrompt: "" })))
      .rejects.toThrow("agent start exhausted the combined readiness budget");
    expect(fake.waits).toEqual([]);
    expect(fake.closedPanes).toHaveLength(1);
  });

  it("closes the pane when the idle readiness gate fails", async () => {
    const fake = new FakeHerdr();
    fake.agentWaitError = new Error("herdr agent wait failed: timeout");

    await expect(makeBackend(fake).spawn(makeSpec({ agentPrompt: "" }))).rejects.toThrow("agent wait failed");
    expect(fake.prompts).toEqual([]);
    expect(fake.closedPanes).toHaveLength(1);
  });

  it("propagates prompt errors without a confirmation or Enter recovery path", async () => {
    const fake = new FakeHerdr();
    fake.agentPromptError = new Error("herdr agent prompt failed: agent_blocked");

    await expect(makeBackend(fake).spawn(makeSpec({ agentPrompt: "" }))).rejects.toThrow("agent_blocked");
    expect(fake.closedPanes).toHaveLength(1);
  });
});

