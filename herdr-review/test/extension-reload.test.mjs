import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

test('reloading the entrypoint refreshes the native launcher instead of retaining the old split logic', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'review-extension-reload-'));
  try {
    // The entrypoint uses no TypeScript-only syntax. Load the same source as
    // ESM so this test needs no Pi installation or third-party loader. Only the
    // host toolkit binding is replaced; native dependency caching stays real.
    const source = await readFile(new URL('../src/extension.ts', import.meta.url), 'utf8');
    await writeFile(path.join(dir, 'entry.mjs'), source.replace(
      'import * as toolkit from "@earendil-works/pi-tui";', 'const toolkit = {};'));
    await writeFile(path.join(dir, 'load-launcher.mjs'), await readFile(new URL('../src/load-launcher.mjs', import.meta.url), 'utf8'));
    await writeFile(path.join(dir, 'pi-ui.mjs'), 'export function openPiReview() {}');
    const descriptions = [];
    for (const [cycle, description] of ['old tile split', 'new full-tab split'].entries()) {
      await writeFile(path.join(dir, 'index.mjs'), `export function registerReview(pi) { pi.registerCommand('review', { description: ${JSON.stringify(description)} }); }`);
      // Pi reloads the entrypoint, but Node retains unchanged native import
      // URLs. A fresh entry alone must not leave index.mjs on its old version.
      const entry = await import(`${pathToFileURL(path.join(dir, 'entry.mjs')).href}?cycle=${cycle}`);
      await entry.default({ registerCommand: (_name, spec) => descriptions.push(spec.description) });
    }
    assert.deepEqual(descriptions, ['old tile split', 'new full-tab split']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
