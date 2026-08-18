import { describe, expect, it } from "vitest";
import { normalizeCodexBackendPayload } from "../src/providers/codex.js";
import type { CodexBackendPayload, UsageReport } from "../src/types.js";

const CAPTURED_AT = 1_752_888_000_000;

describe("normalizeCodexBackendPayload", () => {
	it("normalizes primary and secondary windows into percent buckets", () => {
		const payload: CodexBackendPayload = {
			plan_type: "ChatGPT Plus",
			rate_limit: {
				primary_window: {
					used_percent: 59,
					limit_window_seconds: 18_000,
					reset_at: 1_753_000_000,
				},
				secondary_window: {
					used_percent: 61,
					limit_window_seconds: 604_800,
					reset_at: 1_753_200_000,
				},
			},
			additional_rate_limits: [],
			credits: { has_credits: false },
			rate_limit_reset_credits: { available_count: 0 },
		};
		const report = normalizeCodexBackendPayload(payload, CAPTURED_AT);
		expect(report).toEqual({
			providerId: "openai-codex",
			providerName: "OpenAI Codex",
			capturedAt: CAPTURED_AT,
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
					resetsAt: 1_753_000_000,
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
					resetsAt: 1_753_200_000,
				},
			],
			metrics: [
				{ id: "credits", label: "Credits", value: "none" },
				{ id: "reset-credits", label: "Usage limit resets", value: 0, unit: "count" },
			],
			notes: ["Plan: ChatGPT Plus"],
		} satisfies UsageReport);
	});

	it("collects additional rate-limit groups without hiding primary data", () => {
		const payload: CodexBackendPayload = {
			rate_limit: {
				primary_window: { used_percent: 10, limit_window_seconds: 18_000 },
				secondary_window: { used_percent: 20, limit_window_seconds: 604_800 },
			},
			additional_rate_limits: [
				{
					metered_feature: "gpt-5",
					limit_name: "GPT-5 weekly",
					rate_limit: {
						primary_window: { used_percent: 5, limit_window_seconds: 18_000 },
						secondary_window: { used_percent: 7, limit_window_seconds: 604_800 },
					},
				},
				{ metered_feature: "broken", limit_name: "Broken", rate_limit: "not-an-object" },
			],
			credits: { has_credits: true, balance: 42 },
		};
		const report = normalizeCodexBackendPayload(payload, CAPTURED_AT);
		expect(report.buckets.map((bucket) => bucket.id)).toEqual([
			"codex:primary",
			"codex:secondary",
			"gpt-5:primary",
			"gpt-5:secondary",
		]);
		expect(report.metrics).toEqual([
			{ id: "credits", label: "Credits", value: 42, unit: "count" },
		]);
	});

	it("reports unlimited credits as a string metric", () => {
		const payload: CodexBackendPayload = {
			rate_limit: {
				primary_window: { used_percent: 1, limit_window_seconds: 18_000 },
				secondary_window: { used_percent: 2, limit_window_seconds: 604_800 },
			},
			credits: { has_credits: true, balance: 0, unlimited: true },
		};
		const report = normalizeCodexBackendPayload(payload, CAPTURED_AT);
		expect(report.metrics).toEqual([
			{ id: "credits", label: "Credits", value: "unlimited" },
		]);
	});

	it("throws when the payload contains no buckets and no metrics", () => {
		const payload: CodexBackendPayload = {};
		expect(() => normalizeCodexBackendPayload(payload, CAPTURED_AT)).toThrow(
			"Codex usage endpoint returned no displayable usage data.",
		);
	});
});