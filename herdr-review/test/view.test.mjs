import test from "node:test";
import assert from "node:assert/strict";
import { anchor, updateOutdated, frame, hitTest, InputDecoder, fit, plain } from "../src/view.mjs";

const file = { path: "new.ts", oldPath: "old.ts", status: "R", added: 1, deleted: 1, revision: "a".repeat(64), rows: [
  { kind: "hunk", text: "@@ -41 +41 @@" },
  { kind: "delete", text: "old();", oldLine: 41 },
  { kind: "add", text: "new();", newLine: 41 },
] };

test("anchors use old path/line for deletions and new path/line for additions", () => {
  assert.equal(anchor(file, file.rows[0]), undefined);
  assert.deepEqual({ ...anchor(file, file.rows[1]), text: undefined }, { filePath: "new.ts", path: "old.ts", side: "old", line: 41, quote: "old();", revision: file.revision, outdated: false, text: undefined });
  assert.equal(anchor(file, file.rows[2]).path, "new.ts");
  assert.equal(anchor(file, file.rows[2]).side, "new");
  const historical = anchor({ ...file, baseCommit: 'b'.repeat(40), tipCommit: 'c'.repeat(40) }, file.rows[1]);
  assert.equal(historical.baseCommit, 'b'.repeat(40));
  assert.equal(historical.tipCommit, 'c'.repeat(40));
});

test("comments become outdated without changing their source anchor", () => {
  const c = { ...anchor(file, file.rows[2]), text: "Check this." };
  const [outdated] = updateOutdated([c], { files: [{ ...file, revision: "b".repeat(64) }] });
  assert.equal(outdated.outdated, true);
  assert.equal(outdated.line, 41);
  assert.equal(outdated.quote, "new();");
  assert.equal(updateOutdated([outdated], { files: [file] })[0].outdated, false);
});

test("diff hit mapping follows scroll position, not screen line numbers", () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ kind: "add", text: `line ${i}`, newLine: i + 200 }));
  const state = { snapshot: { root: "/repo", files: [{ ...file, rows }] }, comments: [], mode: "review", fileIndex: 0, rowIndex: 70, horizontal: 0, focus: "diff" };
  const rendered = frame(state, 100, 20);
  const hit = rendered.hits.find((h) => h.type === "row" && h.index === 70);
  assert.ok(hit);
  assert.equal(hitTest(rendered.hits, hit.x1 + 10, hit.y).index, 70);
  assert.equal(anchor(file, rows[hit.index]).line, 270);
  assert.equal(hit.source.line, 270);
  // A refresh after input arrival must not rewrite the already displayed hit.
  state.snapshot = { root: "/repo", files: [{ ...file, rows: [{ kind: "add", text: "unrelated", newLine: 1 }] }] };
  assert.equal(hit.source.quote, "line 70");
  assert.equal(rendered.lines.length, 20);
  state.snapshot.comparison = { expression: 'develop...HEAD' };
  assert.match(frame(state, 100, 20).lines[0], /develop\.\.\.HEAD/);
});

test('source rows have a fixed right-hand [+] target distinct from their text', () => {
  const state = { snapshot: { root: '/repo', files: [file] }, comments: [], mode: 'review', fileIndex: 0, rowIndex: 1, horizontal: 200, focus: 'diff' };
  const rendered = frame(state, 100, 24);
  const plus = rendered.hits.find((h) => h.type === 'add' && h.source.side === 'old');
  assert.ok(plus);
  assert.equal(plus.x1, 97);
  assert.equal(plus.x2, 99);
  assert.equal(rendered.lines.some((line) => line.includes('[+]')), false);
  state.pointer = { x: 50, y: plus.y };
  const hovered = frame(state, 100, 24);
  assert.equal(hovered.lines.filter((line) => line.includes('[+]')).length, 1);
  assert.ok(hovered.lines[plus.y - 1].replace(/\x1b\[[0-9;]*m/g, '').endsWith('[+] '));
  state.pointer = { x: 5, y: plus.y };
  assert.equal(frame(state, 100, 24).lines.some((line) => line.includes('[+]')), false);
  assert.equal(hitTest(rendered.hits, 50, plus.y).type, 'row');
  assert.equal(hitTest(rendered.hits, 99, plus.y).type, 'add');
  assert.equal(plus.source.path, 'old.ts');
  assert.equal(rendered.hits.filter((h) => h.type === 'add').length, 2);
});

test('the editor stays inline with its source and preserves host cursor markers', () => {
  for (const [width, height] of [[64, 16], [100, 24]]) {
    const state = { snapshot: { root: '/repo', files: [file] }, comments: [], mode: 'edit', fileIndex: 0, rowIndex: 2, horizontal: 0, focus: 'diff', editor: { anchor: anchor(file, file.rows[2]), text: 'draft' } };
    const marker = '\x1b_pi:c\x07';
    const rendered = frame(state, width, height, fit, (size) => [marker + 'x'.repeat(size)]);
    const source = rendered.hits.find((h) => h.type === 'add' && h.index === 2);
    assert.ok(source.y < rendered.editorBounds.y);
    assert.ok(rendered.lines.some((line) => line.includes('new();')));
    assert.ok(rendered.lines.some((line) => line.includes(marker)));
    assert.ok(rendered.hits.some((h) => h.type === 'editorSave'));
    assert.ok(rendered.hits.some((h) => h.type === 'editorCancel'));
    assert.equal(rendered.lines.length, height);
    assert.ok(rendered.lines.some((line) => line.includes('Draft note · new.ts R41')));
    assert.ok(rendered.lines.some((line) => line.includes('Save (^S)')));
    assert.ok(rendered.lines.some((line) => line.includes('Cancel (Esc)')));
    for (const line of rendered.lines) {
      const visible = line.replace(/\x1b\[[0-9;]*m/g, '').replaceAll(marker, '');
      assert.equal([...visible].length, width, 'Every box border and attached action fits the viewport');
    }
  }
});

test('source backgrounds survive keyboard selection and hover has a separate neutral highlight', () => {
  const state = { snapshot: { root: '/repo', files: [file] }, comments: [], mode: 'review', fileIndex: 0, rowIndex: 1, horizontal: 0, focus: 'diff' };
  const rendered = frame(state, 100, 24);
  const deleted = rendered.hits.find((h) => h.type === 'row' && h.index === 1);
  const added = rendered.hits.find((h) => h.type === 'row' && h.index === 2);
  assert.ok(rendered.lines[deleted.y - 1].includes('\x1b[48;2;63;29;33m'));
  assert.ok(rendered.lines[added.y - 1].includes('\x1b[48;2;21;52;32m'));
  assert.ok(!rendered.lines[deleted.y - 1].split('│')[1].includes('\x1b[7m'));
  state.pointer = { x: 50, y: added.y };
  assert.ok(frame(state, 100, 24).lines[added.y - 1].includes('\x1b[48;2;57;64;71m'));
});

test("source text cannot emit terminal controls; wide characters keep bounded width", () => {
  assert.equal(plain("a\x1b[2J\x07b"), "a[2Jb");
  assert.equal(fit("界x", 3), "界x");
  assert.equal(fit("界x", 2), "界");
  assert.equal(fit("界x", 2, 1), " x");
  assert.equal(fit("abc", 5), "abc  ");
});

test("fragmented mouse/arrow/paste packets decode safely", () => {
  const decoder = new InputDecoder();
  assert.deepEqual(decoder.feed("\x1b[<0;40;"), []);
  assert.deepEqual(decoder.feed("6M"), [{ type: "mouse", button: 0, x: 40, y: 6, down: true }]);
  assert.deepEqual(decoder.feed("\x1b["), []);
  assert.deepEqual(decoder.feed("B"), [{ type: "key", key: "down" }]);
  assert.deepEqual(decoder.feed("\x1b[20"), []);
  const events = decoder.feed("0~s\r\x1b[<0;40;6M\x1b[201~");
  assert.ok(events.every((e) => e.type === "paste"));
  assert.equal(events.map((e) => e.text).join(""), "s\r\x1b[<0;40;6M");
  assert.deepEqual(decoder.feed("\x1b"), []);
  assert.deepEqual(decoder.flushEscape(), [{ type: "key", key: "escape" }]);
});
