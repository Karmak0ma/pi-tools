import type { SharedProviderEntry } from "pi-usage-vflo/src/index.js";
import type { LimitsState, SubscriptionBucket } from "./types.js";

// Why the sidebar does not fetch usage itself
// -------------------------------------------
// Provider usage endpoints are rate limited hard (Anthropic answers 429 to a
// second call a few seconds after the first, and stays locked out for
// minutes). pi-usage-vflo already polls them for its status line, so a second
// poller here does not add data, it makes both pollers fail at random. The
// sidebar therefore reads pi-usage-vflo's published cache file and never talks
// to the provider. Everything in this module is pure so it can be tested
// without a network, a clock, or a pi session.

/** Data older than this is still shown, but labelled with its age. */
const AGE_LABEL_THRESHOLD_MS = 60_000;

/** Failure text from the provider can be long; the panel only has ~40 columns. */
const MAX_NOTE_LENGTH = 60;

/**
 * Keeps every percent bucket instead of collapsing to the worst one, so
 * providers with several concurrent windows — Anthropic's 5-hour and weekly
 * limits, for example — each get their own row and bar.
 */
export function bucketsFromReport(report: SharedProviderEntry["report"]): SubscriptionBucket[] {
	if (!report || report.semantics.kind !== "consumer-subscription") return [];
	return report.buckets
		.filter((bucket) => bucket.unit === "percent" && bucket.remaining !== undefined)
		.map((bucket) => ({
			id: bucket.id,
			label: bucket.label,
			remaining: Math.max(0, Math.min(100, bucket.remaining as number)),
			...(bucket.windowMinutes !== undefined ? { windowMinutes: bucket.windowMinutes } : {}),
		}));
}

function ageLabel(ageMs: number): string {
	const minutes = Math.floor(ageMs / 60_000);
	if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

function shorten(text: string): string {
	const collapsed = text.replace(/\s+/gu, " ").trim();
	return collapsed.length > MAX_NOTE_LENGTH ? `${collapsed.slice(0, MAX_NOTE_LENGTH - 1)}…` : collapsed;
}

/**
 * Turns one shared-cache entry into what the Limits panel should display.
 *
 * `isSubscriptionProvider` decides whether the panel exists at all: a provider
 * billed per token has no subscription windows, so the panel is hidden rather
 * than showing a permanent "no data" box. For a subscription provider the
 * panel is ALWAYS shown, because "no data" is itself information the user
 * needs — silently hiding the box is what made this failure invisible before.
 */
export function limitsFromEntry(
	entry: SharedProviderEntry | undefined,
	isSubscriptionProvider: boolean,
	now: number,
): LimitsState {
	if (!isSubscriptionProvider) return { buckets: [] };

	const buckets = bucketsFromReport(entry?.report);
	const capturedAt = entry?.capturedAt;
	const failure = entry?.failure;

	if (buckets.length === 0) {
		// A successful unlimited report has no honest percentage bar to draw.
		// State that entitlement directly instead of treating valid data as if
		// the usage extension had not started yet.
		const unlimited = entry?.report?.metrics.find((metric) => metric.value === "unlimited");
		if (unlimited) return { buckets: [], note: `${unlimited.label}: unlimited` };
		// No usable numbers yet. Explain which of the two reasons applies so the
		// user can tell "still starting up" from "the provider refused us".
		return { buckets: [], note: failure ? shorten(failure.message) : "Waiting for usage data…" };
	}

	const parts: string[] = [];
	const ageMs = capturedAt === undefined ? undefined : Math.max(0, now - capturedAt);
	if (ageMs !== undefined && ageMs >= AGE_LABEL_THRESHOLD_MS) parts.push(ageLabel(ageMs));
	// A failure newer than the last success means the numbers below are frozen.
	if (failure && (capturedAt === undefined || failure.at > capturedAt)) {
		parts.push(`refresh failed: ${shorten(failure.message)}`);
	}
	return parts.length > 0 ? { buckets, note: parts.join(" · ") } : { buckets };
}
