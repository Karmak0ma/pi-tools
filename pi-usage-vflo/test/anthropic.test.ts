import { describe, expect, it } from "vitest";
import { normalizeAnthropicOauthUsagePayload } from "../src/providers/anthropic.js";
import type { AnthropicOauthUsagePayload, UsageReport } from "../src/types.js";

const CAPTURED_AT = 1_752_888_000_000;
const FIVE_HOUR_RESETS_AT = 1_787_067_000;
const SEVEN_DAY_RESETS_AT = 1_787_270_400;

describe("normalizeAnthropicOauthUsagePayload", () => {
	it("normalizes five_hour and seven_day windows into percent buckets", () => {
		const payload: AnthropicOauthUsagePayload = {
			five_hour: { utilization: 62, resets_at: "2026-08-18T15:30:00.000Z" },
			seven_day: { utilization: 38, resets_at: "2026-08-21T00:00:00.000Z" },
		};
		const report = normalizeAnthropicOauthUsagePayload(payload, CAPTURED_AT);
		expect(report).toEqual({
			providerId: "anthropic",
			providerName: "Claude",
			capturedAt: CAPTURED_AT,
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
					resetsAt: FIVE_HOUR_RESETS_AT,
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
					resetsAt: SEVEN_DAY_RESETS_AT,
				},
			],
			metrics: [],
		} satisfies UsageReport);
	});

	it("clamps utilization into 0-100 before computing remaining", () => {
		const payload: AnthropicOauthUsagePayload = {
			five_hour: { utilization: 150, resets_at: null },
			seven_day: { utilization: -10, resets_at: null },
		};
		const report = normalizeAnthropicOauthUsagePayload(payload, CAPTURED_AT);
		expect(report.buckets[0]).toMatchObject({ used: 150, remaining: 0 });
		expect("resetsAt" in report.buckets[0]!).toBe(false);
		expect(report.buckets[1]).toMatchObject({ used: -10, remaining: 100 });
		expect("resetsAt" in report.buckets[1]!).toBe(false);
	});

	it("accepts numeric unix-seconds resets_at", () => {
		const payload: AnthropicOauthUsagePayload = {
			five_hour: { utilization: 10, resets_at: 1_752_900_000 },
		};
		const report = normalizeAnthropicOauthUsagePayload(payload, CAPTURED_AT);
		expect(report.buckets[0]?.resetsAt).toBe(1_752_900_000);
	});

	it("omits windows whose utilization is missing or null", () => {
		const payload: AnthropicOauthUsagePayload = {
			five_hour: { utilization: null, resets_at: null },
			seven_day: { utilization: 50, resets_at: null },
		};
		const report = normalizeAnthropicOauthUsagePayload(payload, CAPTURED_AT);
		expect(report.buckets.map((bucket) => bucket.id)).toEqual(["anthropic:7d"]);
	});

	it("throws when no window remains displayable, including malformed windows", () => {
		const payload: AnthropicOauthUsagePayload = {};
		expect(() => normalizeAnthropicOauthUsagePayload(payload, CAPTURED_AT)).toThrow(
			"Claude usage endpoint returned no displayable usage data.",
		);
		const malformed: AnthropicOauthUsagePayload = { five_hour: "nope", seven_day: undefined };
		expect(() => normalizeAnthropicOauthUsagePayload(malformed, CAPTURED_AT)).toThrow(
			"Claude usage endpoint returned no displayable usage data.",
		);
	});
});