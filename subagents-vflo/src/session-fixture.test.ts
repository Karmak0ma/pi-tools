/**
 * Golden-fixture tests against a REAL pi session file.
 *
 * The watcher/monitor contract rests on the exact session-JSONL record shape
 * ({"type":"message","message":{role:"assistant",...}}) and the real set of
 * stopReason values. The fixture at src/fixtures/real-pi-session.jsonl is
 * captured from actual pi session files on this machine (strings truncated,
 * structure intact) so these tests pin the contract against reality instead
 * of against hand-built fakes.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionWatcher } from "./session-watcher.js";
import { createHerdrBackend } from "./herdr-backend.js";
import type { HerdrClient } from "./herdr.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const fixtureUrl = new URL("./fixtures/real-pi-session.jsonl", import.meta.url);

function readFixtureLines(): string[] {
  return fs.readFileSync(fixtureUrl, "utf-8").split("\n").filter((l) => l.trim());
}

function fixtureLinesWithStopReason(stopReason: string): string {
  return readFixtureLines()
    .filter((l) => (JSON.parse(l).message as any)?.stopReason === stopReason)
    .join("\n") + "\n";
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-test-"));
  tempDirs.push(dir);
  return dir;
}

class CountingFake implements HerdrClient {
  paneGetCalls = 0;
  startedArgs: string[] = [];

  paneSplit = async () => ({ paneId: "wJ:pF" });
  paneZoom = async () => {};
  agentStart = async (_name: string, _paneId: string, args: string[]) => {
    this.startedArgs = args;
  };
  agentWait = async () => {};
  agentGet = async () => ({ agentStatus: "idle", lifecycleHookAuthority: true, paneId: "wJ:pF" });
  agentPrompt = async (_target: string, _text: string) => {};
  paneGet: HerdrClient["paneGet"] = async () => {
    this.paneGetCalls++;
    return { state: "exists" as const, agentStatus: "working" };
  };
  paneClose = async () => {};
  paneLayout = async () => [];
}

function makeFake(): CountingFake {
  return new CountingFake();
}

function sessionDirOf(fake: CountingFake): string {
  const args = fake.startedArgs;
  return args[args.indexOf("--session-dir") + 1];
}

function makeBackend(fake: HerdrClient) {
  // The fake pane always reports "working", so a "stop" completes through the
  // completion fallback timer. A short timer keeps these contract tests fast.
  return createHerdrBackend({
    cli: fake,
    pollIntervalMs: 10,
    errorSettleGraceMs: 50,
    agentStartTimeoutMs: 500,
    completionFallbackMs: 30,
  });
}

describe("real session JSONL contract", () => {
  it("SessionWatcher extracts the real assistant messages in order", async () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, "session.jsonl"), readFixtureLines().join("\n") + "\n");

    const seen: any[] = [];
    const watcher = new SessionWatcher({ sessionDir: dir, onAssistantMessage: (m) => seen.push(m) });
    await watcher.poll();

    expect(seen.map((m) => m.stopReason)).toEqual(["toolUse", "stop", "error", "aborted"]);
    expect(seen.every((m) => m.role === "assistant")).toBe(true);
    expect(seen.every((m) => Array.isArray(m.content))).toBe(true);
  });

  it("HerdrChildMonitor completes a task from the real stopReason shapes", async () => {
    const fake = makeFake();
    const handle = await makeBackend(fake).spawn({
      resolvedModel: "parent/model",
      resolvedTools: ["read"],
      resolvedCwd: "/repo",
      agentName: "explore",
      agentPrompt: "",
      taskText: "task",
    });

    // Replay the real fixture as the child's session, in real order, up to
    // and including the "stop" entry. The fixture is a catalogue of shapes,
    // not one run: its later error/aborted entries would mean the run went
    // on after the stop, and then the task correctly does not complete.
    const lines = readFixtureLines();
    const stopIndex = lines.findIndex((l) => JSON.parse(l).message?.stopReason === "stop");
    fs.writeFileSync(path.join(sessionDirOf(fake), "session.jsonl"), lines.slice(0, stopIndex + 1).join("\n") + "\n");

    const result = await handle.result;

    // The real "stop" entry completes the task; the real toolUse entry before
    // it contributes its tool call and usage.
    expect(result.exitCode).toBe(0);
    expect(result.stopReason).toBe("stop");
    expect(result.errorMessage).toBeUndefined();
    expect(typeof result.model).toBe("string");
    expect(result.model).toMatch(/claude-opus/);
    expect(result.usage.turns).toBe(2);
    expect(result.usage.input).toBeGreaterThan(0);
    expect(result.usage.contextTokens).toBeGreaterThan(0);
    expect(result.toolCalls[0]?.name).toBe("bash");
    expect(result.finalOutput).toContain("review-judge");
  });

  // The pane itself is part of continuation behavior, not only its copied
  // context. Replaying its old stops would falsely finish the new request.
  it("reuses the idle Herdr pane and replaces it only after confirmed closure", async () => {
    const dir = makeDir();
    const fake = makeFake();
    const splits = vi.spyOn(fake, "paneSplit");
    const starts = vi.spyOn(fake, "agentStart");
    const closes = vi.spyOn(fake, "paneClose");
    const prompts = vi.spyOn(fake, "agentPrompt");
    const pane = vi.spyOn(fake, "paneGet").mockResolvedValue({ state: "exists", agentStatus: "idle" });
    const spec = {
      resolvedTools: ["read"], resolvedCwd: dir, agentName: "explore", agentPrompt: "",
      taskText: "first", parentSessionDir: dir,
    };
    const handle = await makeBackend(fake).spawn(spec);
    const session = SessionManager.create(dir, sessionDirOf(fake));
    const entry = JSON.parse(fixtureLinesWithStopReason("stop"));
    session.appendMessage({ role: "user", content: "remember blue lantern", timestamp: 1 });
    session.appendMessage(entry.message);
    await handle.result;
    expect(handle.resume).toBeTypeOf("function");
    const source = session.getSessionFile()!;
    const frozen = path.join(dir, "completed.continuation");
    fs.copyFileSync(source, frozen);
    // Manual activity remains part of the live conversation, but must not be
    // replayed as the automated follow-up's output, usage or completion.
    session.appendMessage({ role: "user", content: "manual input", timestamp: 2 });
    session.appendMessage(entry.message);
    prompts.mockImplementation(async (_target, text) => {
      session.appendMessage({ role: "user", content: text, timestamp: 3 });
      session.appendMessage({ ...entry.message, content: [{ type: "text", text: "new reply" }] });
    });
    const nextSpec = { ...spec, taskText: "follow-up", continueFrom: frozen };
    const next = await handle.resume!(nextSpec);
    const result = await next.result;
    expect(result.finalOutput).toBe("new reply");
    expect(result.usage.turns).toBe(1);
    expect(result.sessionFile).toBe(source);
    expect(SessionManager.open(source).getSessionId()).toBe(session.getSessionId());
    expect(splits).toHaveBeenCalledTimes(1);
    expect(starts).toHaveBeenCalledTimes(1);
    // The next handle must retain the same capability, not only the first.
    const third = await next.resume!({ ...nextSpec, taskText: "third request" });
    expect((await third.result).usage.turns).toBe(1);
    fs.copyFileSync(source, frozen);

    const status = vi.spyOn(fake, "agentGet");
    for (const state of ["working", "blocked", "unknown"]) {
      status.mockResolvedValueOnce({ agentStatus: state, lifecycleHookAuthority: true, paneId: "wJ:pF" });
      await expect(next.resume!(nextSpec)).rejects.toThrow(/idle|busy|blocked|ready/i);
    }
    status.mockResolvedValueOnce({ agentStatus: "idle", lifecycleHookAuthority: true, paneId: "other:pane" });
    await expect(third.resume!(nextSpec)).rejects.toThrow(/original agent/i);
    prompts.mockRejectedValueOnce(new Error("prompt refused"));
    await expect(third.resume!(nextSpec)).rejects.toThrow("prompt refused");
    pane.mockRejectedValueOnce(new Error("transport unavailable"));
    await expect(next.resume!(nextSpec)).rejects.toThrow("transport unavailable");
    // An absent agent in a still-open pane is not evidence of pane closure.
    status.mockRejectedValueOnce(Object.assign(new Error("agent removed"), { herdrCode: "agent_not_found" }));
    await expect(third.resume!(nextSpec)).rejects.toThrow("agent removed");
    expect(splits).toHaveBeenCalledTimes(1);
    expect(closes).not.toHaveBeenCalled();
    pane.mockResolvedValueOnce({ state: "gone" });
    prompts.mockImplementation(async () => {});
    const replacement = await third.resume!(nextSpec);
    const forkFile = fake.startedArgs[fake.startedArgs.indexOf("--session") + 1];
    expect(forkFile).not.toBe(source);
    expect(fs.readFileSync(forkFile, "utf8")).toContain("manual input");
    expect(fs.readFileSync(forkFile, "utf8")).toContain("third request");
    expect(splits).toHaveBeenCalledTimes(2);
    expect(starts).toHaveBeenCalledTimes(2);
    fs.appendFileSync(forkFile, fixtureLinesWithStopReason("stop"));
    expect((await replacement.result).usage.turns).toBe(1);

    // The user can close the pane between the two lookups. Confirm closure
    // again before replacing it; an agent lookup error alone is not enough.
    pane.mockResolvedValueOnce({ state: "exists", agentStatus: "idle" }).mockResolvedValueOnce({ state: "gone" });
    status.mockRejectedValueOnce(Object.assign(new Error("agent removed"), { herdrCode: "agent_not_found" }));
    const raced = await replacement.resume!(nextSpec);
    expect(splits).toHaveBeenCalledTimes(3);
    const racedFile = fake.startedArgs[fake.startedArgs.indexOf("--session") + 1];
    fs.appendFileSync(racedFile, fixtureLinesWithStopReason("stop"));
    expect((await raced.result).usage.turns).toBe(1);
  });

  // Prior stop entries are model context only. Charging them as current
  // usage or treating them as completion loses an async follow-up outright.
  it("forks Herdr context without replaying old completion or usage", async () => {
    const dir = makeDir();
    const original = SessionManager.create(dir, dir);
    original.appendMessage({ role: "user", content: "remember blue 🏮", timestamp: 1 });
    const finalEntry = JSON.parse(fixtureLinesWithStopReason("stop"));
    original.appendMessage(finalEntry.message);
    const source = original.getSessionFile()!;
    const before = fs.readFileSync(source, "utf8");
    const fake = makeFake();
    const handle = await makeBackend(fake).spawn({
      resolvedTools: ["read"], resolvedCwd: dir, agentName: "explore", agentPrompt: "",
      taskText: "follow-up", parentSessionDir: dir, continueFrom: source,
    });
    const forkFile = fake.startedArgs[fake.startedArgs.indexOf("--session") + 1];
    try {
      expect(forkFile).not.toBe(source);
      expect(SessionManager.open(forkFile).buildSessionContext().messages).toEqual(original.buildSessionContext().messages);
      let settled = false;
      void handle.result.then(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(settled).toBe(false);
      fs.appendFileSync(forkFile, fixtureLinesWithStopReason("stop"));
      const boundary = fs.statSync(forkFile).size;
      // A later partial append must not become part of the completed snapshot.
      fs.appendFileSync(forkFile, '{"type":"message"');
      const result = await handle.result;
      expect(result.lifecycle).toBe("completed");
      expect(result.usage.turns).toBe(1);
      expect(result.sessionFile).toBe(forkFile);
      expect(result.sessionBytes).toBe(boundary);
      expect(fs.readFileSync(source, "utf8")).toBe(before);
    } finally {
      if (handle.control) handle.control.abort();
      await handle.result;
    }
  });

  it("a real 'aborted' entry keeps the task open; a later real 'stop' completes it", async () => {
    const fake = makeFake();
    const handle = await makeBackend(fake).spawn({
      resolvedTools: ["read"],
      resolvedCwd: "/repo",
      agentName: "explore",
      agentPrompt: "",
      taskText: "task",
    });

    // Real aborted entry only: the interrupted turn must not complete the task.
    const sessionPath = path.join(sessionDirOf(fake), "session.jsonl");
    fs.writeFileSync(sessionPath, fixtureLinesWithStopReason("aborted"));
    await new Promise((resolve) => setTimeout(resolve, 80));

    const result = await Promise.race([
      handle.result.then(() => "settled" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 100)),
    ]);
    expect(result).toBe("pending");
    expect(fake.paneGetCalls).toBeGreaterThan(0);

    // The user gives corrective input; the child produces a real normal stop.
    fs.appendFileSync(sessionPath, fixtureLinesWithStopReason("stop"));
    const final = await handle.result;
    expect(final.stopReason).toBe("stop");
    expect(final.exitCode).toBe(0);
    expect(final.finalOutput).toContain("review-judge");
  });
});