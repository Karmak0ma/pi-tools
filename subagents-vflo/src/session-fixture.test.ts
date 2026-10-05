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
import { afterEach, describe, expect, it } from "vitest";
import { SessionWatcher } from "./session-watcher.js";
import { createHerdrBackend } from "./herdr-backend.js";
import type { HerdrClient } from "./herdr.js";

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
  agentStart = async (_name: string, _paneId: string, args: string[]) => {
    this.startedArgs = args;
  };
  agentWait = async () => {};
  agentGet = async () => ({ agentStatus: "idle", lifecycleHookAuthority: true });
  agentPrompt = async () => {};
  paneGet = async () => {
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