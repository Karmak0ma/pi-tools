import { describe, expect, it } from "vitest";
import {
	applySubagentDetails,
	finishSubagents,
	normalizeTodoDetails,
	subagentItemsFromStart,
	sumBranchUsage,
} from "../src/state.js";


describe("Sidebar VFLO state adapters", () => {
	it("normalizes rpiv-todo task details and ignores deleted tasks", () => {
		expect(
			normalizeTodoDetails({
			action: "list",
			tasks: [
				{ id: 1, subject: "Ship sidebar", status: "in_progress" },
				{ id: 2, subject: "Old", status: "deleted" },
			],
		}),
		).toEqual([{ id: 1, subject: "Ship sidebar", status: "in_progress" }]);
		expect(normalizeTodoDetails({ tasks: [], error: "bad" })).toBeUndefined();
		expect(normalizeTodoDetails({ tasks: [{ id: 1, subject: "bad", status: "unknown" }] })).toBeUndefined();
		expect(normalizeTodoDetails({ tasks: [] })).toEqual([]);
	});

	it("sums assistant usage across the current branch", () => {
		expect(
			sumBranchUsage([
				{ type: "message", message: { role: "assistant", usage: { input: 10, output: 4, cacheRead: 6, cacheWrite: 2 } } },
				{ type: "message", message: { role: "user" } },
				{ type: "message", message: { role: "assistant", usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 1 } } },
			]),
		).toEqual({ input: 13, output: 6, cacheRead: 6, cacheWrite: 3 });
	});

	it("adapts subagents-vflo live and final statuses", () => {
		const initial = subagentItemsFromStart("call", { tasks: [{ agent: "explore", task: "Inspect" }] });
		expect(initial[0]?.status).toBe("idle");
		const live = applySubagentDetails(initial, {
			mode: "tasks",
			live: true,
			summaries: [{ id: 1, status: "running", agent: "explore", task: "Inspect" }],
		});
		expect(live[0]?.status).toBe("idle");
		const failed = applySubagentDetails(live, {
			mode: "tasks",
			summaries: [{ id: 1, failed: true, errorMessage: "stopped" }],
		});
		expect(finishSubagents(failed, false)[0]?.status).toBe("blocked");
	});
});
