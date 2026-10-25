import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

// Git output is kept in memory so the snapshot can be consistent. The cap is
// deliberately finite: a review client must fail rather than let one giant
// diff exhaust the process.
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const GIT_TIMEOUT_MS = 15_000;
const DIFF_PREFIX = Buffer.from('diff --git ');

// These options are applied to every Git subprocess. Disabling fsmonitor and
// external diff configuration prevents repository hooks or configured tools
// from running during what must be a read-only snapshot operation.
const GIT_OPTIONS = [
  '--no-pager',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.quotePath=false',
  '-c',
  'diff.external=',
  '-c',
  'diff.noprefix=false',
  '-c',
  'diff.mnemonicPrefix=false',
  '-c',
  'color.ui=false',
  '-c',
  'diff.submodule=short',
  '-c',
  'diff.suppressBlankEmpty=false',
  '-c',
  'diff.renames=true',
];

function gitEnvironment(overrides = {}) {
  const environment = { ...process.env };

  // Do not let inherited repository-selection variables redirect this snapshot
  // away from the requested worktree or its disposable index/object store.
  for (const variable of Object.keys(environment)) {
    if (
      variable === 'GIT_DIR' ||
      variable === 'GIT_WORK_TREE' ||
      variable === 'GIT_INDEX_FILE' ||
      variable === 'GIT_OBJECT_DIRECTORY' ||
      variable === 'GIT_COMMON_DIR' ||
      variable === 'GIT_CONFIG_PARAMETERS' ||
      variable === 'GIT_CONFIG_COUNT' ||
      variable.startsWith('GIT_CONFIG_KEY_') ||
      variable.startsWith('GIT_CONFIG_VALUE_')
    ) {
      // Do not let inherited repository-selection or config-injection variables
      // redirect the snapshot or re-enable filters after our overrides.
      delete environment[variable];
    }
  }

  Object.assign(environment, {
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_LITERAL_PATHSPECS: '1',
    ...overrides,
  });

  // External diff commands are disabled by command-line options too. Removing
  // this variable closes the environment escape hatch for every Git command.
  delete environment.GIT_EXTERNAL_DIFF;
  return environment;
}

function stripOneTrailingNewline(value) {
  return value.endsWith('\n') ? value.slice(0, -1) : value;
}

function gitError(message, { exitCode, stderr } = {}) {
  const error = new Error(message);
  if (exitCode !== undefined) error.exitCode = exitCode;
  if (stderr !== undefined) error.stderr = stderr;
  return error;
}

/**
 * Run Git without a shell. This is important because repository paths and
 * pathspecs are user-controlled data, and shell quoting would be both unsafe
 * and unable to represent every valid Git path.
 */
function runGit(args, { cwd, env = {}, input = null, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawn('git', [...GIT_OPTIONS, ...args], {
        cwd,
        env: gitEnvironment(env),
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      rejectPromise(error);
      return;
    }

    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timer;

    const stop = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // SIGKILL prevents a timed-out Git process or an output-flooding child
      // from surviving the failed request and continuing to read the pipe.
      child.kill('SIGKILL');
      rejectPromise(error);
    };

    const collect = (chunks, chunk, streamName) => {
      if (settled) return;
      if (streamName === 'stdout') {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_OUTPUT_BYTES) {
          stop(gitError(`git ${args[0]} output exceeded ${MAX_OUTPUT_BYTES} bytes`));
          return;
        }
      } else {
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_OUTPUT_BYTES) {
          stop(gitError(`git ${args[0]} error output exceeded ${MAX_OUTPUT_BYTES} bytes`));
          return;
        }
      }
      chunks.push(chunk);
    };

    child.stdout.on('data', (chunk) => collect(stdout, chunk, 'stdout'));
    child.stderr.on('data', (chunk) => collect(stderr, chunk, 'stderr'));
    child.once('error', (error) => stop(error));
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const errorOutput = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) {
        rejectPromise(
          gitError(
            `git ${args.join(' ')} failed${signal ? ` (${signal})` : ''}${
              errorOutput ? `: ${errorOutput.trim()}` : ''
            }`,
            { exitCode: code, stderr: errorOutput },
          ),
        );
        return;
      }
      resolvePromise(Buffer.concat(stdout));
    });

    timer = setTimeout(() => {
      stop(gitError(`git ${args[0]} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    timer.unref?.();

    child.stdin.once('error', (error) => {
      // EPIPE means Git exited before consuming input. The close event will
      // report the useful command failure, so only stop other stdin errors.
      if (error.code !== 'EPIPE') stop(error);
    });
    child.stdin.end(input ?? undefined);
  });
}

async function gitText(args, options) {
  return (await runGit(args, options)).toString('utf8');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function splitNul(buffer) {
  const fields = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    fields.push(buffer.subarray(start, index));
    start = index + 1;
  }
  if (start < buffer.length) fields.push(buffer.subarray(start));
  return fields;
}

function readNulField(buffer, offset, description) {
  const end = buffer.indexOf(0, offset);
  if (end === -1) throw new Error(`Malformed git ${description} field`);
  return { value: buffer.subarray(offset, end), next: end + 1 };
}

function parseRawHeader(buffer) {
  const header = buffer.toString('utf8');
  if (!header.startsWith(':')) throw new Error('Malformed git raw diff header');
  const fields = header.slice(1).split(' ');
  if (fields.length !== 5 || !fields[4]) {
    throw new Error(`Malformed git raw diff header: ${header}`);
  }
  const statusField = fields[4];
  return {
    status: statusField[0],
    renameOrCopy: statusField[0] === 'R' || statusField[0] === 'C',
  };
}

function parseDiffMetadata(buffer) {
  let cursor = 0;
  const rawRecords = [];

  // --raw records always start with a colon. This lets us find the boundary
  // between the raw section and the following --numstat section without
  // relying on path contents or quoting rules.
  while (cursor < buffer.length && buffer[cursor] === 0x3a) {
    const headerField = readNulField(buffer, cursor, 'raw diff header');
    const header = parseRawHeader(headerField.value);
    cursor = headerField.next;

    const firstPathField = readNulField(buffer, cursor, 'raw diff path');
    cursor = firstPathField.next;
    let secondPath;
    if (header.renameOrCopy) {
      const secondPathField = readNulField(buffer, cursor, 'raw rename path');
      cursor = secondPathField.next;
      secondPath = secondPathField.value.toString('utf8');
    }
    rawRecords.push({
      ...header,
      firstPath: firstPathField.value.toString('utf8'),
      secondPath,
    });
  }

  if (rawRecords.length === 0) {
    if (buffer.length !== 0) throw new Error('Malformed git diff output without raw records');
    return { records: [], patchOffset: 0 };
  }

  const records = [];
  for (const raw of rawRecords) {
    const statsField = readNulField(buffer, cursor, 'numstat');
    cursor = statsField.next;
    const firstTab = statsField.value.indexOf(0x09);
    const secondTab = firstTab === -1 ? -1 : statsField.value.indexOf(0x09, firstTab + 1);
    if (firstTab === -1 || secondTab === -1) {
      throw new Error(`Malformed git numstat record: ${statsField.value.toString('utf8')}`);
    }

    const addedText = statsField.value.subarray(0, firstTab).toString('utf8');
    const deletedText = statsField.value.subarray(firstTab + 1, secondTab).toString('utf8');
    const binary = addedText === '-' || deletedText === '-';
    const added = binary ? 0 : Number.parseInt(addedText, 10);
    const deleted = binary ? 0 : Number.parseInt(deletedText, 10);
    if (!binary && (!Number.isSafeInteger(added) || !Number.isSafeInteger(deleted))) {
      throw new Error(`Malformed git numstat counts: ${statsField.value.toString('utf8')}`);
    }

    // With -z, a normal path stays in the third tab-separated field, so only
    // the first two tabs are delimiters. Rename paths follow an empty field as
    // separate NUL fields. Raw paths remain the source of truth for names.
    if (raw.renameOrCopy) {
      if (statsField.value.subarray(secondTab + 1).length !== 0) {
        throw new Error('Malformed git rename numstat separator');
      }
      const oldPath = readNulField(buffer, cursor, 'rename numstat old path');
      cursor = oldPath.next;
      const newPath = readNulField(buffer, cursor, 'rename numstat new path');
      cursor = newPath.next;
      if (!oldPath.value.equals(Buffer.from(raw.firstPath)) || !newPath.value.equals(Buffer.from(raw.secondPath))) {
        throw new Error('Mismatched git rename numstat paths');
      }
    }

    records.push({
      path: raw.renameOrCopy ? raw.secondPath : raw.firstPath,
      oldPath: raw.renameOrCopy ? raw.firstPath : undefined,
      status: raw.status,
      added,
      deleted,
      binary,
    });
  }

  // `-z` places one empty NUL field between the metadata records and the
  // ordinary unified patch. Keeping the offset instead of splitting the whole
  // buffer prevents tabs/newlines/NUL framing from being confused with paths.
  const separator = readNulField(buffer, cursor, 'metadata/patch separator');
  if (separator.value.length !== 0) {
    throw new Error('Missing git metadata/patch separator');
  }
  return { records, patchOffset: separator.next };
}

function patchChunks(buffer) {
  const starts = [];
  let lineStart = 0;
  while (lineStart < buffer.length) {
    if (
      (lineStart === 0 || buffer[lineStart - 1] === 0x0a) &&
      buffer.subarray(lineStart, lineStart + DIFF_PREFIX.length).equals(DIFF_PREFIX)
    ) {
      starts.push(lineStart);
    }
    const newline = buffer.indexOf(0x0a, lineStart);
    if (newline === -1) break;
    lineStart = newline + 1;
  }

  return starts.map((start, index) => {
    const end = index + 1 < starts.length ? starts[index + 1] : buffer.length;
    return buffer.subarray(start, end);
  });
}

function hunkHeader(line) {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!match) return null;
  return {
    oldLine: Number.parseInt(match[1], 10),
    oldRemaining: match[2] === undefined ? 1 : Number.parseInt(match[2], 10),
    newLine: Number.parseInt(match[3], 10),
    newRemaining: match[4] === undefined ? 1 : Number.parseInt(match[4], 10),
  };
}

function patchRows(patch) {
  const lines = patch.toString('utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const rows = [];
  let hunk = null;

  for (const line of lines) {
    const parsedHeader = hunkHeader(line);
    if (parsedHeader) {
      if (hunk && (hunk.oldRemaining !== 0 || hunk.newRemaining !== 0)) {
        throw new Error(`Malformed git hunk range: ${line}`);
      }
      hunk = parsedHeader;
      rows.push({ kind: 'hunk', text: line });
      continue;
    }

    if (!hunk) {
      rows.push({ kind: 'meta', text: line });
      continue;
    }

    // A no-newline marker is metadata. A line whose side has no remaining
    // range is also metadata; this avoids treating a malformed or unusual
    // trailer as commentable file content.
    if (line.startsWith('\\')) {
      rows.push({ kind: 'meta', text: line });
      continue;
    }
    if (line.startsWith(' ') && hunk.oldRemaining > 0 && hunk.newRemaining > 0) {
      rows.push({ kind: 'context', text: line.slice(1), oldLine: hunk.oldLine, newLine: hunk.newLine });
      hunk.oldLine += 1;
      hunk.newLine += 1;
      hunk.oldRemaining -= 1;
      hunk.newRemaining -= 1;
      continue;
    }
    if (line.startsWith('-') && hunk.oldRemaining > 0) {
      rows.push({ kind: 'delete', text: line.slice(1), oldLine: hunk.oldLine });
      hunk.oldLine += 1;
      hunk.oldRemaining -= 1;
      continue;
    }
    if (line.startsWith('+') && hunk.newRemaining > 0) {
      rows.push({ kind: 'add', text: line.slice(1), newLine: hunk.newLine });
      hunk.newLine += 1;
      hunk.newRemaining -= 1;
      continue;
    }
    rows.push({ kind: 'meta', text: line });
  }

  if (hunk && (hunk.oldRemaining !== 0 || hunk.newRemaining !== 0)) {
    throw new Error('Malformed git hunk range: range was not consumed');
  }
  return rows;
}

async function filterEnvironment(root) {
  let output;
  try {
    output = await runGit(['config', '--null', '--name-only', '--get-regexp', '^filter\\.'], {
      cwd: root,
    });
  } catch (error) {
    // `git config --get-regexp` uses exit code 1 when no key matches.
    if (error.exitCode === 1) return {};
    throw error;
  }

  const names = new Set();
  for (const field of splitNul(output)) {
    const key = field.toString('utf8');
    const prefix = 'filter.';
    const lastDot = key.lastIndexOf('.');
    if (!key.startsWith(prefix) || lastDot <= prefix.length) continue;
    names.add(key.slice(prefix.length, lastDot));
  }

  const sortedNames = [...names].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const environment = { GIT_CONFIG_COUNT: String(sortedNames.length * 4) };
  let index = 0;
  for (const name of sortedNames) {
    for (const setting of ['clean', 'process', 'smudge', 'required']) {
      environment[`GIT_CONFIG_KEY_${index}`] = `filter.${name}.${setting}`;
      environment[`GIT_CONFIG_VALUE_${index}`] = setting === 'required' ? 'false' : '';
      index += 1;
    }
  }
  return environment;
}

async function repositoryGitPath(root, env, gitPath = 'index') {
  const output = stripOneTrailingNewline(
    await gitText(['rev-parse', '--git-path', gitPath], { cwd: root, env }),
  );
  return isAbsolute(output) ? output : resolve(root, output);
}

async function withTemporaryIndex(root, callback) {
  const tempDirectory = await fs.mkdtemp(join(tmpdir(), 'herdr-review-index-'));
  const temporaryIndex = join(tempDirectory, 'index');
  const temporaryObjects = join(tempDirectory, 'objects');
  const baseEnvironment = {};

  try {
    const realIndex = await repositoryGitPath(root, baseEnvironment);
    const realObjects = await repositoryGitPath(root, baseEnvironment, 'objects');
    try {
      const indexStat = await fs.stat(realIndex);
      await fs.copyFile(realIndex, temporaryIndex);
      // Git hashes same-stat entries when their timestamp is at or after the
      // index timestamp (its racy-file safeguard). A copy's fresh mtime would
      // disable that safeguard and can hide same-size edits. Date precision
      // may round this down, which only causes extra safe content checks.
      await fs.utimes(temporaryIndex, indexStat.atime, indexStat.mtime);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // An unborn repository may have no index yet. Git will create only the
      // temporary index when intent-to-add is used below.
    }
    await fs.mkdir(temporaryObjects);

    // `git add -N` may materialize a worktree blob even though it does not
    // stage that blob. Redirecting object writes to the disposable directory
    // preserves the no-repository-writes guarantee while the real object store
    // remains available as a read-only alternate.
    const inheritedAlternates = process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
    const alternates = [realObjects, inheritedAlternates].filter(Boolean).join(delimiter);
    return await callback({
      ...baseEnvironment,
      GIT_INDEX_FILE: temporaryIndex,
      GIT_OBJECT_DIRECTORY: temporaryObjects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: alternates,
    });
  } finally {
    // The temporary index and object store can contain intent-to-add metadata,
    // but deleting their directory guarantees that no temporary lock or object
    // remains after the snapshot.
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
}

async function addUntrackedToTemporaryIndex(root, env) {
  const output = await runGit(['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    env,
  });
  const paths = splitNul(output).filter(
    (path) => path.length > 0 && path[path.length - 1] !== 0x2f,
  );
  if (paths.length === 0) return;

  // Feeding NUL-separated pathspecs through stdin avoids argv limits and
  // preserves spaces, newlines, leading dashes, and other path characters.
  await runGit(['add', '-N', '--pathspec-from-file=-', '--pathspec-file-nul'], {
    cwd: root,
    env,
    input: Buffer.concat(paths.map((path) => Buffer.concat([path, Buffer.from([0])]))),
  });
}

async function headRevision(root) {
  try {
    return stripOneTrailingNewline(
      await gitText(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { cwd: root }),
    );
  } catch (error) {
    // A valid repository with an unborn branch is the only expected failure.
    // repositoryRoot has already established that this is a Git worktree.
    if (error.exitCode !== undefined) return '';
    throw error;
  }
}

async function emptyTreeRevision(root) {
  // Do not hardcode the SHA-1 empty-tree object: hash-object also gives the
  // correct empty tree identifier in SHA-256 repositories, without -w and
  // therefore without writing an object.
  return stripOneTrailingNewline(
    await gitText(['hash-object', '-t', 'tree', '--stdin'], {
      cwd: root,
      input: Buffer.alloc(0),
    }),
  );
}

function aggregateRevision(head, files) {
  const hash = createHash('sha256');
  hash.update('head\0');
  hash.update(head);
  hash.update('\0');
  for (const file of files) {
    hash.update(file.status);
    hash.update('\0');
    hash.update(file.oldPath ?? '');
    hash.update('\0');
    hash.update(file.path);
    hash.update('\0');
    hash.update(file.revision);
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * Return the worktree root reported by Git. Only Git's terminating newline is
 * removed; trim() is intentionally avoided because spaces are valid path data.
 */
export async function repositoryRoot(cwd) {
  return stripOneTrailingNewline(
    await gitText(['rev-parse', '--show-toplevel'], { cwd: resolve(cwd) }),
  );
}

/** Accept a revision pair, never a shell command or arbitrary Git options. */
export function normalizeComparison(input = '') {
  if (typeof input !== 'string') throw new Error('Usage: /review [base...tip | base..tip]');
  const expression = input.trim();
  if (!expression) return '';
  const parts = /^(.+?)(\.{2,3})(.+)$/.exec(expression);
  if (expression.length > 4096 || /[\s\x00-\x1f\x7f]/.test(expression) || !parts ||
      /^[.-]/.test(parts[1]) || /^[.-]/.test(parts[3]) ||
      parts[1].includes('..') || parts[3].includes('..')) {
    throw new Error('Usage: /review [base...tip | base..tip]. Pass one revision pair, not a shell command or Git flags.');
  }
  return expression;
}

/**
 * Resolve endpoints to commit IDs before diffing. This excludes dirty files,
 * avoids option/path ambiguity, and pins each read even if a branch moves.
 * Re-resolve on refresh so new commits appear without reopening the pane.
 */
export async function resolveComparison(root, input) {
  const expression = normalizeComparison(input);
  if (!expression) return undefined;
  const [, left, operator, right] = /^(.+?)(\.{2,3})(.+)$/.exec(expression);
  async function commit(revision) {
    try {
      return stripOneTrailingNewline(await gitText(
        ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`], { cwd: root },
      ));
    } catch {
      throw new Error(`Cannot resolve revision ${JSON.stringify(revision)} to a commit.`);
    }
  }
  const leftCommit = await commit(left);
  const tip = await commit(right);
  let base = leftCommit;
  if (operator === '...') {
    let bases;
    try {
      bases = (await gitText(['merge-base', '--all', leftCommit, tip], { cwd: root })).trim().split('\n');
    } catch {
      throw new Error(`No merge base for ${expression}. Use base..tip to compare unrelated histories directly.`);
    }
    // Picking one of several merge bases would silently choose a review scope.
    if (bases.length !== 1) throw new Error('Multiple merge bases found. Use an explicit base..tip comparison.');
    [base] = bases;
  }
  return { expression, base, tip };
}

async function diffSnapshot(repository, revisions, env, head, comparison) {
  // One Git process pairs metadata and patches in both modes. Commit mode
  // passes only resolved IDs; working-tree mode keeps its private index.
  const diffOutput = await runGit([
    'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-relative',
    '--ignore-submodules=none', '--submodule=short', '-M', '--no-abbrev',
    '--full-index', '--src-prefix=a/', '--dst-prefix=b/',
    '--raw', '--numstat', '--patch', '-z', ...revisions, '--',
  ], { cwd: repository, env });
  const { records: metadata, patchOffset } = parseDiffMetadata(diffOutput);
  const chunks = patchChunks(diffOutput.subarray(patchOffset));
  if (metadata.length !== chunks.length) {
    throw new Error(`Git diff metadata/patch count mismatch (${metadata.length} metadata, ${chunks.length} patches)`);
  }
  const files = metadata.map((file, index) => ({
    ...file,
    revision: sha256(chunks[index]),
    rows: patchRows(chunks[index]),
    // Carry the exact reviewed commits into line comments; named refs may move
    // before the agent reads the feedback or before another refresh occurs.
    ...(comparison ? { baseCommit: comparison.base, tipCommit: comparison.tip } : {}),
  })).sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return {
    root: repository, head,
    ...(comparison ? { comparison } : {}),
    revision: aggregateRevision(head, files), files,
  };
}

/** No arguments reviews the worktree; a revision pair reviews committed trees. */
export async function readSnapshot(root, input = '') {
  const expression = normalizeComparison(input);
  const repository = await repositoryRoot(root);
  const filters = await filterEnvironment(repository);
  if (expression) {
    const comparison = await resolveComparison(repository, expression);
    // No index copy or add -N here: staged, unstaged and untracked edits have
    // no part in a two-commit comparison, even if the index has conflicts.
    return diffSnapshot(repository, [comparison.base, comparison.tip], filters, comparison.tip, comparison);
  }
  const head = await headRevision(repository);
  const base = head || (await emptyTreeRevision(repository));
  return withTemporaryIndex(repository, async (env) => {
    const snapshotEnvironment = { ...env, ...filters };
    await addUntrackedToTemporaryIndex(repository, snapshotEnvironment);
    return diffSnapshot(repository, [base], snapshotEnvironment, head);
  });
}
