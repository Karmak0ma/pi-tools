import type { DiffFile, DiffSummary } from "./types.js";

// The Diff panel shows the uncommitted changes in the session folder:
// `git diff HEAD` (staged + unstaged changes in tracked files) plus the list of
// untracked, non-ignored files. It runs git as a subprocess. This is the only
// subprocess the sidebar starts, and it runs only on specific agent events
// (see index.ts), never on a timer.

// Minimal shape of `pi.exec`, so this module can be tested with a fake.
export type ExecFn = (
	command: string,
	args: string[],
	options?: { cwd?: string; timeout?: number },
) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;

// A big repository can make `git diff` slow. A hung git must never keep the
// panel busy forever, so each call gets a hard limit.
const GIT_TIMEOUT_MS = 5_000;

// Git's well-known hash of the empty tree. In a new repository with no commit
// yet, `git diff HEAD` fails because HEAD does not exist. Comparing against the
// empty tree instead shows every tracked file as added, which is correct.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// `--no-optional-locks`: `git diff` may refresh and rewrite the index as a side
// effect. The agent may be running its own git commands at the same moment,
// and a background index write could make those fail with "index.lock
// exists". This flag tells git to skip that optional write.
const DIFF_ARGS = ["--no-optional-locks", "diff", "--numstat", "-z", "--no-renames"];

// Parses `git diff --numstat -z --no-renames` output.
//
// With `-z`, every record is `added<TAB>removed<TAB>path<NUL>`, and paths are
// not quoted or escaped. `--no-renames` keeps one path per record; with rename
// detection on, `-z` would put the old and new path in two extra NUL fields.
// A binary file has `-` for both counts, which becomes null.
export function parseNumstat(output: string): DiffFile[] {
	const files: DiffFile[] = [];
	for (const record of output.split("\0")) {
		if (!record) continue;
		const [added, removed, ...rest] = record.split("\t");
		// A path can contain a TAB, so join everything after the second field.
		const path = rest.join("\t");
		if (!path || added === undefined || removed === undefined) continue;
		files.push({ path, added: count(added), removed: count(removed), untracked: false });
	}
	return files;
}

// Parses `git ls-files --others --exclude-standard -z` output: NUL-separated
// paths of files that are not tracked and not ignored.
export function parseUntracked(output: string): DiffFile[] {
	return output
		.split("\0")
		.filter((path) => path.length > 0)
		.map((path) => ({ path, added: null, removed: null, untracked: true }));
}

function count(field: string): number | null {
	const value = Number.parseInt(field, 10);
	return Number.isFinite(value) && value >= 0 ? value : null;
}

// Returns the diff summary for `cwd`, or undefined when `cwd` is not in a git
// repository (or git is not installed). Undefined hides the panel.
export async function loadDiff(exec: ExecFn, cwd: string): Promise<DiffSummary | undefined> {
	const run = (args: string[]) => exec("git", args, { cwd, timeout: GIT_TIMEOUT_MS }).catch(() => undefined);
	let tracked = await run([...DIFF_ARGS, "HEAD"]);
	if (!tracked || tracked.code !== 0) tracked = await run([...DIFF_ARGS, EMPTY_TREE]);
	// Both failed: not a repository, git missing, or a timeout. There is
	// nothing true to show, so hide the panel instead of claiming "no changes".
	if (!tracked || tracked.code !== 0) return undefined;
	// `git diff` reports the whole repository with root-relative paths, even
	// from a subfolder. `ls-files` would only list the current subfolder with
	// subfolder-relative paths, so `:/` (repo root pathspec) and `--full-name`
	// make both lists cover the same files with the same path style.
	const untracked = await run(["ls-files", "--others", "--exclude-standard", "-z", "--full-name", ":/"]);
	const files = [
		...parseNumstat(tracked.stdout),
		// If only this second call fails, the tracked changes are still correct,
		// so show them rather than hiding everything.
		...(untracked && untracked.code === 0 ? parseUntracked(untracked.stdout) : []),
	];
	files.sort((a, b) => a.path.localeCompare(b.path));
	return { files };
}
