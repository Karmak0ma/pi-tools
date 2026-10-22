import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { SharedProviderEntry } from "../src/shared-report.js";
import type { PiModel, ResolvedUsageAuth, UsageReport } from "../src/types.js";

const mocks = vi.hoisted(() => ({
	entries: new Map<string, unknown>(),
	resolveUsageAuth: vi.fn(),
	queryProviderUsage: vi.fn(),
	readSharedProviderEntry: vi.fn(),
	publishSharedReport: vi.fn(),
	publishSharedFailure: vi.fn(),
	runMenu: vi.fn(),
}));

vi.mock("../src/query.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/query.js")>();
	return {
		...actual,
		resolveUsageAuth: mocks.resolveUsageAuth,
		queryProviderUsage: mocks.queryProviderUsage,
	};
});

vi.mock("../src/shared-report.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/shared-report.js")>();
	return {
		...actual,
		readSharedProviderEntry: mocks.readSharedProviderEntry,
		publishSharedReport: mocks.publishSharedReport,
		publishSharedFailure: mocks.publishSharedFailure,
	};
});

vi.mock("@narumitw/pi-tui-kit", () => ({
	defineMenu: (definition: unknown) => definition,
	runTask: async (ctx: unknown, options: { task(context: { ctx: unknown; signal: AbortSignal }): unknown; signal?: AbortSignal }) => ({
		kind: "completed",
		value: await options.task({ ctx, signal: options.signal ?? new AbortController().signal }),
	}),
	runMenu: (...args: unknown[]) => mocks.runMenu(...args),
}));

import { UsageHttpError } from "../src/query.js";
import usageExtension from "../src/usage.js";

const FIVE_MINUTES_MS = 5 * 60 * 1000;

function model(provider = "anthropic"): PiModel {
	return {
		id: `${provider}-model`,
		name: `${provider} model`,
		provider,
		baseUrl: "https://api.anthropic.com",
	} as PiModel;
}

function report(providerId: string): UsageReport {
	return {
		providerId,
		providerName: providerId,
		capturedAt: Date.now(),
		source: "anthropic-oauth-usage",
		semantics: { kind: "consumer-subscription", label: "Subscription limits" },
		buckets: [{ id: "test", label: "5-hour window", remaining: 80, limit: 100, unit: "percent" }],
		metrics: [],
	};
}

function context(): ExtensionContext & ExtensionCommandContext {
	return {
		mode: "tui",
		hasUI: true,
		model: model(),
		ui: { setStatus: vi.fn(), notify: vi.fn() },
	} as unknown as ExtensionContext & ExtensionCommandContext;
}

function setupExtension() {
	const events = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
			events.set(event, handler);
		},
		registerCommand: (name: string, command: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }) => {
			commands.set(name, command);
		},
	} as unknown as ExtensionAPI;
	usageExtension(pi);
	return { events, commands };
}

async function flushAsyncWork(): Promise<void> {
	for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
	mocks.entries.clear();
	mocks.resolveUsageAuth.mockReset().mockImplementation(async (_ctx: unknown, adapter: { id: string }) => ({
		headers: { Authorization: `Bearer ${adapter.id}` },
		fingerprint: `fingerprint:${adapter.id}`,
		secrets: [],
		model: model(adapter.id),
	}) satisfies ResolvedUsageAuth);
	mocks.queryProviderUsage.mockReset().mockImplementation(async (adapter: { id: string }) => report(adapter.id));
	mocks.readSharedProviderEntry.mockReset().mockImplementation(async (providerId: string) =>
		mocks.entries.get(providerId) as SharedProviderEntry | undefined,
	);
	mocks.publishSharedReport.mockReset().mockImplementation(async (usageReport: UsageReport) => {
		mocks.entries.set(usageReport.providerId, { report: usageReport, capturedAt: Date.now() });
	});
	mocks.publishSharedFailure.mockReset().mockImplementation(async (
		providerId: string,
		message: string,
		now = Date.now(),
		_path?: string,
		details: { status?: number; until?: number } = {},
	) => {
		const previous = mocks.entries.get(providerId) as SharedProviderEntry | undefined;
		mocks.entries.set(providerId, {
			...previous,
			failure: { at: now, message, ...details },
		});
	});
	mocks.runMenu.mockReset().mockImplementation(async (ctx: unknown, definition: any) => {
		await definition.actions.refresh({
			ctx,
			state: undefined,
			signal: new AbortController().signal,
			itemId: "refresh",
		});
		return { kind: "closed", reason: "close" };
	});
});

afterEach(() => {
	vi.useRealTimers();
});

describe("usage status refresh", () => {
	it("uses a fresh shared report when the scheduled timer fires", async () => {
		const { events } = setupExtension();
		const ctx = context();
		events.get("session_start")?.({}, ctx);
		await flushAsyncWork();
		expect(mocks.queryProviderUsage).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
		const newerSharedReport = report("anthropic");
		mocks.entries.set("anthropic", {
			report: newerSharedReport,
			capturedAt: Date.now(),
		});
		await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
		await flushAsyncWork();

		expect(mocks.queryProviderUsage).toHaveBeenCalledTimes(1);
	});

	it("uses the 30-second fallback for older shared failures without a deadline", async () => {
		mocks.entries.set("anthropic", {
			failure: { at: Date.now(), message: "older shared failure" },
		});
		const { events } = setupExtension();
		const ctx = context();
		events.get("session_start")?.({}, ctx);
		await flushAsyncWork();
		expect(mocks.queryProviderUsage).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(30_000 - 1);
		expect(mocks.queryProviderUsage).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await flushAsyncWork();
		expect(mocks.queryProviderUsage).toHaveBeenCalledTimes(1);
	});

	it("persists and respects a 429 lockout during forced refresh", async () => {
		mocks.queryProviderUsage.mockImplementation(async (adapter: { id: string }) => {
			if (adapter.id === "anthropic") {
				throw new UsageHttpError("429 Too Many Requests", 429, 30_000);
			}
			return report(adapter.id);
		});
		const { events, commands } = setupExtension();
		const ctx = context();
		events.get("session_start")?.({}, ctx);
		await flushAsyncWork();

		const failure = (mocks.entries.get("anthropic") as SharedProviderEntry | undefined)?.failure;
		expect(failure).toMatchObject({
			status: 429,
			until: Date.now() + FIVE_MINUTES_MS,
		});
		expect(mocks.queryProviderUsage.mock.calls.filter(([adapter]) => adapter.id === "anthropic")).toHaveLength(1);

		const readsBeforeDeadline = mocks.readSharedProviderEntry.mock.calls.length;
		await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
		await flushAsyncWork();
		expect(mocks.readSharedProviderEntry).toHaveBeenCalledTimes(readsBeforeDeadline);

		// A new session clears process-local state. It must still honor the
		// persisted deadline, including when the user explicitly refreshes.
		events.get("session_shutdown")?.({}, ctx);
		events.get("session_start")?.({}, ctx);
		await flushAsyncWork();
		await commands.get("usage")?.handler("", ctx);
		await flushAsyncWork();

		expect(mocks.queryProviderUsage.mock.calls.filter(([adapter]) => adapter.id === "anthropic")).toHaveLength(1);
	});

	it("allows a forced refresh to bypass a non-429 failure cooldown", async () => {
		let attempts = 0;
		mocks.queryProviderUsage.mockImplementation(async (adapter: { id: string }) => {
			if (adapter.id === "anthropic" && attempts++ === 0) throw new Error("network unavailable");
			return report(adapter.id);
		});
		const { events, commands } = setupExtension();
		const ctx = context();
		events.get("session_start")?.({}, ctx);
		await flushAsyncWork();
		expect(mocks.queryProviderUsage.mock.calls.filter(([adapter]) => adapter.id === "anthropic")).toHaveLength(1);

		await commands.get("usage")?.handler("", ctx);
		await flushAsyncWork();

		expect(mocks.queryProviderUsage.mock.calls.filter(([adapter]) => adapter.id === "anthropic")).toHaveLength(2);
	});
});
