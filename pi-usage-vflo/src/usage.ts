import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { awaitWithDeadline, errorMessage, isAbortError, runWithConcurrency, UsageCache } from "./core.js";
import { formatProviderStates, formatUsageStatusline } from "./format.js";
import {
	adapterForProvider,
	isStaleExtensionContextError,
	queryProviderUsage,
	resolveUsageAuth,
	SUPPORTED_ADAPTERS,
} from "./query.js";
import type {
	PiModel,
	ProviderUsageState,
	ResolvedUsageAuth,
	UsageDisplayState,
	UsageProviderAdapter,
} from "./types.js";
import {
	isTimeoutError,
	modelIdentity,
	providerDisplayName,
	setBoundedMap,
} from "./usage-helpers.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 15_000;
const ALL_PROVIDER_CONCURRENCY = 2;
const FAILURE_BACKOFF_MS = 30_000;
const MAX_ACCOUNT_STATES = 32;
const STATUS_KEY = "usage";

const REFRESH_ALL = "Refresh usage";
const CLOSE = "Close";

type QueryOutcome = {
	state: ProviderUsageState;
	fingerprint?: string;
	authState?: "unavailable";
};

export default function usageExtension(pi: ExtensionAPI): void {
	const cache = new UsageCache(CACHE_TTL_MS);
	const failureBackoff = new Map<string, { until: number; message: string }>();
	const latestQueries = new Map<string, number>();
	const activeControllers = new Set<AbortController>();
	let querySequence = 0;
	let activeCurrentIdentity: string | undefined;
	let sessionActive = false;
	let statusGeneration = 0;
	let statusRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	let statusController: AbortController | undefined;

	const clearStatusTimer = () => {
		if (statusRefreshTimer) clearTimeout(statusRefreshTimer);
		statusRefreshTimer = undefined;
	};

	const safeSetStatus = (ctx: ExtensionContext, value: string | undefined): boolean => {
		try {
			ctx.ui.setStatus(STATUS_KEY, value);
			return true;
		} catch (error) {
			if (isStaleExtensionContextError(error)) return false;
			throw error;
		}
	};

	const clearStatus = (ctx: ExtensionContext) => {
		statusGeneration += 1;
		statusController?.abort();
		statusController = undefined;
		clearStatusTimer();
		safeSetStatus(ctx, undefined);
	};

	const scheduleStatusRefresh = (ctx: ExtensionContext, model: PiModel, delayMs = CACHE_TTL_MS) => {
		clearStatusTimer();
		const generation = statusGeneration;
		statusRefreshTimer = setTimeout(() => {
			statusRefreshTimer = undefined;
			if (!sessionActive || generation !== statusGeneration) return;
			startStatusRefresh(ctx, model, true);
		}, delayMs);
		statusRefreshTimer.unref?.();
	};

	const publishStatus = (
		ctx: ExtensionContext,
		outcome: QueryOutcome,
		model: PiModel,
		shouldSchedule: boolean,
	) => {
		if (outcome.state.status === "unsupported") {
			clearStatusTimer();
			safeSetStatus(ctx, undefined);
			return;
		}
		if (outcome.state.status !== "ready") {
			if (outcome.state.status === "query-failed") {
				if (safeSetStatus(ctx, undefined)) {
					if (shouldSchedule && sessionActive) {
						scheduleStatusRefresh(ctx, model, FAILURE_BACKOFF_MS);
					}
				}
				return;
			}
			if (safeSetStatus(ctx, "auth unavailable")) {
				if (shouldSchedule && sessionActive) scheduleStatusRefresh(ctx, model);
			}
			return;
		}
		const value = formatUsageStatusline(outcome.state.report, model);
		if (!safeSetStatus(ctx, value)) return;
		if (shouldSchedule && sessionActive) scheduleStatusRefresh(ctx, model);
	};

	const invalidateProviderState = (providerId: string) => {
		cache.clearProvider(providerId);
		for (const key of failureBackoff.keys()) {
			if (key.startsWith(`${providerId}:`)) failureBackoff.delete(key);
		}
		for (const key of latestQueries.keys()) {
			if (key.startsWith(`${providerId}:`)) latestQueries.delete(key);
		}
	};

	const transitionCurrentIdentity = (nextIdentity: string, providerId: string) => {
		if (!activeCurrentIdentity || activeCurrentIdentity === nextIdentity) {
			activeCurrentIdentity = nextIdentity;
			return;
		}
		const previousProviderId = activeCurrentIdentity.split(":", 1)[0] ?? "";
		for (const id of new Set([previousProviderId, providerId])) {
			if (id) invalidateProviderState(id);
		}
		activeCurrentIdentity = nextIdentity;
	};

	const queryAdapterState = async (
		ctx: ExtensionContext,
		adapter: UsageProviderAdapter,
		displayState: UsageDisplayState,
		force: boolean,
		signal: AbortSignal,
	): Promise<QueryOutcome> => {
		const startedAt = Date.now();
		let auth: ResolvedUsageAuth | undefined;
		try {
			auth = await awaitWithDeadline(
				resolveUsageAuth(ctx, adapter),
				signal,
				DEFAULT_TIMEOUT_MS,
				`resolving ${adapter.displayName} runtime auth`,
			);
		} catch (error) {
			if (isStaleExtensionContextError(error) || isAbortError(error)) throw error;
			if (displayState === "current") {
				transitionCurrentIdentity(`${adapter.id}:auth-error`, adapter.id);
			}
			return {
				state: {
					providerId: adapter.id,
					providerName: adapter.displayName,
					displayState,
					status: isTimeoutError(error) ? "query-failed" : "auth-unavailable",
					message: errorMessage(error),
				},
			};
		}
		if (!auth) {
			if (displayState === "current") {
				transitionCurrentIdentity(`${adapter.id}:unavailable`, adapter.id);
			}
			return {
				state: {
					providerId: adapter.id,
					providerName: adapter.displayName,
					displayState,
					status: "auth-unavailable",
					message: `No runtime credential is configured for ${adapter.displayName}.`,
				},
				authState: "unavailable",
			};
		}
		if (displayState === "current") {
			transitionCurrentIdentity(`${adapter.id}:${auth.fingerprint}`, adapter.id);
		}

		const cached = !force ? cache.get(adapter.id, auth.fingerprint) : undefined;
		if (cached) {
			return {
				state: {
					providerId: adapter.id,
					providerName: adapter.displayName,
					displayState,
					status: "ready",
					report: cached,
				},
				fingerprint: auth.fingerprint,
			};
		}

		const failureKey = `${adapter.id}:${auth.fingerprint}`;
		const previousFailure = failureBackoff.get(failureKey);
		if (!force && previousFailure && previousFailure.until > Date.now()) {
			return {
				state: {
					providerId: adapter.id,
					providerName: adapter.displayName,
					displayState,
					status: "query-failed",
					message: previousFailure.message,
				},
				fingerprint: auth.fingerprint,
			};
		}
		failureBackoff.delete(failureKey);
		querySequence += 1;
		const queryId = querySequence;
		setBoundedMap(latestQueries, failureKey, queryId, MAX_ACCOUNT_STATES);

		try {
			const remainingMs = Math.max(1, DEFAULT_TIMEOUT_MS - (Date.now() - startedAt));
			const report = await queryProviderUsage(adapter, auth, signal, remainingMs);
			if (latestQueries.get(failureKey) === queryId) {
				cache.set(adapter.id, auth.fingerprint, report);
				failureBackoff.delete(failureKey);
			}
			return {
				state: {
					providerId: adapter.id,
					providerName: adapter.displayName,
					displayState,
					status: "ready",
					report,
				},
				fingerprint: auth.fingerprint,
			};
		} catch (error) {
			if (isStaleExtensionContextError(error) || isAbortError(error)) throw error;
			const message = errorMessage(error);
			const now = Date.now();
			for (const [key, failure] of failureBackoff) {
				if (failure.until <= now) failureBackoff.delete(key);
			}
			if (latestQueries.get(failureKey) === queryId) {
				setBoundedMap(
					failureBackoff,
					failureKey,
					{ until: now + FAILURE_BACKOFF_MS, message },
					MAX_ACCOUNT_STATES,
				);
			}
			return {
				state: {
					providerId: adapter.id,
					providerName: adapter.displayName,
					displayState,
					status: "query-failed",
					message,
				},
				fingerprint: auth.fingerprint,
			};
		}
	};

	const queryCurrentState = async (
		ctx: ExtensionContext,
		model: PiModel | undefined,
		force: boolean,
		signal: AbortSignal,
	): Promise<QueryOutcome> => {
		const adapter = adapterForProvider(model?.provider);
		if (!adapter) {
			const providerId = model?.provider ?? "none";
			transitionCurrentIdentity(`unsupported:${providerId}`, providerId);
			return {
				state: {
					providerId,
					providerName: providerDisplayName(ctx, providerId),
					displayState: "current",
					status: "unsupported",
					message: model
						? `Usage reporting is not supported for ${providerDisplayName(ctx, providerId)}.`
						: "No model is selected.",
				},
			};
		}
		return queryAdapterState(ctx, adapter, "current", force, signal);
	};

	const refreshCurrentStatus = async (
		ctx: ExtensionContext,
		model: PiModel | undefined,
		force: boolean,
	) => {
		const adapter = adapterForProvider(model?.provider);
		if (!adapter || !model) {
			const providerId = model?.provider ?? "none";
			transitionCurrentIdentity(`unsupported:${providerId}`, providerId);
			clearStatus(ctx);
			return;
		}
		statusGeneration += 1;
		const generation = statusGeneration;
		statusController?.abort();
		const controller = new AbortController();
		statusController = controller;
		activeControllers.add(controller);
		try {
			if (!safeSetStatus(ctx, "checking")) return;
			const outcome = await queryCurrentState(ctx, model, force, controller.signal);
			if (!sessionActive || generation !== statusGeneration || controller.signal.aborted) return;
			if (!(await outcomeStillCurrent(ctx, model, generation, outcome, controller.signal))) {
				if (sessionActive && generation === statusGeneration) {
					queueMicrotask(() => startStatusRefresh(ctx, ctx.model, false));
				}
				return;
			}
			publishStatus(ctx, outcome, model, true);
		} finally {
			activeControllers.delete(controller);
			if (statusController === controller) statusController = undefined;
		}
	};

	const startStatusRefresh = (
		ctx: ExtensionContext,
		model: PiModel | undefined,
		force: boolean,
	) => {
		void refreshCurrentStatus(ctx, model, force).catch((error) => {
			if (isStaleExtensionContextError(error) || isAbortError(error)) return;
			safeSetStatus(ctx, "usage error");
		});
	};

	const runMenuOperation = async <T>(
		ctx: ExtensionCommandContext,
		label: string,
		parentSignal: AbortSignal,
		operation: (signal: AbortSignal) => Promise<T>,
		cancellable = true,
	): Promise<T | undefined> => {
		const { runTask } = await import("@narumitw/pi-tui-kit");
		if (parentSignal.aborted) return undefined;
		const result = await runTask(ctx, {
			label,
			signal: parentSignal,
			cancellable,
			onError: () => undefined,
			task: ({ signal }) => operation(signal),
		});
		switch (result.kind) {
			case "completed":
				return result.value;
			case "cancelled":
			case "stale":
				return undefined;
			case "error":
				throw result.error;
		}
	};

	const outcomeStillCurrent = async (
		ctx: ExtensionContext,
		model: PiModel | undefined,
		generation: number,
		outcome: QueryOutcome,
		signal: AbortSignal,
	): Promise<boolean> => {
		if (generation !== statusGeneration || modelIdentity(ctx.model) !== modelIdentity(model)) {
			return false;
		}
		const adapter = adapterForProvider(model?.provider);
		if (outcome.authState === "unavailable") {
			if (!adapter) return false;
			try {
				const auth = await awaitWithDeadline(
					resolveUsageAuth(ctx, adapter),
					signal,
					DEFAULT_TIMEOUT_MS,
					`revalidating ${adapter.displayName} runtime auth`,
				);
				return (
					generation === statusGeneration &&
					modelIdentity(ctx.model) === modelIdentity(model) &&
					auth === undefined
				);
			} catch (error) {
				if (isAbortError(error) || isStaleExtensionContextError(error)) throw error;
				return false;
			}
		}
		if (!outcome.fingerprint) return true;
		if (!adapter) return false;
		try {
			const auth = await awaitWithDeadline(
				resolveUsageAuth(ctx, adapter),
				signal,
				DEFAULT_TIMEOUT_MS,
				`revalidating ${adapter.displayName} runtime auth`,
			);
			return (
				generation === statusGeneration &&
				modelIdentity(ctx.model) === modelIdentity(model) &&
				auth?.fingerprint === outcome.fingerprint
			);
		} catch (error) {
			if (isAbortError(error) || isStaleExtensionContextError(error)) throw error;
			return false;
		}
	};

	const queryBothProviders = async (
		ctx: ExtensionCommandContext,
		force: boolean,
		controller: AbortController,
	): Promise<ProviderUsageState[] | undefined> => {
		const currentProviderId = ctx.model?.provider;
		const settled = await runMenuOperation(ctx, "Checking usage…", controller.signal, (signal) =>
			runWithConcurrency(
				SUPPORTED_ADAPTERS,
				ALL_PROVIDER_CONCURRENCY,
				(adapter, _index, workerSignal) =>
					queryAdapterState(
						ctx,
						adapter,
						adapter.id === currentProviderId ? "current" : "configured",
						force,
						workerSignal,
					),
				signal,
			),
		);
		if (!settled) return undefined;
		const states = settled.map((result, index) => {
			if (result.status === "fulfilled") return result.value.state;
			const adapter = SUPPORTED_ADAPTERS[index] as UsageProviderAdapter;
			return {
				providerId: adapter.id,
				providerName: adapter.displayName,
				displayState: adapter.id === currentProviderId ? ("current" as const) : ("configured" as const),
				status: "query-failed" as const,
				message: errorMessage(result.reason),
			};
		});
		return states.sort((left, right) => {
			if (left.providerId === currentProviderId) return -1;
			if (right.providerId === currentProviderId) return 1;
			return left.providerId.localeCompare(right.providerId);
		});
	};

	const publishCurrentState = (
		ctx: ExtensionCommandContext,
		states: readonly ProviderUsageState[],
	) => {
		const currentProviderId = ctx.model?.provider;
		const currentState = states.find((state) => state.providerId === currentProviderId);
		if (currentState && ctx.model) {
			publishStatus(ctx, { state: currentState }, ctx.model, sessionActive);
		} else {
			safeSetStatus(ctx, undefined);
		}
	};

	const showMenu = async (ctx: ExtensionCommandContext): Promise<void> => {
		if (!ctx.hasUI) throw new Error("/usage requires TUI or RPC mode.");
		statusGeneration += 1;
		const menuGeneration = statusGeneration;
		statusController?.abort();
		statusController = undefined;
		clearStatusTimer();
		const controller = new AbortController();
		activeControllers.add(controller);
		try {
			const initialStates = await queryBothProviders(ctx, false, controller);
			if (!initialStates) return;
			let visibleStates = initialStates;
			publishCurrentState(ctx, visibleStates);
			const { defineMenu, runMenu } = await import("@narumitw/pi-tui-kit");
			if (controller.signal.aborted || statusGeneration !== menuGeneration) return;
			type Screen = "main";
			type Action = "refresh" | "close";
			const menu = defineMenu<undefined, Screen, Action, ExtensionCommandContext>({
				start: "main",
				screens: {
					main: () => ({
						kind: "actions",
						title: "Provider usage",
						lines: formatProviderStates(visibleStates).split("\n"),
						items: [
							{ id: "refresh", label: REFRESH_ALL, action: "refresh" },
							{ id: "close", label: CLOSE, close: true },
						],
						hint: "close",
					}),
				},
				actions: {
					refresh: async () => {
						const refreshed = await queryBothProviders(ctx, true, controller);
						if (!refreshed) return { kind: "stay" };
						visibleStates = refreshed;
						publishCurrentState(ctx, visibleStates);
						return { kind: "stay" };
					},
					close: () => ({ kind: "close" }),
				},
			});
			await runMenu(ctx, menu, {
				getState: () => undefined,
				signal: controller.signal,
				isCurrent: () => statusGeneration === menuGeneration && !controller.signal.aborted,
			});
		} finally {
			controller.abort(new DOMException("Usage menu closed", "AbortError"));
			activeControllers.delete(controller);
		}
	};

	pi.registerCommand("usage", {
		description: "Show usage for the current runtime accounts",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify(
					"/usage does not accept arguments; choose an action from its menu.",
					"warning",
				);
				return;
			}
			try {
				await showMenu(ctx);
			} catch (error) {
				if (isStaleExtensionContextError(error) || isAbortError(error)) return;
				throw error;
			}
		},
	});
	pi.on("session_start", (_event, ctx) => {
		statusGeneration += 1;
		clearStatusTimer();
		for (const controller of activeControllers) controller.abort();
		activeControllers.clear();
		statusController = undefined;
		sessionActive = true;
		startStatusRefresh(ctx, ctx.model, false);
	});
	pi.on("session_tree", (_event, ctx) => {
		startStatusRefresh(ctx, ctx.model, false);
	});
	pi.on("model_select", (event, ctx) => {
		startStatusRefresh(ctx, event.model, false);
	});
	pi.on("turn_start", (_event, ctx) => {
		startStatusRefresh(ctx, ctx.model, false);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		sessionActive = false;
		statusGeneration += 1;
		clearStatusTimer();
		for (const controller of activeControllers) controller.abort();
		activeControllers.clear();
		statusController = undefined;
		cache.clear();
		failureBackoff.clear();
		latestQueries.clear();
		activeCurrentIdentity = undefined;
		safeSetStatus(ctx, undefined);
	});
}