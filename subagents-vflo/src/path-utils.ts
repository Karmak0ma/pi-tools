import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Canonicalize a filesystem entry for comparisons that must tolerate symlinks
 * and different relative spellings.
 *
 * A path may not exist yet when configuration is being validated. Falling back
 * to path.resolve keeps comparisons deterministic without turning an optional
 * comparison into a startup failure; the operation that later uses the path
 * remains responsible for reporting a missing entry.
 */
export function canonicalEntryPath(entryPath: string): string {
  try {
    return fs.realpathSync.native(entryPath);
  } catch {
    return path.resolve(entryPath);
  }
}
