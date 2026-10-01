import { cancelTimer } from "./timers.js";

export const DIFF_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

interface DiffRefreshController {
	setActive(active: boolean): void;
	agentSettled(): void;
	dispose(): void;
}

interface RefreshState {
	refresh: () => void | Promise<void>;
	intervalMs: number;
	active: boolean;
	disposed: boolean;
	running: boolean;
	idleRefreshQueued: boolean;
	lastRefreshCompletedAt?: number;
	timer?: NodeJS.Timeout;
}

function clearTimer(state: RefreshState): void {
	cancelTimer(state.timer);
	state.timer = undefined;
}

function finishRefresh(state: RefreshState): void {
	state.running = false;
	state.lastRefreshCompletedAt = Date.now();
	if (!state.active || state.disposed) return;
	if (state.idleRefreshQueued) {
		state.idleRefreshQueued = false;
		startRefresh(state);
	} else {
		scheduleTimer(state);
	}
}

function startRefresh(state: RefreshState): void {
	if (!state.active || state.disposed || state.running) return;
	clearTimer(state);
	state.running = true;

	let work: Promise<void>;
	try {
		work = Promise.resolve(state.refresh());
	} catch (error) {
		work = Promise.reject(error);
	}
	// Diff is best-effort display data. A failed read still completes its
	// cooldown; an idle event can retry sooner.
	void work.catch(() => undefined).finally(() => finishRefresh(state));
}

function scheduleTimer(state: RefreshState): void {
	clearTimer(state);
	if (!state.active || state.disposed) return;

	// Measure from completion so a slow git/LFS run cannot consume the cooldown.
	const delay = state.lastRefreshCompletedAt === undefined
		? 0
		: Math.max(0, state.lastRefreshCompletedAt + state.intervalMs - Date.now());
	state.timer = setTimeout(() => {
		state.timer = undefined;
		// A reactivation timer may become due during a read. Drop it; completion
		// will schedule the next timer from the new finish time.
		if (state.active && !state.disposed && !state.running) startRefresh(state);
	}, delay);
	state.timer.unref();
}

function setActive(state: RefreshState, active: boolean): void {
	if (state.disposed || state.active === active) return;
	state.active = active;
	if (!active) {
		clearTimer(state);
		state.idleRefreshQueued = false;
		return;
	}

	// Seed on first activation. Later show/enable transitions honor cooldown.
	if (state.lastRefreshCompletedAt === undefined || Date.now() >= state.lastRefreshCompletedAt + state.intervalMs) {
		startRefresh(state);
	} else {
		scheduleTimer(state);
	}
}

function agentSettled(state: RefreshState): void {
	if (!state.active || state.disposed) return;
	if (state.running) {
		// Multiple idle events during a read need only one follow-up.
		state.idleRefreshQueued = true;
	} else {
		startRefresh(state);
	}
}

function dispose(state: RefreshState): void {
	state.disposed = true;
	state.active = false;
	state.idleRefreshQueued = false;
	clearTimer(state);
}

export function createDiffRefreshController(
	refresh: () => void | Promise<void>,
	intervalMs = DIFF_REFRESH_INTERVAL_MS,
): DiffRefreshController {
	const state: RefreshState = {
		refresh,
		intervalMs,
		active: false,
		disposed: false,
		running: false,
		idleRefreshQueued: false,
	};
	return {
		setActive: (active) => setActive(state, active),
		agentSettled: () => agentSettled(state),
		dispose: () => dispose(state),
	};
}
