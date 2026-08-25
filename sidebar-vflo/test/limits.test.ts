import { describe, expect, it } from "vitest";
import type { SharedProviderEntry } from "pi-usage-vflo/src/index.js";
import { limitsFromEntry } from "../src/limits.js";

const MINUTE = 60_000;
const NOW = 10 * 60 * MINUTE;

const entry = (capturedAt: number, remaining = 80): SharedProviderEntry => ({
	capturedAt,
	report: {
		providerId: "anthropic",
		providerName: "Claude",
		capturedAt,
		source: "anthropic-oauth-usage",
		semantics: { kind: "consumer-subscription", label: "Claude subscription limits" },
		buckets: [
			{ id: "anthropic:5h", label: "5-hour window", remaining, limit: 100, unit: "percent", windowMinutes: 300 },
			// Non-percent buckets carry money or counts, which the sidebar's
			// percentage meters cannot draw, so they must be dropped.
			{ id: "anthropic:spend", label: "Spend", remaining: 5, limit: 100, unit: "usd" },
		],
		metrics: [],
	},
});

describe("limitsFromEntry", () => {
	it("hides the panel for providers without subscription windows", () => {
		expect(limitsFromEntry(undefined, false, NOW)).toEqual({ buckets: [] });
	});

	it("explains that no data has arrived yet", () => {
		expect(limitsFromEntry(undefined, true, NOW).note).toBe("Waiting for usage data…");
	});

	it("reports the failure when the only news is an error", () => {
		const state = limitsFromEntry({ failure: { at: NOW, message: "429 rate limited" } }, true, NOW);
		expect(state.buckets).toEqual([]);
		expect(state.note).toBe("429 rate limited");
	});

	it("keeps only percentage buckets", () => {
		const state = limitsFromEntry(entry(NOW), true, NOW);
		expect(state.buckets.map((bucket) => bucket.id)).toEqual(["anthropic:5h"]);
		expect(state.buckets[0]?.remaining).toBe(80);
	});

	it("keeps GitHub Copilot premium-request quota for the sidebar", () => {
		const copilotEntry: SharedProviderEntry = {
			capturedAt: NOW,
			report: {
				providerId: "github-copilot",
				providerName: "GitHub Copilot",
				capturedAt: NOW,
				source: "github-copilot-user",
				semantics: {
					kind: "consumer-subscription",
					label: "GitHub Copilot subscription limits",
				},
				buckets: [
					{
						id: "github-copilot:premium-interactions",
						label: "Premium requests",
						remaining: 67,
						limit: 100,
						unit: "percent",
						period: "monthly",
					},
				],
				metrics: [],
			},
		};

		expect(limitsFromEntry(copilotEntry, true, NOW).buckets).toEqual([
			{
				id: "github-copilot:premium-interactions",
				label: "Premium requests",
				remaining: 67,
			},
		]);
	});

	it("shows an unlimited subscription without inventing a percentage bar", () => {
		const baseReport = entry(NOW).report!;
		const state = limitsFromEntry(
			{
				capturedAt: NOW,
				report: {
					...baseReport,
					providerId: "github-copilot",
					providerName: "GitHub Copilot",
					buckets: [],
					metrics: [{ id: "quota", label: "Premium requests", value: "unlimited" }],
				},
			},
			true,
			NOW,
		);

		expect(state).toEqual({ buckets: [], note: "Premium requests: unlimited" });
	});

	it("adds no note while the data is fresh", () => {
		expect(limitsFromEntry(entry(NOW - 30_000), true, NOW).note).toBeUndefined();
	});

	it("labels the age of older data", () => {
		expect(limitsFromEntry(entry(NOW - 12 * MINUTE), true, NOW).note).toBe("12m ago");
		expect(limitsFromEntry(entry(NOW - 130 * MINUTE), true, NOW).note).toBe("2h ago");
	});

	it("keeps the last good bars and flags a newer failed refresh", () => {
		const state = limitsFromEntry(
			{ ...entry(NOW - 8 * MINUTE), failure: { at: NOW - MINUTE, message: "429 rate limited" } },
			true,
			NOW,
		);
		expect(state.buckets).toHaveLength(1);
		expect(state.note).toBe("8m ago · refresh failed: 429 rate limited");
	});

	it("ignores a failure that predates the last success", () => {
		const state = limitsFromEntry(
			{ ...entry(NOW), failure: { at: NOW - MINUTE, message: "429 rate limited" } },
			true,
			NOW,
		);
		expect(state.note).toBeUndefined();
	});

	it("clamps out-of-range percentages", () => {
		expect(limitsFromEntry(entry(NOW, 140), true, NOW).buckets[0]?.remaining).toBe(100);
		expect(limitsFromEntry(entry(NOW, -5), true, NOW).buckets[0]?.remaining).toBe(0);
	});
});
