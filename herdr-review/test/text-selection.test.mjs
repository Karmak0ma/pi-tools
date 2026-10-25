import test from 'node:test';
import assert from 'node:assert/strict';
import { clipboardSequence, createTextSelection } from '../src/text-selection.mjs';
import { InputDecoder } from '../src/view.mjs';

function harness() {
  const copies = [], clicks = [], active = [];
  let paints = 0;
  const frame = { lines: ['header', 'title', 'files│\x1b[32malpha beta\x1b[0m    ', '     │second line    ', 'footer', 'footer', 'footer'],
    hits: [3, 4].map((y) => ({ type: 'row', x1: 7, x2: 20, y })) };
  const selection = createTextSelection({ copy: (text) => copies.push(text), click: (event) => clicks.push(event),
    onChange: () => paints++, onActive: (value) => active.push(value) });
  const decoder = new InputDecoder();
  function input(packet) { return decoder.feed(packet).map((event) => selection.handle(event, frame)); }
  return { selection, frame, copies, clicks, active, input, get paints() { return paints; } };
}

test('plain left drag highlights and copies on release without m or a row click', () => {
  const h = harness();
  assert.deepEqual(h.input('\x1b[<0;7;3M'), [true]);
  h.input('\x1b[<32;11;3M');
  assert.ok(h.selection.render().lines[2].includes('\x1b[7m'));
  assert.deepEqual(h.copies, []);
  h.input('\x1b[<0;11;3m');
  assert.deepEqual(h.copies, ['alpha']);
  assert.deepEqual(h.clicks, []);
  assert.deepEqual(h.active, [true]);
  h.selection.clear();
  assert.equal(h.active.at(-1), false);
});

test('a click still selects its row while action buttons pass through immediately', () => {
  const h = harness();
  h.input('\x1b[<0;7;3M'); h.input('\x1b[<0;7;3m');
  assert.equal(h.clicks.length, 1);
  assert.equal(h.clicks[0].x, 7);
  assert.deepEqual(h.copies, []);
  h.frame.hits.unshift({ type: 'add', x1: 18, x2: 20, y: 3 });
  assert.deepEqual(h.input('\x1b[<0;19;3M'), [false]);
});

test('reverse multiline drag stays in the diff pane and preserves Unicode without ANSI', () => {
  const h = harness();
  h.frame.lines[2] = 'files│\x1b[32m中e\u0301🙂 end\x1b[0m   ';
  h.input('\x1b[<0;12;4M');
  h.input('\x1b[<32;7;3M');
  h.input('\x1b[<0;7;3m');
  assert.deepEqual(h.copies, ['中e\u0301🙂 end\nsecond']);
  assert.ok(!h.copies[0].includes('\x1b'));
});

test('clipboard output base64-encodes Unicode and source controls instead of executing them', () => {
  const text = '中🙂\x1b]52;c;malicious\x07';
  const sequence = clipboardSequence(text);
  assert.equal(sequence, '\x1b]52;c;' + Buffer.from(text).toString('base64') + '\x07');
  assert.equal((sequence.match(/\x07/g) || []).length, 1);
});

test('a drag remains a drag if it returns to the press position; wheel clears selection', () => {
  const h = harness();
  h.input('\x1b[<0;7;3M'); h.input('\x1b[<32;12;3M'); h.input('\x1b[<0;7;3m');
  assert.deepEqual(h.clicks, []);
  assert.deepEqual(h.copies, ['a']);
  assert.deepEqual(h.input('\x1b[<65;9;3M'), [false]);
  assert.equal(h.selection.render(), undefined);
});
