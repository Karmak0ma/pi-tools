import { clampPercent } from "./core.js";
import type {
	ProviderUsageState,
	UsageBucket,
	UsageDisplayState,
	UsageMetric,
	UsageModel,
	UsageReport,
} from "./types.js";

const BAR_SEGMENTS = 20;
const VALUE_COLUMN = 29;

export function formatUsageReport(report: UsageReport, displayState: UsageDisplayState): string {
	const stateLabel = displayState === "current" ? "Current" : "Configured";
	const lines = [`${report.providerName} Usage · ${stateLabel}`];
	if (report.accountLabel) lines.push(`Account: ${report.accountLabel}`);
	lines.push(`Semantics: ${report.semantics.label}`, "");

	if (report.providerId === "anthropic") formatAnthropicReport(lines, report);
	else if (report.providerId === "openai-codex") formatCodexReport(lines, report);
	else formatGenericReport(lines, report);

	if (report.notes) {
		for (const note of report.notes) lines.push(note);
	}
	return lines.join("\n").trimEnd();
}

export function formatUsageStatusline(report: UsageReport, model?: UsageModel): string | undefined {
	if (report.providerId === "anthropic") return formatClaudeStatusline(report);
	if (report.providerId === "openai-codex") return formatCodexStatusline(report, model);
	if (report.providerId === "github-copilot") return formatGitHubCopilotStatusline(report);
	return undefined;
}

export function formatProviderStates(states: readonly ProviderUsageState[]): string {
	return states
		.map((state) => {
			if (state.status === "ready") return formatUsageReport(state.report, state.displayState);
			const label = state.displayState === "current" ? "Current" : "Configured";
			const status =
				state.status === "auth-unavailable"
					? "Authentication unavailable"
					: state.status === "unsupported"
						? "Unsupported"
						: "Query failed";
			return `${state.providerName} · ${label}\n${status}: ${state.message}`;
		})
		.join("\n\n");
}

function formatClaudeStatusline(report: UsageReport): string | undefined {
	const parts = [];
	for (const bucket of report.buckets) {
		if (bucket.remaining === undefined) continue;
		const fallback = isWeeklyBucket(bucket) ? "weekly" : "5h";
		parts.push(
			`${formatWindowLabel(bucket.windowMinutes, fallback, true)} ${clampPercent(bucket.remaining).toFixed(0)}%`,
		);
	}
	return parts.length > 0 ? ["claude", parts.join(" · ")].join(" ") : undefined;
}

function formatCodexStatusline(report: UsageReport, model?: UsageModel): string | undefined {
	const group = selectCodexGroup(report, model);
	if (!group) return formatCodexCreditsStatus(report);
	const buckets = report.buckets.filter((bucket) => (bucket.groupId ?? bucket.id) === group);
	const labelBucket = buckets[0];
	const prefix =
		group === "codex" ? "codex" : `codex ${compactLimitLabel(labelBucket?.groupLabel ?? group)}`;
	const parts = [];
	for (const bucket of buckets) {
		if (bucket.remaining === undefined) continue;
		const fallback = isWeeklyBucket(bucket) ? "weekly" : "5h";
		parts.push(
			`${formatWindowLabel(bucket.windowMinutes, fallback, true)} ${clampPercent(bucket.remaining).toFixed(0)}%`,
		);
	}
	return parts.length > 0 ? [prefix, parts.join(" · ")].join(" ") : formatCodexCreditsStatus(report);
}

function formatGitHubCopilotStatusline(report: UsageReport): string | undefined {
	const bucket = report.buckets.find((candidate) => candidate.remaining !== undefined);
	if (bucket?.remaining !== undefined) {
		const quota = bucket.id.endsWith(":chat") ? "chat" : "premium";
		return `copilot ${quota} ${clampPercent(bucket.remaining).toFixed(0)}%`;
	}
	const unlimited = report.metrics.find(
		(metric) => metric.id === "quota" && metric.value === "unlimited",
	);
	return unlimited ? "copilot unlimited" : undefined;
}

function formatCodexCreditsStatus(report: UsageReport): string {
	const credits = report.metrics.find((metric) => metric.id === "credits");
	if (!credits) return "codex usage unavailable";
	if (credits.value === "none") return "codex no credits";
	if (credits.value === "available") return "codex credits available";
	if (credits.value === "unlimited") return "codex credits unlimited";
	return `codex ${formatMetricValue(credits.value, "count")} credits`;
}

function selectCodexGroup(report: UsageReport, model?: UsageModel): string | undefined {
	const groups = [...new Set(report.buckets.map((bucket) => bucket.groupId ?? bucket.id))];
	if (model?.provider !== "openai-codex") {
		return groups.includes("codex") ? "codex" : groups[0];
	}
	const modelKeys = normalizedModelKeys(model);
	for (const group of groups) {
		const bucket = report.buckets.find(
			(candidate) => (candidate.groupId ?? candidate.id) === group,
		);
		const keys = [group, bucket?.groupLabel, ...(bucket?.modelKeys ?? [])]
			.map(normalizeKey)
			.filter((key): key is string => key !== undefined);
		if (keys.some((key) => modelKeys.has(key))) return group;
	}
	const variants = [...modelKeys]
		.map((key) => key.match(/(?:^|-)codex-(.+)$/)?.[1])
		.filter((value): value is string => Boolean(value));
	for (const variant of variants) {
		const matches = groups.filter((group) => {
			if (group === "codex") return false;
			const key = normalizeKey(group);
			return key ? normalizedKeyHasToken(key, variant) : false;
		});
		if (matches.length === 1) return matches[0];
	}
	return groups.includes("codex") ? "codex" : groups[0];
}

function normalizedModelKeys(model: UsageModel): Set<string> {
	const keys = new Set<string>();
	for (const value of [model.id, model.name]) {
		const key = normalizeKey(value);
		if (!key) continue;
		keys.add(key);
		const index = key.indexOf("codex");
		if (index >= 0) keys.add(key.slice(index));
	}
	return keys;
}

function normalizeKey(value: string | undefined): string | undefined {
	const separated = value?.toLowerCase().replace(/[^a-z0-9]+/g, "-");
	if (!separated) return undefined;
	let start = 0;
	let end = separated.length;
	while (separated[start] === "-") start += 1;
	while (end > start && separated[end - 1] === "-") end -= 1;
	return separated.slice(start, end) || undefined;
}

function normalizedKeyHasToken(key: string, token: string): boolean {
	return (
		key === token ||
		key.startsWith(`${token}-`) ||
		key.endsWith(`-${token}`) ||
		key.includes(`-${token}-`)
	);
}

function compactLimitLabel(label: string): string {
	const normalized = label.replace(/[_-]+/g, " ").trim();
	const codex = /\bcodex\s/iu.exec(normalized);
	const suffix = codex ? normalized.slice(codex.index + codex[0].length).trim() : "";
	return (suffix || normalized).toLowerCase().replace(/\s+/g, " ");
}

function formatAnthropicReport(lines: string[], report: UsageReport): void {
	for (const bucket of report.buckets) {
		lines.push(
			`${`${bucket.label}:`.padEnd(VALUE_COLUMN)}${formatPercentBucket(bucket)}`,
		);
	}
	for (const metric of report.metrics) {
		lines.push(
			`${`${metric.label}:`.padEnd(VALUE_COLUMN)}${formatMetricValue(metric.value, metric.unit)}`,
		);
	}
}

function formatCodexReport(lines: string[], report: UsageReport): void {
	let previousGroup: string | undefined;
	for (const bucket of report.buckets) {
		const group = bucket.groupId ?? bucket.id;
		if (group !== previousGroup && group !== "codex") {
			lines.push(`${bucket.groupLabel ?? group} limit:`);
		}
		previousGroup = group;
		const fallback = isWeeklyBucket(bucket) ? "weekly" : "5h";
		const label = `${formatWindowLabel(bucket.windowMinutes, fallback, false)} limit:`;
		lines.push(`${label.padEnd(VALUE_COLUMN)}${formatPercentBucket(bucket)}`);
	}
	for (const metric of report.metrics) {
		if (metric.id === "reset-credits") {
			lines.push(`${"Usage limit resets:".padEnd(VALUE_COLUMN)}${metric.value} available`);
		} else if (metric.id === "credits") {
			lines.push(
				`${"Credits:".padEnd(VALUE_COLUMN)}${formatMetricValue(metric.value, metric.unit)}`,
			);
		}
	}
}

function formatGenericReport(lines: string[], report: UsageReport): void {
	for (const bucket of report.buckets) {
		const value =
			bucket.unit === "percent" && bucket.remaining !== undefined
				? formatPercentBucket(bucket)
				: formatMetricValue(bucket.remaining ?? bucket.used ?? "unavailable", bucket.unit);
		lines.push(`${`${bucket.label}:`.padEnd(VALUE_COLUMN)}${value}`);
	}
	for (const metric of report.metrics) {
		lines.push(
			`${`${metric.label}:`.padEnd(VALUE_COLUMN)}${formatMetricValue(metric.value, metric.unit)}`,
		);
	}
}

function formatPercentBucket(bucket: UsageBucket): string {
	const remaining = clampPercent(bucket.remaining ?? 0);
	const filled = Math.round((remaining / 100) * BAR_SEGMENTS);
	const reset = bucket.resetsAt ? ` (resets ${formatReset(bucket.resetsAt)})` : "";
	return `[${"█".repeat(filled)}${"░".repeat(BAR_SEGMENTS - filled)}] ${remaining.toFixed(0)}% left${reset}`;
}

function formatWindowLabel(
	minutes: number | undefined,
	fallback: "5h" | "weekly",
	compact: boolean,
): string {
	if (!minutes || !Number.isFinite(minutes) || minutes <= 0) {
		return compact && fallback === "weekly" ? "wk" : capitalize(fallback);
	}
	if (minutes === 10_080) return compact ? "wk" : "Weekly";
	if (minutes % 10_080 === 0) return `${minutes / 10_080}w`;
	if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
	if (minutes % 60 === 0) return `${minutes / 60}h`;
	return `${minutes}m`;
}

function formatMetricValue(value: number | string, unit: UsageMetric["unit"] | undefined): string {
	return String(value);
}

function formatReset(epochSeconds: number): string {
	const reset = new Date(epochSeconds * 1000);
	if (Number.isNaN(reset.getTime())) return "at an unknown time";
	const time = `${reset.getHours().toString().padStart(2, "0")}:${reset
		.getMinutes()
		.toString()
		.padStart(2, "0")}`;
	const now = new Date();
	if (reset.toDateString() === now.toDateString()) return time;
	return `${time} on ${reset.getDate()} ${reset.toLocaleDateString(undefined, { month: "short" })}`;
}

function isWeeklyBucket(bucket: UsageBucket): boolean {
	return bucket.id.endsWith(":secondary") || bucket.id.endsWith(":7d");
}

function capitalize(value: string): string {
	return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}