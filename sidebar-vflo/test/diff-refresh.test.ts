import { afterEach, describe, expect, it, vi } from "vitest";
import { createDiffRefreshController, DIFF_REFRESH_INTERVAL_MS } from "../src/diff-refresh.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("Diff refresh cadence", () => {
	it("polls again five minutes after a completed refresh", async () => {
		vi.useFakeTimers();
		const refresh = vi.fn();
		const controller = createDiffRefreshController(refresh);

		controller.setActive(true);
		expect(refresh).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(0);

		await vi.advanceTimersByTimeAsync(DIFF_REFRESH_INTERVAL_MS - 1);
		expect(refresh).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(refresh).toHaveBeenCalledTimes(2);

		controller.dispose();
	});

	it("lets agent idle bypass the cooldown and coalesces idle events during a read", async () => {
		vi.useFakeTimers();
		const second = deferred();
		const refresh = vi.fn()
			.mockImplementationOnce(() => undefined)
			.mockImplementationOnce(() => second.promise);
		const controller = createDiffRefreshController(refresh);

		controller.setActive(true);
		await vi.advanceTimersByTimeAsync(0);
		controller.agentSettled();
		expect(refresh).toHaveBeenCalledTimes(2);
		controller.agentSettled();
		controller.agentSettled();

		second.resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(refresh).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(0);

		controller.dispose();
	});

	it("honors the cooldown after reactivation and never overlaps a timer read", async () => {
		vi.useFakeTimers();
		const second = deferred();
		const refresh = vi.fn()
			.mockImplementationOnce(() => undefined)
			.mockImplementationOnce(() => second.promise)
			.mockImplementation(() => undefined);
		const controller = createDiffRefreshController(refresh);

		controller.setActive(true);
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(DIFF_REFRESH_INTERVAL_MS - 1_000);
		controller.agentSettled();
		expect(refresh).toHaveBeenCalledTimes(2);

		// Hiding and showing again must not start another read before the
		// existing cooldown. The timer can become due while the idle read runs.
		controller.setActive(false);
		controller.setActive(true);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(refresh).toHaveBeenCalledTimes(2);

		second.resolve();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(DIFF_REFRESH_INTERVAL_MS - 1);
		expect(refresh).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(refresh).toHaveBeenCalledTimes(3);

		controller.dispose();
	});

	it("starts a new cooldown after a failed read", async () => {
		vi.useFakeTimers();
		const refresh = vi.fn().mockRejectedValueOnce(new Error("git failed"));
		const controller = createDiffRefreshController(refresh);

		controller.setActive(true);
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(DIFF_REFRESH_INTERVAL_MS);
		expect(refresh).toHaveBeenCalledTimes(2);

		controller.dispose();
	});

	it("cancels scheduled work when deactivated or disposed", async () => {
		vi.useFakeTimers();
		const refresh = vi.fn();
		const controller = createDiffRefreshController(refresh);

		controller.setActive(true);
		await vi.advanceTimersByTimeAsync(0);
		controller.setActive(false);
		await vi.advanceTimersByTimeAsync(DIFF_REFRESH_INTERVAL_MS / 2);
		expect(refresh).toHaveBeenCalledTimes(1);

		controller.setActive(true);
		controller.dispose();
		await vi.advanceTimersByTimeAsync(DIFF_REFRESH_INTERVAL_MS);
		expect(refresh).toHaveBeenCalledTimes(1);
	});
});
