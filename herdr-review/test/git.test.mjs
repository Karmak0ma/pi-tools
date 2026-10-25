import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { readSnapshot, repositoryRoot, normalizeComparison } from '../src/git.mjs';

function testEnvironment() {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
  };
}

function git(cwd, args, input = null, extraEnvironment = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', ['--no-pager', ...args], {
      cwd,
      env: { ...testEnvironment(), ...extraEnvironment },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', rejectPromise);
    child.once('close', (code) => {
      const errorText = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) {
        rejectPromise(new Error(`git ${args.join(' ')} failed: ${errorText}`));
        return;
      }
      resolvePromise(Buffer.concat(stdout));
    });
    child.stdin.end(input ?? undefined);
  });
}

async function makeRepo(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'herdr-review-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-q']);
  await git(root, ['config', 'user.name', 'Review Test']);
  await git(root, ['config', 'user.email', 'review@example.test']);
  return root;
}

async function commit(root, message) {
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-qm', message]);
}

function fileByPath(snapshot, path) {
  const file = snapshot.files.find((candidate) => candidate.path === path);
  assert.ok(file, `expected a snapshot file for ${JSON.stringify(path)}`);
  return file;
}

test('revision pairs use merge-base or direct endpoints and exclude dirty files', async (t) => {
  const root = await makeRepo(t);
  await fs.writeFile(join(root, 'shared.txt'), 'base\n');
  await fs.writeFile(join(root, 'rename-old.txt'), 'rename content\n');
  await commit(root, 'base');
  const base = (await git(root, ['rev-parse', 'HEAD'])).toString().trim();
  await git(root, ['checkout', '-qb', 'develop']);
  await fs.writeFile(join(root, 'develop-only.txt'), 'target branch change\n');
  await commit(root, 'develop advances');
  await git(root, ['checkout', '-qb', 'feature', base]);
  await fs.writeFile(join(root, 'shared.txt'), 'committed feature\n');
  await git(root, ['mv', 'rename-old.txt', 'rename-new.txt']);
  await commit(root, 'feature change');
  const tip = (await git(root, ['rev-parse', 'HEAD'])).toString().trim();
  await fs.writeFile(join(root, 'shared.txt'), 'staged edit\n');
  await git(root, ['add', 'shared.txt']);
  await fs.writeFile(join(root, 'shared.txt'), 'unstaged edit\n');
  await fs.writeFile(join(root, 'untracked.txt'), 'not committed\n');

  const triple = await readSnapshot(root, 'develop...HEAD');
  assert.equal(triple.comparison.expression, 'develop...HEAD');
  assert.equal(triple.comparison.base, base);
  assert.equal(triple.comparison.tip, tip);
  assert.deepEqual(triple.files.map((f) => f.path), ['rename-new.txt', 'shared.txt']);
  const shared = fileByPath(triple, 'shared.txt');
  assert.equal(shared.baseCommit, base);
  assert.equal(shared.tipCommit, tip);
  assert.deepEqual(shared.rows.filter((r) => r.kind === 'add'), [{ kind: 'add', text: 'committed feature', newLine: 1 }]);
  assert.equal(fileByPath(triple, 'rename-new.txt').oldPath, 'rename-old.txt');
  const double = await readSnapshot(root, 'develop..HEAD');
  assert.equal(fileByPath(double, 'develop-only.txt').status, 'D');
  assert.notEqual(double.comparison.base, base);
  assert.deepEqual((await readSnapshot(root, 'HEAD..HEAD')).files, []);
  const dirty = await readSnapshot(root);
  assert.equal(dirty.comparison, undefined);
  assert.equal(fileByPath(dirty, 'untracked.txt').status, 'A');
  assert.ok(fileByPath(dirty, 'shared.txt').rows.some((r) => r.text === 'unstaged edit'));

  // A refresh follows named refs, but the old snapshot keeps its commit IDs.
  await commit(root, 'next feature change');
  const refreshed = await readSnapshot(root, 'develop...HEAD');
  assert.notEqual(refreshed.comparison.tip, tip);
  assert.equal(triple.comparison.tip, tip);
  assert.ok(fileByPath(refreshed, 'shared.txt').rows.some((r) => r.text === 'unstaged edit'));
});

test('invalid revision pairs fail instead of falling back to working-tree review', async (t) => {
  const root = await makeRepo(t);
  await fs.writeFile(join(root, 'file.txt'), 'base\n');
  await commit(root, 'base');
  assert.equal(normalizeComparison('  develop...HEAD  '), 'develop...HEAD');
  assert.equal(normalizeComparison(''), '');
  for (const expression of ['git diff develop...HEAD', '--stat', 'HEAD...', '...HEAD', 'HEAD .. HEAD', 'HEAD...--output=x', 'HEAD..HEAD -- file.txt']) {
    assert.throws(() => normalizeComparison(expression), /Usage/);
    await assert.rejects(readSnapshot(root, expression), /Usage/);
  }
  await assert.rejects(readSnapshot(root, 'missing...HEAD'), /Cannot resolve revision/);
  await assert.rejects(readSnapshot(root, 'HEAD...HEAD;touch-pwned'), /Cannot resolve revision/);
  assert.equal(await fs.stat(join(root, 'touch-pwned')).then(() => true, () => false), false);
});

test('maps unified hunks and combines staged and unstaged edits', async (t) => {
  const root = await makeRepo(t);
  const path = join(root, 'lines.txt');
  const original = Array.from({ length: 12 }, (_, index) => `line-${index + 1}`).join('\n') + '\n';
  await fs.writeFile(path, original);
  await commit(root, 'base');

  const lines = original.trimEnd().split('\n');
  lines[0] = 'changed-first';
  await fs.writeFile(path, `${lines.join('\n')}\n`);
  await git(root, ['add', 'lines.txt']);
  lines[10] = 'changed-eleventh';
  await fs.writeFile(path, `${lines.join('\n')}\n`);

  const file = fileByPath(await readSnapshot(root), 'lines.txt');
  assert.equal(file.status, 'M');
  assert.equal(file.oldPath, undefined);
  assert.equal(file.binary, false);
  assert.deepEqual(
    file.rows.filter((row) => row.kind === 'delete' || row.kind === 'add'),
    [
      { kind: 'delete', text: 'line-1', oldLine: 1 },
      { kind: 'add', text: 'changed-first', newLine: 1 },
      { kind: 'delete', text: 'line-11', oldLine: 11 },
      { kind: 'add', text: 'changed-eleventh', newLine: 11 },
    ],
  );
  assert.ok(file.rows.some((row) => row.kind === 'context' && row.oldLine === 2 && row.newLine === 2));
});

test('removes a staged change when the worktree is restored to HEAD', async (t) => {
  const root = await makeRepo(t);
  const path = join(root, 'cancel.txt');
  await fs.writeFile(path, 'base\n');
  await commit(root, 'base');

  await fs.writeFile(path, 'staged\n');
  await git(root, ['add', 'cancel.txt']);
  // Keep the staged index entry, but put the worktree back at HEAD. A diff
  // against HEAD must report the net worktree state, not the stale index.
  await fs.writeFile(path, 'base\n');

  const snapshot = await readSnapshot(root);
  assert.deepEqual(snapshot.files, []);
});

test('includes untracked files and excludes ignored files', async (t) => {
  const root = await makeRepo(t);
  await fs.writeFile(join(root, '.gitignore'), 'ignored.txt\n');
  await commit(root, 'ignore rules');
  await fs.writeFile(join(root, 'new file.txt'), 'new\n');
  await fs.writeFile(join(root, 'ignored.txt'), 'secret\n');

  const snapshot = await readSnapshot(root);
  assert.deepEqual(snapshot.files.map((file) => file.path), ['new file.txt']);
  const file = snapshot.files[0];
  assert.equal(file.status, 'A');
  assert.equal(file.added, 1);
  assert.equal(file.deleted, 0);
  assert.deepEqual(file.rows.filter((row) => row.kind === 'add'), [
    { kind: 'add', text: 'new', newLine: 1 },
  ]);
});

test('does not execute configured clean or process filters', async (t) => {
  const root = await makeRepo(t);
  const sentinelDirectory = await fs.mkdtemp(join(tmpdir(), 'herdr-review-filter-test-'));
  t.after(() => fs.rm(sentinelDirectory, { recursive: true, force: true }));
  const sentinel = join(sentinelDirectory, 'sentinel.sh');
  const marker = `${sentinel}.ran`;
  await fs.writeFile(
    sentinel,
    '#!/bin/sh\nprintf ran >> "$0.ran"\ncat\n',
  );
  await fs.chmod(sentinel, 0o755);

  await fs.writeFile(join(root, '.gitattributes'), '* filter=sentinel\n');
  await fs.writeFile(join(root, 'filtered.txt'), 'base\n');
  await commit(root, 'filter attributes');

  await git(root, ['config', 'filter.sentinel.clean', sentinel]);
  await git(root, ['config', 'filter.sentinel.process', sentinel]);
  await git(root, ['config', 'filter.sentinel.required', 'true']);
  // This filter name exercises config-key injection when a subsection has
  // spaces and dots, even though the attributes above do not select it.
  await git(root, ['config', 'filter.we ird.x.clean', sentinel]);
  await git(root, ['config', 'filter.we ird.x.process', sentinel]);
  await git(root, ['config', 'filter.we ird.x.required', 'true']);

  await fs.writeFile(join(root, 'filtered.txt'), 'changed\n');
  await fs.writeFile(join(root, 'untracked.txt'), 'untracked\n');
  const snapshot = await readSnapshot(root);
  assert.deepEqual(snapshot.files.map((file) => file.path), ['filtered.txt', 'untracked.txt']);
  await assert.rejects(git(root, ['diff', '--no-color']));
  assert.equal(await fs.stat(marker).then(() => true, () => false), true);
});

test('detects staged and working-tree renames, deletion, and binary changes', async (t) => {
  const root = await makeRepo(t);
  await fs.writeFile(join(root, 'staged-old.txt'), 'staged rename\n');
  await fs.writeFile(join(root, 'working-old.txt'), 'working rename\n');
  await fs.writeFile(join(root, 'deleted.txt'), 'delete me\n');
  await fs.writeFile(join(root, 'data.bin'), Buffer.from([0, 1, 2, 3]));
  await commit(root, 'base');

  await git(root, ['mv', 'staged-old.txt', 'staged-new.txt']);
  await fs.rename(join(root, 'working-old.txt'), join(root, 'working\tnew.txt'));
  await fs.rm(join(root, 'deleted.txt'));
  await fs.writeFile(join(root, 'data.bin'), Buffer.from([0, 1, 2, 4]));

  const snapshot = await readSnapshot(root);
  const stagedRename = fileByPath(snapshot, 'staged-new.txt');
  assert.equal(stagedRename.status, 'R');
  assert.equal(stagedRename.oldPath, 'staged-old.txt');
  const workingRename = fileByPath(snapshot, 'working\tnew.txt');
  assert.equal(workingRename.status, 'R');
  assert.equal(workingRename.oldPath, 'working-old.txt');
  assert.equal(fileByPath(snapshot, 'deleted.txt').status, 'D');
  const binary = fileByPath(snapshot, 'data.bin');
  assert.equal(binary.status, 'M');
  assert.equal(binary.binary, true);
  assert.equal(binary.added, 0);
  assert.equal(binary.deleted, 0);
  assert.equal(binary.rows.some((row) => row.kind === 'hunk'), false);
});

test('reads an unborn repository from the empty tree', async (t) => {
  const root = await makeRepo(t);
  await fs.writeFile(join(root, 'staged.txt'), 'staged\n');
  await git(root, ['add', 'staged.txt']);
  await fs.writeFile(join(root, 'untracked.txt'), 'untracked\n');

  const snapshot = await readSnapshot(root);
  assert.equal(snapshot.head, '');
  assert.deepEqual(snapshot.files.map((file) => file.path), ['staged.txt', 'untracked.txt']);
  assert.deepEqual(snapshot.files.map((file) => file.status), ['A', 'A']);
});

test('preserves odd pathnames and finds the worktree root from nested cwd', async (t) => {
  const root = await makeRepo(t);
  const names = ['space name.txt', 'line\nname.txt', 'tab\tname.txt', 'é.txt', '-dash.txt', ':colon.txt'];
  for (const name of names) await fs.writeFile(join(root, name), `old ${name}\n`);
  await commit(root, 'odd names');
  for (const name of names) await fs.writeFile(join(root, name), `new ${name}\n`);

  const nested = join(root, 'nested', 'directory');
  await fs.mkdir(nested, { recursive: true });
  assert.equal(await repositoryRoot(nested), resolve(root));
  const snapshot = await readSnapshot(nested);
  assert.deepEqual(
    snapshot.files.map((file) => file.path),
    [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  );
});

test('supports linked worktrees', async (t) => {
  const root = await makeRepo(t);
  await fs.writeFile(join(root, 'worktree.txt'), 'base\n');
  await commit(root, 'base');

  const worktreeParent = await fs.mkdtemp(join(tmpdir(), 'herdr-review-worktree-parent-'));
  const worktree = join(worktreeParent, 'linked');
  t.after(async () => {
    await git(root, ['worktree', 'remove', '--force', worktree]).catch(() => {});
    await fs.rm(worktreeParent, { recursive: true, force: true });
  });
  await git(root, ['worktree', 'add', '-q', '-b', 'review-linked', worktree]);
  await fs.writeFile(join(worktree, 'worktree.txt'), 'changed\n');

  const snapshot = await readSnapshot(worktree);
  assert.equal(snapshot.root, resolve(worktree));
  assert.equal(fileByPath(snapshot, 'worktree.txt').status, 'M');
});

test('copying the index preserves detection of same-stat edits that Git considers racy', async (t) => {
  const root = await makeRepo(t);
  const file = join(root, 'same-size.txt');
  const time = new Date('2020-01-01T00:00:00.000Z');
  await fs.writeFile(file, 'old\n');
  await fs.utimes(file, time, time);
  await commit(root, 'base');
  // An entry at the index timestamp is racy: Git must compare its blob even
  // when file size and cached stat fields match. A fresh copied-index mtime
  // incorrectly makes the same entry appear safely older than the index.
  const index = join(root, '.git', 'index');
  await fs.utimes(index, time, time);
  await fs.writeFile(file, 'new\n');
  await fs.utimes(file, time, time);
  await git(root, ['config', 'core.trustctime', 'false']);
  const snapshot = await readSnapshot(root);
  assert.ok(fileByPath(snapshot, 'same-size.txt').rows.some((row) => row.kind === 'add' && row.text === 'new'));
});

test('does not write the real index or objects and keeps revisions stable', async (t) => {
  const root = await makeRepo(t);
  await fs.writeFile(join(root, 'tracked.txt'), 'one\n');
  await commit(root, 'base');
  await fs.writeFile(join(root, 'untracked.txt'), 'two\n');
  await fs.writeFile(join(root, 'tracked.txt'), 'changed\n');

  const indexPath = (await git(root, ['rev-parse', '--git-path', 'index'])).toString('utf8').trimEnd();
  const absoluteIndex = indexPath.startsWith('/') ? indexPath : resolve(root, indexPath);
  const beforeIndex = await fs.readFile(absoluteIndex);
  const beforeStat = await fs.stat(absoluteIndex, { bigint: true });
  const beforeObjects = await git(root, ['count-objects', '-v']);

  const first = await readSnapshot(root);
  const second = await readSnapshot(root);
  assert.deepEqual(second, first);
  assert.deepEqual(await fs.readFile(absoluteIndex), beforeIndex);
  assert.equal((await fs.stat(absoluteIndex, { bigint: true })).mtimeNs, beforeStat.mtimeNs);
  assert.deepEqual(await git(root, ['count-objects', '-v']), beforeObjects);

  const tracked = fileByPath(first, 'tracked.txt');
  const untracked = fileByPath(first, 'untracked.txt');
  assert.notEqual(tracked.revision, untracked.revision);
  assert.match(first.revision, /^[0-9a-f]{64}$/);
});
