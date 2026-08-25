import { clampPercent, sanitizeDisplayText } from "../core.js";
import type { GitHubCopilotUsagePayload, UsageBucket, UsageMetric, UsageReport } from "../types.js";

const SNAPSHOT_KEYS = ["premium_interactions", "premium_models", "chat"] as const;

/**
 * Convert GitHub's Copilot user payload into the provider-neutral report that
 * the statusline and sidebar share. GitHub does not document this endpoint,
 * so every field is parsed defensively and unknown additions are ignored.
 */
export function normalizeGitHubCopilotUsagePayload(
	payload: GitHubCopilotUsagePayload,
	capturedAt: number,
): UsageReport {
	const snapshots = asObject(payload.quota_snapshots);
	const candidates = SNAPSHOT_KEYS.map((key) => ({ key, value: asObject(snapshots?.[key]) }));
	// Prefer a quota that can drive the statusline and sidebar. Some payloads
	// leave an entitlement-only premium object next to a complete chat quota;
	// selecting by object presence would hide the usable percentage. If no
	// snapshot has a percentage/unlimited state, retain count-only data for the
	// detailed /usage report instead of discarding it.
	const selected =
		candidates.find((candidate) => hasRenderableQuota(candidate.value)) ??
		candidates.find((candidate) => hasCountQuota(candidate.value));
	if (!selected) {
		throw new Error("GitHub Copilot usage endpoint returned no displayable quota data.");
	}

	const label = selected.key === "chat" ? "Chat requests" : "Premium requests";
	const id = selected.key.replaceAll("_", "-");
	const percentRemaining = asNumber(selected.value?.percent_remaining);
	const unlimited = selected.value?.unlimited === true;
	const resetsAt = parseResetsAt(
		selected.value?.quota_reset_at ??
			selected.value?.reset_date ??
			payload.quota_reset_date_utc ??
			payload.quota_reset_date,
	);

	const buckets: UsageBucket[] = [];
	if (percentRemaining !== undefined) {
		const remaining = clampPercent(percentRemaining);
		buckets.push({
			id: `github-copilot:${id}`,
			label,
			groupId: "github-copilot",
			groupLabel: "GitHub Copilot",
			used: 100 - remaining,
			remaining,
			limit: 100,
			unit: "percent",
			period: "monthly",
			...(resetsAt !== undefined ? { resetsAt } : {}),
		});
	}

	const metrics: UsageMetric[] = [];
	if (unlimited) metrics.push({ id: "quota", label, value: "unlimited" });
	addCountMetric(metrics, "requests-remaining", `${label} left`, selected.value?.remaining ?? selected.value?.quota_remaining);
	addCountMetric(metrics, "entitlement", `${label} included`, selected.value?.entitlement);
	addCountMetric(metrics, "overage", "Additional requests used", selected.value?.overage_count);
	if (buckets.length === 0 && metrics.length === 0) {
		throw new Error("GitHub Copilot usage endpoint returned no displayable quota data.");
	}

	const plan = asString(payload.copilot_plan);
	const accountLabel = asString(payload.login ?? payload.username);
	return {
		providerId: "github-copilot",
		providerName: "GitHub Copilot",
		capturedAt,
		source: "github-copilot-user",
		semantics: {
			kind: "consumer-subscription",
			label: "GitHub Copilot subscription limits",
		},
		...(accountLabel ? { accountLabel } : {}),
		buckets,
		metrics,
		...(plan ? { notes: [`Plan: ${plan}`] } : {}),
	};
}

function hasRenderableQuota(value: Record<string, unknown> | undefined): boolean {
	return Boolean(
		value && (value.unlimited === true || asNumber(value.percent_remaining) !== undefined),
	);
}

function hasCountQuota(value: Record<string, unknown> | undefined): boolean {
	if (!value) return false;
	return [
		value.remaining,
		value.quota_remaining,
		value.entitlement,
		value.overage_count,
	].some((candidate) => asNumber(candidate) !== undefined);
}

function addCountMetric(
	metrics: UsageMetric[],
	id: string,
	label: string,
	raw: unknown,
): void {
	const value = asNumber(raw);
	if (value === undefined) return;
	metrics.push({ id, label, value, unit: "count" });
}

function parseResetsAt(value: unknown): number | undefined {
	const numeric = asNumber(value);
	if (numeric !== undefined) {
		// GitHub clients have observed seconds, while defensive support for
		// millisecond timestamps avoids dates thousands of years in the future.
		return numeric > 10_000_000_000 ? Math.round(numeric / 1000) : Math.round(numeric);
	}
	if (typeof value !== "string" || !value.trim()) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? Math.round(parsed / 1000) : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return sanitizeDisplayText(value, 160) || undefined;
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}
