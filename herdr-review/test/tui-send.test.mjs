import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createBridge } from '../src/protocol.mjs';

const hasPty = process.platform === 'linux' && spawnSync('script', ['--version']).status === 0;

test('standalone save, confirm with mouse, and deliver through the real bridge stay responsive', { skip: !hasPty, timeout: 15_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'review-send-pty-'));
  const root = path.join(dir, 'repo');
  await mkdir(root);
  execFileSync('git', ['init', '--quiet', root]);
  await writeFile(path.join(root, 'sample.txt'), 'source\n');
  const delivered = [];
  const bridge = await createBridge({ root, sessionId: 'pty-send', isCurrent: () => true, deliver: (message) => delivered.push(message) });
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  const app = fileURLToPath(new URL('../src/tui.mjs', import.meta.url));
  // Fix the terminal dimensions so the mouse targets match the actual footer.
  // Disable Herdr hooks: this test must never touch the developer's live pane.
  const child = spawn('script', ['-q', '-e', '-c', `stty cols 100 rows 24; ${quote(process.execPath)} ${quote(app)}`, '/dev/null'], {
    cwd: root, env: { ...process.env, HERDR_ENV: '', HERDR_PLUGIN_ID: '', VFLO_REVIEW_DIR: bridge.dir },
  });
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await closed;
    await bridge.close();
    await rm(dir, { recursive: true, force: true });
  });
  let output = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  async function waitFor(message) {
    const deadline = Date.now() + 3000;
    while (!output.includes(message) && child.exitCode === null && Date.now() < deadline) await delay(10);
    assert.ok(output.includes(message), `Expected ${JSON.stringify(message)} in terminal output: ${output}`);
    output = '';
  }
  await waitFor('sample.txt');
  child.stdin.write('\r\x1b[F\r');
  await waitFor('Draft note');
  child.stdin.write('\x1b[200~Please check this line.\x1b[201~\x13');
  await waitFor('Comment saved as unsent');
  assert.equal(delivered.length, 0, 'saving alone never sends feedback');
  child.stdin.write('s');
  await waitFor('CONFIRM SEND');
  assert.equal(delivered.length, 0, 'confirmation is still required');
  child.stdin.write('\x1b[<0;5;23M\x1b[<0;5;23m');
  await waitFor('Sent 1 comments to Pi');
  assert.equal(delivered.length, 1);
  assert.ok(delivered[0].includes('Please check this line.'));
  child.stdin.write('q');
  assert.equal(await closed, 0, 'the UI still accepts keyboard input after delivery');
});
