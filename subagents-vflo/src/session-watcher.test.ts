import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionWatcher } from "./session-watcher.js";

const tempDirs: string[] = [];

function makeSessionDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-watcher-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function assistantEntry(message: Record<string, unknown>): string {
  return JSON.stringify({ type: "message", message: { role: "assistant", ...message } });
}

function writeSessionLines(dir: string, lines: string[], fileName = "session.jsonl"): void {
  fs.writeFileSync(path.join(dir, fileName), lines.join("\n") + "\n");
}

describe("SessionWatcher", () => {
  it("emits only assistant messages from the session file", async () => {
    const dir = makeSessionDir();
    writeSessionLines(dir, [
      JSON.stringify({ type: "session", version: 3 }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
      assistantEntry({ content: [{ type: "text", text: "hello" }], stopReason: "stop" }),
      JSON.stringify({ type: "model_change", model: "x" }),
    ]);

    const seen: any[] = [];
    const watcher = new SessionWatcher({ sessionDir: dir, onAssistantMessage: (m) => seen.push(m) });
    await watcher.poll();

    expect(seen).toHaveLength(1);
    expect(seen[0].content[0].text).toBe("hello");
    expect(seen[0].stopReason).toBe("stop");
  });

  it("does not re-emit lines on repeated polls", async () => {
    const dir = makeSessionDir();
    writeSessionLines(dir, [assistantEntry({ content: [], stopReason: "toolUse" })]);

    const seen: any[] = [];
    const watcher = new SessionWatcher({ sessionDir: dir, onAssistantMessage: (m) => seen.push(m) });
    await watcher.poll();
    await watcher.poll();
    await watcher.poll();

    expect(seen).toHaveLength(1);
  });

  it("carries a torn trailing line across polls without emitting it twice", async () => {
    const dir = makeSessionDir();
    const filePath = path.join(dir, "session.jsonl");
    const fullLine = assistantEntry({ content: [{ type: "text", text: "done" }], stopReason: "stop" });

    // Simulate a mid-append read: header complete, assistant entry torn.
    fs.writeFileSync(filePath, '{"type":"session","version":3}\n' + fullLine.slice(0, 20));
    const seen: any[] = [];
    const watcher = new SessionWatcher({ sessionDir: dir, onAssistantMessage: (m) => seen.push(m) });
    await watcher.poll();
    expect(seen).toHaveLength(0);

    fs.appendFileSync(filePath, fullLine.slice(20) + "\n");
    await watcher.poll();
    expect(seen).toHaveLength(1);
    expect(seen[0].stopReason).toBe("stop");

    await watcher.poll();
    expect(seen).toHaveLength(1);
  });

  it("discovers session files nested under subdirectories", async () => {
    const dir = makeSessionDir();
    const nested = path.join(dir, "--home-user-repo--");
    fs.mkdirSync(nested);
    writeSessionLines(nested, [assistantEntry({ content: [], stopReason: "stop" })], "2025_abc.jsonl");

    const seen: any[] = [];
    const watcher = new SessionWatcher({ sessionDir: dir, onAssistantMessage: (m) => seen.push(m) });
    await watcher.poll();
    expect(seen).toHaveLength(1);
  });

  it("survives a missing directory and malformed lines", async () => {
    const dir = makeSessionDir();
    const filePath = path.join(dir, "session.jsonl");
    fs.writeFileSync(filePath, "not json\n" + assistantEntry({ content: [], stopReason: "stop" }) + "\n");

    const seen: any[] = [];
    const watcher = new SessionWatcher({ sessionDir: dir, onAssistantMessage: (m) => seen.push(m) });
    await watcher.poll();
    expect(seen).toHaveLength(1);

    // A transient disappearance of the directory must not throw.
    fs.rmSync(dir, { recursive: true, force: true });
    await expect(watcher.poll()).resolves.toBeUndefined();
  });
});