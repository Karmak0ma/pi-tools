import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openPiReview } from "../src/pi-ui.mjs";

// Test only the adapter contract here. A separate smoke check uses the actual
// installed Pi Editor/key parser; these tests do not need a bundled host copy.
class FakeEditor {
  text = "";
  setText(text) { this.text = text; }
  getExpandedText() { return this.text; }
  render() { return ["FAKE_EDITOR_TOP", "EDITOR " + this.text.replaceAll("\n", " "), "FAKE_EDITOR_BOTTOM"]; }
  insertTextAtCursor(text) { this.text += text; }
  handleInput(data) { this.text += data.replaceAll("\x1b[200~", "").replaceAll("\x1b[201~", ""); }
  static lastMouse;
  handleMouse(event) { FakeEditor.lastMouse = event; }
  invalidate() {}
}
const Key = Object.fromEntries(["tab", "up", "down", "left", "right", "pageUp", "pageDown", "home", "end", "enter", "escape"].map((k) => [k, k]));
Key.ctrl = (key) => `ctrl+${key}`;
const rawKeys = { tab: "\t", up: "\x1b[A", down: "\x1b[B", enter: "\r", escape: "\x1b", "ctrl+s": "\x13", "ctrl+c": "\x03" };
const toolkit = {
  Editor: FakeEditor, Key,
  matchesKey: (data, key) => data === (rawKeys[key] || key),
  truncateToWidth: (text, width, _ellipsis, pad) => {
    const visible = text.replace(/\x1b\[[0-9;]*m/g, "");
    return visible.slice(0, width) + (pad ? " ".repeat(Math.max(0, width - visible.length)) : "");
  },
  sliceByColumn: (text, start, length) => text.slice(start, start + length),
};
const snapshot = {
  root: "/repo", comparison: { expression: "develop...HEAD" }, files: [{
    path: "a.ts", status: "M", added: 1, deleted: 0, revision: "a".repeat(64),
    baseCommit: "b".repeat(40), tipCommit: "c".repeat(40),
    rows: [{ kind: "hunk", text: "@@ -1 +1 @@" }, { kind: "add", text: "newCode();", newLine: 1 }],
  }],
};

async function harness(t, { send = async () => {}, loadToolkit = async () => toolkit, loadSnapshot = async () => structuredClone(snapshot) } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-review-component-test-"));
  await writeFile(path.join(dir, "connection.json"), JSON.stringify({ root: "/repo", comparison: "develop...HEAD" }));
  let component, close, lines = [], customCalls = 0, overlayOptions;
  const waiters = new Set();
  function draw() {
    if (component) lines = component.render(100);
    for (const notify of [...waiters]) notify();
  }
  const ctx = { ui: { custom: (factory, options) => {
    customCalls++;
    overlayOptions = options;
    return new Promise((resolve) => {
      component = factory({ terminal: { rows: 24 }, requestRender: draw }, { fg: (_color, text) => text }, { matches: () => false }, () => {
        component.dispose(); resolve();
      });
      draw();
    });
  } } };
  const opening = openPiReview(ctx, { dir, isCurrent: () => true, registerClose: (fn) => { close = fn; } }, { loadToolkit, loadSnapshot, send });
  t.after(async () => { close?.(); await opening; await rm(dir, { recursive: true, force: true }); });
  async function waitFor(text) {
    if (lines.some((line) => line.includes(text))) return;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { waiters.delete(check); reject(new Error(`No frame with ${JSON.stringify(text)}: ${lines.join("\n")}`)); }, 3000);
      function check() { if (lines.some((line) => line.includes(text))) { clearTimeout(timeout); waiters.delete(check); resolve(); } }
      waiters.add(check); check();
    });
  }
  return { dir, opening, waitFor, close: () => close?.(), input: (data) => component.handleInput(data),
    mouse: (event) => component.handleMouse(event), get calls() { return customCalls; },
    get options() { return overlayOptions; }, get lines() { return lines; } };
}

async function addComment(h) {
  await h.waitFor("newCode();");
  h.input("\t"); h.input("\x1b[B"); h.input("\r");
  await h.waitFor("Draft note");
  h.input("Please keep the empty case."); h.input("\x13");
  await h.waitFor("Comment saved as unsent.");
}

test("in-Pi keyboard review saves anchored comments, retries safely, and returns to conversation", async (t) => {
  const batches = [];
  const h = await harness(t, { send: async (_connection, batch) => {
    batches.push(structuredClone(batch));
    if (batches.length === 1) throw new Error("temporary failure");
  } });
  await addComment(h);
  assert.equal(h.options.overlay, true);
  assert.equal(h.options.overlayOptions.width, "100%");
  h.input("s"); await h.waitFor("CONFIRM SEND");
  h.input("\r"); await h.waitFor("Enter retries;");
  h.input("\r"); await h.waitFor("Sent 1 comments to Pi");
  assert.equal(batches.length, 2);
  assert.equal(batches[0].id, batches[1].id);
  assert.equal(batches[0].comments[0].path, "a.ts");
  assert.equal(batches[0].comments[0].line, 1);
  assert.equal(batches[0].comments[0].tipCommit, "c".repeat(40));
  assert.equal(batches[0].comments[0].text, "Please keep the empty case.");
  const saved = JSON.parse(await readFile(path.join(h.dir, "drafts.json"), "utf8"));
  assert.equal(saved.comments.length, 1);
  assert.ok(saved.comments[0].sentAt > 0);
  assert.ok(h.lines.some((line) => line.includes('Sent to Pi')));
  h.input("q"); await h.opening;
});

test('in-Pi confirmation supports mouse cancel and send without losing drafts', async (t) => {
  const batches = [];
  const h = await harness(t, { send: async (_connection, batch) => batches.push(batch) });
  await addComment(h);
  h.input('s'); await h.waitFor('CONFIRM SEND');
  h.mouse({ type: 'press', button: 'left', x: 14, y: 22 });
  await h.waitFor('Send cancelled.');
  assert.equal(batches.length, 0);
  h.input('s'); await h.waitFor('CONFIRM SEND');
  h.mouse({ type: 'press', button: 'left', x: 4, y: 22 });
  await h.waitFor('Sent 1 comments to Pi');
  assert.equal(batches.length, 1);
  h.input('q'); await h.opening;
});

test("normalized Pi mouse coordinates open the displayed line and pasted commands remain text", async (t) => {
  const h = await harness(t);
  await h.waitFor("newCode();");
  assert.equal(h.lines.some((line) => line.includes('[+]')), false);
  h.mouse({ type: 'move', button: 'none', x: 50, y: 3 });
  assert.equal(h.lines.filter((line) => line.includes('[+]')).length, 1);
  h.mouse({ type: 'move', button: 'none', x: 2, y: 3 });
  assert.equal(h.lines.some((line) => line.includes('[+]')), false);
  h.input("\x1b[200~s\rq\x1b[201~");
  // Zero-based row 3 is the displayed source row, not source line number 3.
  assert.equal(h.mouse({ type: "press", button: "left", x: 50, y: 3 }).handled, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.lines.some((line) => line.includes('Draft note')), false);
  h.mouse({ type: 'press', button: 'left', x: 98, y: 3 });
  h.mouse({ type: 'click', button: 'left', x: 98, y: 3 });
  await h.waitFor("Draft note");
  await h.waitFor("Write a note…");
  assert.equal(h.lines.some((line) => line.includes('FAKE_EDITOR_TOP') || line.includes('FAKE_EDITOR_BOTTOM')), false);
  const bodyY = h.lines.findIndex((line) => line.includes('Write a note…'));
  h.mouse({ type: 'press', button: 'left', x: 50, y: bodyY });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(FakeEditor.lastMouse.y, 1, 'Inline text clicks account for the removed host border');
  assert.equal(FakeEditor.lastMouse.height, 3);
  h.input("\x1b[200~s\x13q\x1b[201~");
  h.input("\x13"); await h.waitFor("Comment saved as unsent.");
  const saved = JSON.parse(await readFile(path.join(h.dir, "drafts.json"), "utf8"));
  assert.equal(saved.comments[0].line, 1);
  assert.equal(saved.comments[0].text, "sq");
  assert.equal(saved.pending, undefined);
});

test("Pi captures divider drags and keeps comment hit targets aligned after resizing", async (t) => {
  const h = await harness(t);
  await h.waitFor("newCode();");
  const edge = () => h.lines[1].indexOf("│");
  assert.equal(edge(), 27);
  const press = h.mouse({ type: "press", button: "left", x: edge(), y: 1 });
  assert.equal(press.capture, true);
  assert.equal(h.mouse({ type: "drag", button: "left", x: 45, y: 3 }).capture, true);
  assert.equal(edge(), 45);
  assert.equal(h.mouse({ type: "release", button: "left", x: 50, y: 3 }).capture, false);
  assert.equal(edge(), 50);
  h.mouse({ type: "drag", button: "left", x: 35, y: 3 });
  assert.equal(edge(), 50, "release ends resize capture");
  h.mouse({ type: "press", button: "left", x: 98, y: 3 });
  await h.waitFor("Draft note");
  assert.ok(h.lines.some((line) => line.includes("Write a note…")));

  // Layout may also be adjusted while editing without losing editor text.
  h.input("keep this");
  await h.waitFor("keep this");
  h.mouse({ type: "press", button: "left", x: edge(), y: 1 });
  h.mouse({ type: "drag", button: "left", x: 59, y: 1 });
  h.mouse({ type: "release", button: "left", x: 59, y: 1 });
  assert.equal(edge(), 59);
  assert.ok(h.lines.some((line) => line.includes("keep this")));
});

test("Pi forwards bracket hunk navigation and wheel scrolling to the shared viewport", async (t) => {
  const long = structuredClone(snapshot);
  long.files[0].rows = [
    { kind: "hunk", text: "@@ FIRST @@" },
    ...Array.from({ length: 40 }, (_, i) => ({ kind: "add", text: `code${i}`, newLine: i + 1 })),
    { kind: "hunk", text: "@@ SECOND @@" },
    { kind: "add", text: "lastCode", newLine: 99 },
  ];
  const h = await harness(t, { loadSnapshot: async () => long });
  await h.waitFor("@@ FIRST @@");
  assert.ok(!h.lines.some((line) => line.includes("@@ SECOND @@")));
  h.mouse({ type: "wheel", wheelDelta: 1, x: 55, y: 4 });
  await h.waitFor("code20");
  assert.ok(!h.lines.some((line) => line.includes("@@ FIRST @@")));
  h.input("]");
  await h.waitFor("@@ SECOND @@");
  h.input("[");
  await h.waitFor("@@ FIRST @@");
});

test("closing before the Pi toolkit loads never mounts a stale screen", async (t) => {
  let resolveToolkit;
  const h = await harness(t, { loadToolkit: () => new Promise((resolve) => { resolveToolkit = resolve; }) });
  h.close(); resolveToolkit(toolkit);
  await h.opening;
  assert.equal(h.calls, 0);
});

test("shutdown during an outstanding Git read closes the component and ignores the late snapshot", async (t) => {
  let finishRead;
  const h = await harness(t, { loadSnapshot: () => new Promise((resolve) => { finishRead = resolve; }) });
  await h.waitFor("Loading repository");
  // The controller starts its read in a microtask after the component mounts.
  await Promise.resolve();
  h.close(); await h.opening;
  finishRead(structuredClone(snapshot));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.lines.some((line) => line.includes("newCode();")), false);
});
