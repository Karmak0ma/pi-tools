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
];

function gitEnvironment(overrides = {}) {
  const environment = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_LITERAL_PATHSPECS: '1',
    ...overrides,
  };

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
  const fields = splitNul(buffer);
  const rawRecords = [];
  let index = 0;

  // --raw records always start with a colon. This lets us find the boundary
  // between the raw section and the following --numstat section without
  // relying on path contents or quoting rules.
  while (index < fields.length && fields[index][0] === 0x3a) {
    const header = parseRawHeader(fields[index]);
    index += 1;
    if (index >= fields.length) throw new Error('Malformed git raw diff path');
    const firstPath = fields[index].toString('utf8');
    index += 1;
    let secondPath;
    if (header.renameOrCopy) {
      if (index >= fields.length) throw new Error('Malformed git raw rename path');
      secondPath = fields[index].toString('utf8');
      index += 1;
    }
    rawRecords.push({ ...header, firstPath, secondPath });
  }

  const records = [];
  for (const raw of rawRecords) {
    if (index >= fields.length) throw new Error('Missing git numstat record');
    const stats = fields[index].toString('utf8');
    index += 1;
    const statFields = stats.split('\t');
    if (statFields.length !== 3) throw new Error(`Malformed git numstat record: ${stats}`);

    const binary = statFields[0] === '-' || statFields[1] === '-';
    const added = binary ? 0 : Number.parseInt(statFields[0], 10);
    const deleted = binary ? 0 : Number.parseInt(statFields[1], 10);
    if (!binary && (!Number.isSafeInteger(added) || !Number.isSafeInteger(deleted))) {
      throw new Error(`Malformed git numstat counts: ${stats}`);
    }

    // With -z, Git includes a normal path in the third tab-separated
    // numstat field. For renames/copies that field is empty, followed by old
    // and new paths as separate NUL fields. The raw records above remain the
    // source of truth for names because they are already unquoted byte fields.
    if (raw.renameOrCopy) {
      if (statFields[2] !== '') throw new Error('Malformed git rename numstat separator');
      if (index + 1 >= fields.length) throw new Error('Malformed git rename numstat paths');
      index += 2;
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

  if (index !== fields.length) throw new Error('Unexpected fields after git numstat records');
  return records;
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
      await fs.copyFile(realIndex, temporaryIndex);
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

/**
 * Read a deterministic HEAD-to-working-tree snapshot without changing the
 * caller's index. Untracked files are represented in a throwaway index with
 * intent-to-add, so staged and unstaged changes are naturally combined by one
 * ordinary Git diff.
 */
export async function readSnapshot(root) {
  const repository = await repositoryRoot(root);
  const head = await headRevision(repository);
  const base = head || (await emptyTreeRevision(repository));

  return withTemporaryIndex(repository, async (env) => {
    await addUntrackedToTemporaryIndex(repository, env);

    const metadataOutput = await runGit(
      [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--ignore-submodules=none',
        '-M',
        '--raw',
        '--numstat',
        '-z',
        base,
      ],
      { cwd: repository, env },
    );
    const patchOutput = await runGit(
      [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--ignore-submodules=none',
        '-M',
        '--patch',
        '--full-index',
        base,
      ],
      { cwd: repository, env },
    );

    const metadata = parseDiffMetadata(metadataOutput);
    const chunks = patchChunks(patchOutput);
    if (metadata.length !== chunks.length) {
      throw new Error(
        `Git diff metadata/patch count mismatch (${metadata.length} metadata, ${chunks.length} patches)`,
      );
    }

    const files = metadata
      .map((file, index) => ({
        ...file,
        revision: sha256(chunks[index]),
        rows: patchRows(chunks[index]),
      }))
      .sort((left, right) => left.path.localeCompare(right.path));

    return {
      root: repository,
      head,
      revision: aggregateRevision(head, files),
      files,
    };
  });
}
