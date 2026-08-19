import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	publishSharedFailure,
	publishSharedReport,
	readSharedProviderEntry,
	readSharedReportFile,
} from "../src/shared-report.js";
import type { UsageReport } from "../src/types.js";

const report = (providerId: string): UsageReport => ({
	providerId,
	providerName: "Claude",
	capturedAt: 1000,
	source: "anthropic-oauth-usage",
	semantics: { kind: "consumer-subscription", label: "Claude subscription limits" },
	buckets: [{ id: "anthropic:5h", label: "5-hour window", remaining: 80, limit: 100, unit: "percent" }],
	metrics: [],
});

const scratchFile = async (): Promise<string> =>
	join(await mkdtemp(join(tmpdir(), "usage-shared-")), "shared.json");

describe("shared usage report file", () => {
	it("returns empty data when the file is missing", async () => {
		const path = await scratchFile();
		expect(await readSharedReportFile(path)).toEqual({ version: 1, providers: {} });
		expect(await readSharedProviderEntry("anthropic", path)).toBeUndefined();
	});

	it("degrades to empty data instead of throwing on corrupt content", async () => {
		const path = await scratchFile();
		await writeFile(path, "{ not json", "utf8");
		expect(await readSharedReportFile(path)).toEqual({ version: 1, providers: {} });
	});

	it("publishes a report that readers can load back", async () => {
		const path = await scratchFile();
		await publishSharedReport(report("anthropic"), 5000, path);
		const entry = await readSharedProviderEntry("anthropic", path);
		expect(entry?.capturedAt).toBe(5000);
		expect(entry?.report?.buckets[0]?.remaining).toBe(80);
	});

	it("keeps other providers' entries when publishing one provider", async () => {
		const path = await scratchFile();
		await publishSharedReport(report("anthropic"), 5000, path);
		await publishSharedReport(report("openai-codex"), 6000, path);
		const file = await readSharedReportFile(path);
		expect(Object.keys(file.providers).sort()).toEqual(["anthropic", "openai-codex"]);
	});

	it("keeps the last good report next to a newer failure", async () => {
		const path = await scratchFile();
		await publishSharedReport(report("anthropic"), 5000, path);
		await publishSharedFailure("anthropic", "429 rate limited", 7000, path);
		const entry = await readSharedProviderEntry("anthropic", path);
		expect(entry?.capturedAt).toBe(5000);
		expect(entry?.failure).toEqual({ at: 7000, message: "429 rate limited" });
	});

	it("clears a stale failure once a fresh report arrives", async () => {
		const path = await scratchFile();
		await publishSharedFailure("anthropic", "429 rate limited", 7000, path);
		await publishSharedReport(report("anthropic"), 8000, path);
		expect((await readSharedProviderEntry("anthropic", path))?.failure).toBeUndefined();
	});

	it("writes valid JSON with a version marker", async () => {
		const path = await scratchFile();
		await publishSharedReport(report("anthropic"), 5000, path);
		expect(JSON.parse(await readFile(path, "utf8")).version).toBe(1);
	});
});
