import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createReviewController } from '../src/controller.mjs';

const fixture = { root: '/repo', files: ['a.ts', 'b.ts'].map((name, i) => ({
  path: name, status: 'M', revision: String(i + 1).repeat(64), added: 1, deleted: 0,
  rows: [{ kind: 'hunk', text: '@@ -1 +1 @@' }, { kind: 'add', text: `code${i}();`, newLine: i + 1 }],
})) };

async function harness(t, dependencies = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'review-controller-test-'));
  const attempts = [], controllers = [];
  let reads = 0;
  const options = { dir, connection: { root: '/repo' },
    loadSnapshot: async () => { reads++; return structuredClone(fixture); },
    send: async (_connection, batch) => { attempts.push(structuredClone(batch)); }, ...dependencies };
  async function open() {
    const controller = await createReviewController(options);
    controllers.push(controller); await controller.start(); return controller;
  }
  const c = await open();
  t.after(async () => { for (const item of controllers) item.stop(); await rm(dir, { recursive: true, force: true }); });
  return { c, dir, attempts, open, get reads() { return reads; } };
}
const key = (key) => ({ type: 'key', key });
const text = (text) => ({ type: 'text', text });
async function add(c, message = 'Please keep the empty case.') {
  c.state.focus = 'diff'; c.state.rowIndex = 1; c.state.selectedCommentId = undefined;
  await c.handle(key('enter')); c.state.editor.text = message; await c.handle(key('save'));
}
function click(c, hit) {
  return c.handle(c.capture({ type: 'mouse', down: true, button: 0, x: Math.floor((hit.x1 + hit.x2) / 2), y: hit.y }));
}

test('only [+] starts a mouse comment; the box stays inline and mouse cancel does not save', async (t) => {
  const { c } = await harness(t);
  let rendered = c.render(100, 24);
  const body = rendered.hits.find((h) => h.type === 'row' && h.index === 1);
  await click(c, body);
  assert.equal(c.state.mode, 'review');
  rendered = c.render(100, 24);
  await click(c, rendered.hits.find((h) => h.type === 'add'));
  assert.equal(c.state.mode, 'edit');
  c.state.editor.text = 'not saved';
  rendered = c.render(100, 24);
  assert.ok(rendered.editorBounds);
  assert.ok(rendered.lines.some((line) => line.includes('code0();')));
  await click(c, rendered.hits.find((h) => h.type === 'editorCancel'));
  assert.equal(c.state.comments.length, 0);
  assert.equal(c.state.mode, 'review');
});

test('hover repaints only on source-row transitions and never opens an editor or reads Git', async (t) => {
  let changes = 0;
  const h = await harness(t, { onChange: () => { changes++; } });
  const rendered = h.c.render(100, 24);
  const source = rendered.hits.find((hit) => hit.type === 'row' && hit.source);
  changes = 0;
  h.c.point(50, source.y);
  assert.equal(changes, 1);
  h.c.point(60, source.y);
  assert.equal(changes, 1);
  assert.equal(h.c.render(100, 24).lines.filter((line) => line.includes('[+]')).length, 1);
  h.c.point(2, source.y);
  assert.equal(changes, 2);
  assert.equal(h.c.render(100, 24).lines.some((line) => line.includes('[+]')), false);
  h.c.point(2, 1);
  assert.equal(changes, 2);
  assert.equal(h.c.state.mode, 'review');
  assert.equal(h.reads, 1);
});

test('sent notes persist, are not resent, and editing creates only one new unsent revision', async (t) => {
  const h = await harness(t);
  const c = h.c;
  await add(c, 'original feedback');
  await c.handle(text('s')); await c.handle(key('enter'));
  assert.equal(h.attempts.length, 1);
  assert.equal(c.state.comments.length, 1);
  const original = structuredClone(c.state.comments[0]);
  assert.ok(original.sentAt > 0);
  assert.ok(c.render(100, 24).lines.some((line) => line.includes('Sent to Pi')));
  await c.handle(text('s'));
  assert.equal(c.state.mode, 'review');
  assert.match(c.state.status, /No unsent/);
  assert.equal(h.attempts.length, 1);

  await c.handle(key('enter')); c.state.editor.text = 'cancel this change'; await c.handle(key('escape'));
  assert.equal(c.state.comments.length, 1);
  assert.equal(c.state.comments[0].text, 'original feedback');
  await c.handle(key('enter')); c.state.editor.text = 'corrected feedback'; await c.handle(key('save'));
  assert.equal(c.state.comments.length, 2);
  const updated = c.state.comments[1];
  assert.notEqual(updated.id, original.id);
  assert.equal(updated.threadId, original.threadId);
  assert.equal(updated.revisionNumber, 2);
  assert.equal(updated.sentAt, undefined);
  assert.deepEqual(c.state.comments[0], original);
  await c.handle(text('s')); await c.handle(key('enter'));
  assert.equal(h.attempts.length, 2);
  assert.equal(h.attempts[1].comments.length, 1);
  assert.equal(h.attempts[1].comments[0].text, 'corrected feedback');
  assert.ok(c.state.comments.every((comment) => comment.sentAt > 0));
  c.stop();
  const restored = await h.open();
  assert.equal(restored.state.comments.length, 2);
  assert.ok(restored.state.comments.every((comment) => comment.sentAt > 0));
  await restored.handle(text('s'));
  assert.equal(h.attempts.length, 2);
});

test('failed submissions keep unsent notes and retry the same immutable batch', async (t) => {
  const attempts = [];
  const { c, dir } = await harness(t, { send: async (_connection, batch) => {
    attempts.push(structuredClone(batch));
    if (attempts.length === 1) throw new Error('lost receipt');
  } });
  await add(c);
  await c.handle(text('s')); await c.handle(key('enter'));
  assert.equal(c.state.mode, 'confirm');
  assert.equal(c.state.comments[0].sentAt, undefined);
  assert.ok(JSON.parse(await readFile(path.join(dir, 'drafts.json'), 'utf8')).pending);
  await c.handle(key('escape'));
  await c.handle(key('enter'));
  assert.equal(c.state.mode, 'review');
  assert.match(c.state.status, /locked/);
  await c.handle(text('s')); await c.handle(key('enter'));
  assert.deepEqual(attempts[1], attempts[0]);
  assert.equal(c.state.comments.length, 1);
  assert.ok(c.state.comments[0].sentAt);
});

test('saved notes have edit/delete actions and cancelled edits keep their saved text', async (t) => {
  const { c } = await harness(t);
  await add(c, 'saved text');
  let rendered = c.render(100, 24);
  await click(c, rendered.hits.find((h) => h.type === 'editComment'));
  c.state.editor.text = 'changed text';
  await c.handle(key('escape'));
  assert.equal(c.state.comments[0].text, 'saved text');
  rendered = c.render(100, 24);
  await click(c, rendered.hits.find((h) => h.type === 'deleteComment'));
  assert.equal(c.state.comments.length, 0);
});

test('n/p navigate comments across files in diff order, wrap, and r refreshes without losing notes', async (t) => {
  const h = await harness(t);
  const c = h.c;
  c.state.fileIndex = 1; await add(c, 'second file');
  c.state.fileIndex = 0; await add(c, 'first file');
  c.state.selectedCommentId = undefined;
  await c.handle(text('n'));
  assert.equal(c.state.fileIndex, 0);
  assert.equal(c.state.rowIndex, 1);
  await c.handle(text('n'));
  assert.equal(c.state.fileIndex, 1);
  await c.handle(text('n'));
  assert.equal(c.state.fileIndex, 0);
  await c.handle(text('p'));
  assert.equal(c.state.fileIndex, 1);
  const reads = h.reads;
  await c.handle(text('r'));
  assert.equal(h.reads, reads + 1);
  assert.equal(c.state.comments.length, 2);
  assert.equal(c.state.status, 'Refreshed.');
});

test('outdated notes stay navigable and edit in an explicitly original-snapshot box', async (t) => {
  let changed = false;
  const { c } = await harness(t, { loadSnapshot: async () => {
    const snapshot = structuredClone(fixture);
    if (changed) { snapshot.files[0].revision = 'f'.repeat(64); snapshot.files[0].rows[1].text = 'unrelated();'; }
    return snapshot;
  } });
  await add(c); changed = true;
  await c.handle(text('r'));
  assert.equal(c.state.comments[0].outdated, true);
  await c.handle(text('n'));
  assert.equal(c.state.mode, 'comments');
  await c.handle(key('enter'));
  const rendered = c.render(100, 24);
  assert.ok(rendered.lines.some((line) => line.includes('Original snapshot: a.ts:1')));
  assert.equal(c.state.editor.anchor.quote, 'code0();');
  await c.handle(key('escape'));
  assert.equal(c.state.comments[0].quote, 'code0();');
});
