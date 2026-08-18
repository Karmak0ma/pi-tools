process.env.TZ = "UTC";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	formatProviderStates,
	formatUsageReport,
	formatUsageStatusline,
} from "../src/format.js";
import type { ProviderUsageState, UsageReport } from "../src/types.js";

const claudeReport: UsageReport = {
	providerId: "anthropic",
	providerName: "Claude",
	capturedAt: 1_752_888_000_000,
	source: "anthropic-oauth-usage",
	semantics: { kind: "consumer-subscription", label: "Claude subscription limits" },
	buckets: [
		{
			id: "anthropic:5h",
			label: "5-hour window",
			groupId: "anthropic",
			groupLabel: "Claude subscription",
			used: 62,
			remaining: 38,
			limit: 100,
			unit: "percent",
			windowMinutes: 300,
		},
		{
			id: "anthropic:7d",
			label: "Weekly window",
			groupId: "anthropic",
			groupLabel: "Claude subscription",
			used: 38,
			remaining: 62,
			limit: 100,
			unit: "percent",
			windowMinutes: 10_080,
		},
	],
	metrics: [],
};

const codexReport: UsageReport = {
	providerId: "openai-codex",
	providerName: "OpenAI Codex",
	capturedAt: 1_752_888_000_000,
	source: "codex-pi-auth",
	semantics: { kind: "consumer-subscription", label: "ChatGPT subscription limits" },
	buckets: [
		{
			id: "codex:primary",
			label: "Primary limit",
			groupId: "codex",
			groupLabel: "Codex",
			modelKeys: ["codex", "Codex"],
			used: 59,
			remaining: 41,
			limit: 100,
			unit: "percent",
			windowMinutes: 300,
		},
		{
			id: "codex:secondary",
			label: "Secondary limit",
			groupId: "codex",
			groupLabel: "Codex",
			modelKeys: ["codex", "Codex"],
			used: 61,
			remaining: 39,
			limit: 100,
			unit: "percent",
			windowMinutes: 10_080,
		},
	],
	metrics: [
		{ id: "credits", label: "Credits", value: "none" },
		{ id: "reset-credits", label: "Usage limit resets", value: 0, unit: "count" },
	],
	notes: ["Plan: ChatGPT Plus"],
};

afterEach(() => {
	vi.useRealTimers();
});

describe("formatUsageStatusline", () => {
	it("renders claude windows as window label first, remaining percent, joined by ·", () => {
		expect(formatUsageStatusline(claudeReport)).toBe("claude 5h 38% · wk 62%");
	});

	it("renders a single claude window when only one exists", () => {
		const report: UsageReport = {
			...claudeReport,
			buckets: [claudeReport.buckets[0]],
		};
		expect(formatUsageStatusline(report)).toBe("claude 5h 38%");
	});

	it("renders codex with the codex prefix and both windows", () => {
		expect(formatUsageStatusline(codexReport)).toBe("codex 5h 41% · wk 39%");
	});

	it("renders the group matching the current codex model with a compact label prefix", () => {
		const report: UsageReport = {
			...codexReport,
			buckets: [
				...codexReport.buckets,
				{
					id: "gpt-5:primary",
					label: "Primary limit",
					groupId: "gpt-5",
					groupLabel: "GPT-5",
					modelKeys: ["gpt-5", "GPT-5"],
					used: 5,
					remaining: 95,
					limit: 100,
					unit: "percent",
					windowMinutes: 300,
				},
				{
					id: "gpt-5:secondary",
					label: "Secondary limit",
					groupId: "gpt-5",
					groupLabel: "GPT-5",
					modelKeys: ["gpt-5", "GPT-5"],
					used: 7,
					remaining: 93,
					limit: 100,
					unit: "percent",
					windowMinutes: 10_080,
				},
			],
		};
		const model = { id: "gpt-5", name: "gpt-5", provider: "openai-codex" };
		expect(formatUsageStatusline(report, model)).toBe("codex gpt 5 5h 95% · wk 93%");
	});

	it("falls back to codex credits status when no bucket has a remaining percent", () => {
		const report: UsageReport = {
			...codexReport,
			buckets: [],
			metrics: [{ id: "credits", label: "Credits", value: "unlimited" }],
		};
		expect(formatUsageStatusline(report)).toBe("codex credits unlimited");
	});

	it("returns undefined for a provider without a statusline formatter", () => {
		const report: UsageReport = { ...claudeReport, providerId: "unknown-provider" };
		expect(formatUsageStatusline(report)).toBeUndefined();
	});
});

describe("formatUsageReport", () => {
	it("renders the claude menu body with bars, remaining percent, and resets", () => {
		vi.setSystemTime(new Date("2026-08-18T12:00:00Z"));
		const todayReset = new Date("2026-08-18T15:30:00Z");
		const tomorrowReset = new Date("2026-08-19T12:00:00Z");
		const report: UsageReport = {
			...claudeReport,
			buckets: [
				{
					...claudeReport.buckets[0],
					resetsAt: Math.floor(todayReset.getTime() / 1000),
				},
				{
					...claudeReport.buckets[1],
					resetsAt: Math.floor(tomorrowReset.getTime() / 1000),
				},
			],
		};
		expect(formatUsageReport(report, "current")).toBe(
			[
				"Claude Usage · Current",
				"Semantics: Claude subscription limits",
				"",
				"5-hour window:               [████████░░░░░░░░░░░░] 38% left (resets 15:30)",
				"Weekly window:               [████████████░░░░░░░░] 62% left (resets 12:00 on 19 Aug)",
			].join("\n"),
		);
	});

	it("renders the codex menu body with window labels, group headers, metrics, and notes", () => {
		expect(formatUsageReport(codexReport, "configured")).toBe(
			[
				"OpenAI Codex Usage · Configured",
				"Semantics: ChatGPT subscription limits",
				"",
				`5h limit:${" ".repeat(20)}[████████░░░░░░░░░░░░] 41% left`,
				`Weekly limit:${" ".repeat(16)}[████████░░░░░░░░░░░░] 39% left`,
				`Credits:${" ".repeat(21)}none`,
				`Usage limit resets:${" ".repeat(10)}0 available`,
				"Plan: ChatGPT Plus",
			].join("\n"),
		);
	});

	it("renders an account line when the report has an account label", () => {
		const report: UsageReport = {
			...claudeReport,
			accountLabel: "vflo@example.com",
			buckets: [claudeReport.buckets[0]],
		};
		expect(formatUsageReport(report, "current")).toContain("Account: vflo@example.com");
	});
});

describe("formatProviderStates", () => {
	it("joins ready and error states with a blank line", () => {
		const states: ProviderUsageState[] = [
			{
				providerId: "anthropic",
				providerName: "Claude",
				displayState: "current",
				status: "ready",
				report: { ...claudeReport, buckets: [claudeReport.buckets[0]] },
			},
			{
				providerId: "openai-codex",
				providerName: "OpenAI Codex",
				displayState: "configured",
				status: "auth-unavailable",
				message: "No runtime credential for provider openai-codex.",
			},
		];
		expect(formatProviderStates(states)).toBe(
			[
				"Claude Usage · Current",
				"Semantics: Claude subscription limits",
				"",
				`5-hour window:${" ".repeat(15)}[████████░░░░░░░░░░░░] 38% left`,
				"",
				"OpenAI Codex · Configured",
				"Authentication unavailable: No runtime credential for provider openai-codex.",
			].join("\n"),
		);
	});
});