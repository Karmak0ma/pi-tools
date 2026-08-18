import { clampPercent } from "../core.js";
import type {
	AnthropicOauthUsagePayload,
	UsageBucket,
	UsageReport,
} from "../types.js";

const FIVE_HOUR_WINDOW_MINUTES = 5 * 60;
const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;

export function normalizeAnthropicOauthUsagePayload(
	payload: AnthropicOauthUsagePayload,
	capturedAt: number,
): UsageReport {
	const buckets: UsageBucket[] = [];
	addWindow(buckets, "anthropic:5h", "5-hour window", payload.five_hour, FIVE_HOUR_WINDOW_MINUTES);
	addWindow(buckets, "anthropic:7d", "Weekly window", payload.seven_day, WEEKLY_WINDOW_MINUTES);
	if (buckets.length === 0) {
		throw new Error("Claude usage endpoint returned no displayable usage data.");
	}
	return {
		providerId: "anthropic",
		providerName: "Claude",
		capturedAt,
		source: "anthropic-oauth-usage",
		semantics: {
			kind: "consumer-subscription",
			label: "Claude subscription limits",
		},
		buckets,
		metrics: [],
	};
}

function addWindow(
	buckets: UsageBucket[],
	id: string,
	label: string,
	raw: unknown,
	windowMinutes: number,
): void {
	const window = asObject(raw);
	if (!window) return;
	const used = asNumber(window.utilization);
	if (used === undefined) return;
	const resetsAt = parseResetsAt(window.resets_at);
	buckets.push({
		id,
		label,
		groupId: "anthropic",
		groupLabel: "Claude subscription",
		used,
		remaining: 100 - clampPercent(used),
		limit: 100,
		unit: "percent",
		windowMinutes,
		...(resetsAt !== undefined ? { resetsAt } : {}),
	});
}

function parseResetsAt(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return Math.round(parsed / 1000);
	}
	return undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	return undefined;
}