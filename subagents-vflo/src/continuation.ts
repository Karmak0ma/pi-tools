/**
 * Materialize a private writable session for one follow-up. Pi owns the JSONL
 * format, branching, compaction and context edits; use its session manager
 * rather than rebuilding conversation messages ourselves.
 */
import * as fs from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export async function forkChildHistory(source: string, cwd: string, sessionDir: string) {
  // forkFrom reads only an existing valid session. In contrast, --session
  // alone can create an empty session for a missing path and silently lose
  // the promised context. Every request gets its own writer and session id.
  const manager = SessionManager.forkFrom(source, cwd, sessionDir);
  const sessionFile = manager.getSessionFile()!;
  const historyBytes = (await fs.stat(sessionFile)).size;
  return { sessionFile, historyBytes };
}
