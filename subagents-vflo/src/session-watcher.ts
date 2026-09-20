/**
 * Incremental scanner for a child pi session directory.
 *
 * When a subagent runs as an interactive pi session inside a Herdr pane there
 * is no RPC channel to observe. The authoritative observation surface is the
 * session JSONL the child writes: pi appends one entry per message_end, so
 * assistant messages (with their stopReason, usage and content) appear here
 * as the child works.
 *
 * The watcher deliberately knows nothing about Herdr or task completion. It
 * only scans files and reports assistant messages; lifecycle decisions live
 * in the Herdr backend. Polling (instead of fs.watch) was chosen because the
 * child may create its session file flat in the directory or nested under a
 * working-directory subdirectory, and torn trailing lines must be carried
 * across reads — a byte-offset scanner handles both without event edge cases.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const SUBAGENT_SESSION_DIR_PREFIX = "pi-subagent-";

export interface SessionWatcherOptions {
  /** Directory passed to the child via --session-dir. Its owned tree is scanned recursively. */
  sessionDir: string;
  /** Called for every assistant message entry observed since the last poll. */
  onAssistantMessage: (message: any) => void;
}

interface TrackedFile {
  /** Byte offset of the consumed prefix (complete lines only). */
  offset: number;
  /** Unconsumed trailing bytes that do not yet end with a newline. */
  carry: Buffer;
}

/**
 * Find one child's session files without crossing into a descendant child.
 *
 * Pi can place the watched child's JSONL below a working-directory-derived
 * folder, so this cannot be a shallow scan. Nested `pi-subagent-*` roots are
 * separate result channels and must be pruned before their messages can enter
 * the direct child's usage, events, or lifecycle state.
 */
async function discoverSessionFiles(sessionDir: string): Promise<string[]> {
  const directories = [sessionDir];
  const sessionFiles: string[] = [];

  for (let index = 0; index < directories.length; index++) {
    const directory = directories[index];
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch {
      // Retry unreadable directories on the next poll without suppressing
      // files from the rest of this child's readable session tree.
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(SUBAGENT_SESSION_DIR_PREFIX)) directories.push(entryPath);
      } else if (entry.name.endsWith(".jsonl")) {
        sessionFiles.push(entryPath);
      }
    }
  }

  return sessionFiles;
}

export class SessionWatcher {
  private readonly offsets = new Map<string, TrackedFile>();
  private readonly onAssistantMessage: (message: any) => void;
  private readonly sessionDir: string;
  private polling = false;

  constructor(options: SessionWatcherOptions) {
    this.sessionDir = options.sessionDir;
    this.onAssistantMessage = options.onAssistantMessage;
  }

  /**
   * Scan the session directory once: discover every owned *.jsonl file,
   * read the bytes appended since the previous poll, and emit assistant
   * messages. Descendant subagent roots are separate ownership domains.
   * Idempotent and safe to call repeatedly; concurrent invocations collapse.
   */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const filePath of await discoverSessionFiles(this.sessionDir)) {
        await this.readAppended(filePath);
      }
    } finally {
      this.polling = false;
    }
  }

  /**
   * Read everything appended to one file since the last poll.
   *
   * pi publishes session entries atomically, but a reader can still observe a
   * partially flushed tail while the file is mid-append. The offset tracks how
   * many bytes have been read into memory, and `carry` holds a trailing
   * fragment that does not yet end with a newline; the next poll prefixes it
   * to the newly appended bytes so no line is parsed twice or torn in half.
   */
  private async readAppended(filePath: string): Promise<void> {
    let size: number;
    try {
      size = (await fs.promises.stat(filePath)).size;
    } catch {
      return;
    }

    const tracked = this.offsets.get(filePath) ?? { offset: 0, carry: Buffer.alloc(0) };
    if (size <= tracked.offset) {
      this.offsets.set(filePath, tracked);
      return;
    }

    const handle = await fs.promises.open(filePath, "r");
    try {
      const chunk = Buffer.alloc(size - tracked.offset);
      await handle.read(chunk, 0, chunk.length, tracked.offset);
      const full = Buffer.concat([tracked.carry, chunk]);
      const lastNewline = full.lastIndexOf(0x0a);
      if (lastNewline === -1) {
        // Nothing complete yet; keep the fragment and mark these bytes read so
        // the next poll only appends what is new.
        tracked.carry = full;
        tracked.offset = size;
        this.offsets.set(filePath, tracked);
        return;
      }

      const complete = full.subarray(0, lastNewline + 1);
      tracked.carry = full.subarray(lastNewline + 1);
      tracked.offset = size;
      this.offsets.set(filePath, tracked);

      for (const lineBuffer of complete.toString("utf-8").split("\n")) {
        this.processLine(lineBuffer);
      }
    } finally {
      await handle.close();
    }
  }

  private processLine(line: string): void {
    if (!line.trim()) return;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      // Corrupt or non-JSON line: skip it. Session files only contain JSON
      // entries in practice; dropping one bad line must not desync the scan.
      return;
    }

    // Session JSONL entries wrap the message payload; tolerate an unwrapped
    // assistant entry defensively in case the entry shape evolves.
    const message = entry?.type === "message" ? entry.message : entry;
    if (message?.role === "assistant") this.onAssistantMessage(message);
  }
}