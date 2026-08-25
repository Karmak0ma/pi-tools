import { describe, expect, it } from "vitest";
import { normalizeGitHubCopilotUsagePayload } from "../src/providers/github-copilot.js";

const CAPTURED_AT = 1_752_888_000_000;

describe("normalizeGitHubCopilotUsagePayload", () => {
	it("normalizes premium request quota into a percentage bucket", () => {
		const report = normalizeGitHubCopilotUsagePayload(
			{
				login: "octocat",
				copilot_plan: "individual_pro",
				quota_reset_date_utc: "2026-09-01T00:00:00Z",
				quota_snapshots: {
					premium_interactions: {
						entitlement: 300,
						remaining: 123,
						percent_remaining: 41,
						overage_count: 2,
						overage_permitted: true,
					},
				},
			},
			CAPTURED_AT,
		);

		expect(report).toMatchObject({
			providerId: "github-copilot",
			providerName: "GitHub Copilot",
			capturedAt: CAPTURED_AT,
			source: "github-copilot-user",
			accountLabel: "octocat",
			semantics: {
				kind: "consumer-subscription",
				label: "GitHub Copilot subscription limits",
			},
			buckets: [
				{
					id: "github-copilot:premium-interactions",
					label: "Premium requests",
					used: 59,
					remaining: 41,
					limit: 100,
					unit: "percent",
					period: "monthly",
					resetsAt: 1_788_220_800,
				},
			],
			metrics: [
				{ id: "requests-remaining", label: "Premium requests left", value: 123, unit: "count" },
				{ id: "entitlement", label: "Premium requests included", value: 300, unit: "count" },
				{ id: "overage", label: "Additional requests used", value: 2, unit: "count" },
			],
			notes: ["Plan: individual_pro"],
		});
	});

	it("falls back to the chat quota and supports numeric strings", () => {
		const report = normalizeGitHubCopilotUsagePayload(
			{
				quota_snapshots: {
					chat: {
						percent_remaining: "72.5",
						quota_remaining: "36",
						quota_reset_at: 1_788_220_800,
					},
				},
			},
			CAPTURED_AT,
		);

		expect(report.buckets[0]).toMatchObject({
			id: "github-copilot:chat",
			label: "Chat requests",
			remaining: 72.5,
			resetsAt: 1_788_220_800,
		});
		expect(report.metrics[0]).toEqual({
			id: "requests-remaining",
			label: "Chat requests left",
			value: 36,
			unit: "count",
		});
	});

	it("skips a metadata-only premium snapshot instead of hiding valid chat quota", () => {
		const report = normalizeGitHubCopilotUsagePayload(
			{
				quota_snapshots: {
					premium_interactions: { entitlement: 300 },
					chat: { percent_remaining: 88 },
				},
			},
			CAPTURED_AT,
		);

		expect(report.buckets[0]).toMatchObject({
			id: "github-copilot:chat",
			remaining: 88,
		});
	});

	it("reports an unlimited quota without inventing a percentage", () => {
		const report = normalizeGitHubCopilotUsagePayload(
			{ quota_snapshots: { premium_interactions: { unlimited: true } } },
			CAPTURED_AT,
		);
		expect(report.buckets).toEqual([]);
		expect(report.metrics).toEqual([
			{ id: "quota", label: "Premium requests", value: "unlimited" },
		]);
	});

	it("rejects payloads without a displayable quota", () => {
		expect(() => normalizeGitHubCopilotUsagePayload({}, CAPTURED_AT)).toThrow(
			"GitHub Copilot usage endpoint returned no displayable quota data.",
		);
	});
});
