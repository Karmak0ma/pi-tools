import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UsageReport } from "./types.js";

// Why this module exists
// ----------------------
// The provider usage endpoints (notably https://api.anthropic.com/api/oauth/usage)
// are rate limited very aggressively: two calls a few seconds apart already
// answer 429, and the lockout then lasts minutes. Any second consumer that
// polls the same endpoint therefore does not simply "get its own copy" — it
// makes BOTH consumers fail at random.
//
// So this extension is the single owner of the network call, and it publishes
// every result to one small file. Other extensions (sidebar-vflo) and other pi
// processes read that file instead of calling the provider again. The file is
// a cache, never a source of truth: a missing or stale file only means "no
// fresh data yet", never "the provider said zero".

const SHARED_REPORT_VERSION = 1;

export const SHARED_REPORT_PATH = join(homedir(), ".pi", "agent", "usage-vflo-shared.json");

/** Last known state for one provider. Success and failure are kept side by
 * side on purpose: a consumer can then keep showing the last good numbers
 * while also telling the user that the newest refresh failed. */
export interface SharedProviderEntry {
	/** Last successful report, if we ever got one. */
	report?: UsageReport;
	/** Epoch ms when `report` was fetched. */
	capturedAt?: number;
	/** Last failure observed after the last success, if any. */
	failure?: { at: number; message: string };
}

export interface SharedReportFile {
	version: number;
	providers: Record<string, SharedProviderEntry>;
}

const emptyFile = (): SharedReportFile => ({ version: SHARED_REPORT_VERSION, providers: {} });

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Reads the shared file. Returns an empty structure for every failure mode
 * (missing file, unreadable file, corrupt JSON, wrong version) because a cache
 * that cannot be read must degrade to "no data", never to an exception in a
 * caller's render path.
 */
export async function readSharedReportFile(
	path = SHARED_REPORT_PATH,
): Promise<SharedReportFile> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!isRecord(parsed) || parsed.version !== SHARED_REPORT_VERSION) return emptyFile();
		if (!isRecord(parsed.providers)) return emptyFile();
		const providers: Record<string, SharedProviderEntry> = {};
		for (const [providerId, entry] of Object.entries(parsed.providers)) {
			if (isRecord(entry)) providers[providerId] = entry as SharedProviderEntry;
		}
		return { version: SHARED_REPORT_VERSION, providers };
	} catch {
		return emptyFile();
	}
}

/** Convenience reader for a single provider. */
export async function readSharedProviderEntry(
	providerId: string,
	path = SHARED_REPORT_PATH,
): Promise<SharedProviderEntry | undefined> {
	return (await readSharedReportFile(path)).providers[providerId];
}

/**
 * Merges one provider's entry into the shared file.
 *
 * Read-modify-write is deliberate: several pi processes may publish different
 * providers concurrently, and each of them must not drop the others' entries.
 * The write itself is atomic (temp file + rename) so a reader never observes a
 * half-written file. Two processes publishing the SAME provider at the same
 * moment is harmless — last writer wins, and both values are equally fresh.
 *
 * Publication failures are swallowed: the cache is an optimisation, and a
 * read-only or full home directory must not break the usage status line.
 */
async function publish(
	providerId: string,
	patch: (previous: SharedProviderEntry) => SharedProviderEntry,
	path = SHARED_REPORT_PATH,
): Promise<void> {
	try {
		const file = await readSharedReportFile(path);
		file.providers[providerId] = patch(file.providers[providerId] ?? {});
		await mkdir(join(path, ".."), { recursive: true });
		const temporary = `${path}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, "utf8");
		await rename(temporary, path);
	} catch {
		// Intentionally ignored — see doc comment.
	}
}

/** Records a successful fetch and clears the stale failure note. */
export async function publishSharedReport(
	report: UsageReport,
	now = Date.now(),
	path = SHARED_REPORT_PATH,
): Promise<void> {
	await publish(report.providerId, () => ({ report, capturedAt: now }), path);
}

/** Records a failed fetch, keeping the last successful report untouched. */
export async function publishSharedFailure(
	providerId: string,
	message: string,
	now = Date.now(),
	path = SHARED_REPORT_PATH,
): Promise<void> {
	await publish(
		providerId,
		(previous) => ({ ...previous, failure: { at: now, message } }),
		path,
	);
}
