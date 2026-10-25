import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalFrame } from '../src/terminal-frame.mjs';

test('full-width rows are cleared before writing, never at the last cell afterward', () => {
  const source = 'x'.repeat(77) + '[+]';
  const output = terminalFrame([source, 'y'.repeat(80)], 2);
  assert.equal(output, '\x1b[H\x1b[2K' + source + '\r\n\x1b[2K' + 'y'.repeat(80) + '\x1b[0m');
  assert.ok(!output.includes('[+]\x1b[K'));
});

test('unchanged rows are not erased or rewritten when the pointer moves', () => {
  const previous = ['header', 'green source', 'old hover'];
  assert.equal(terminalFrame(previous, 3, previous), '');
  const output = terminalFrame(['header', 'green source', 'new hover'], 3, previous);
  assert.ok(!output.includes('green source'));
  assert.ok(!output.includes('\x1b[2K'));
  assert.ok(output.includes('\x1b[3;1H'));
});

test('a shortened frame clears unused rows only after moving below its last row', () => {
  assert.equal(terminalFrame(['header'], 4), '\x1b[H\x1b[2Kheader\x1b[0m\x1b[2;1H\x1b[J');
});
