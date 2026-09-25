import { describe, expect, it } from "vitest";
import { renderSidebar } from "../src/render.js";
import { applyTodoSnapshot, emptyTodoDisplay, todoDisplayFromBranch, visibleTodos } from "../src/todo-display.js";
import { DEFAULT_CONFIG, type TodoItem } from "../src/types.js";

const todo = (id: number, status: TodoItem["status"]): TodoItem => ({ id, subject: `Task ${id}`, status });
const assistant = (stopReason = "stop") => ({ type: "message", message: { role: "assistant", stopReason } });
const result = (tasks: TodoItem[], isError = false) => ({
	type: "message", message: { role: "toolResult", toolName: "todo", details: { tasks }, isError },
});

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

describe("sidebar todo display", () => {
	it("keeps active work inside the collapsed panel even after eight older tasks", () => {
		const state = emptyTodoDisplay();
		applyTodoSnapshot(state, [...Array.from({ length: 8 }, (_, index) => todo(index + 1, "completed")), todo(9, "in_progress")]);
		const todos = visibleTodos(state);
		const { lines } = renderSidebar(
			{
				model: undefined, thinkingLevel: undefined, context: undefined, diff: undefined,
				limits: { buckets: [] }, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				todos, subagents: [],
			},
			DEFAULT_CONFIG, theme, 44, 80,
		);
		expect(todos.map((item) => item.id)).toEqual([9, 1, 2, 3, 4, 5, 6, 7, 8]);
		expect(lines.some((line) => line.includes("Task 9"))).toBe(true);
		expect(lines.some((line) => line.includes("Task 8"))).toBe(false);
	});

	it("hides a completion after five subsequent turns, without deleting the source todo", () => {
		const state = emptyTodoDisplay();
		applyTodoSnapshot(state, [todo(1, "completed"), todo(2, "in_progress")]);
		state.turns += 1; // The turn that completed #1 does not count as a subsequent turn.
		for (let subsequent = 1; subsequent <= 4; subsequent += 1) {
			state.turns += 1;
			applyTodoSnapshot(state, [todo(1, "completed"), todo(2, "in_progress")]);
			expect(visibleTodos(state).map((item) => item.id)).toEqual([2, 1]);
		}
		state.turns += 1;
		expect(visibleTodos(state).map((item) => item.id)).toEqual([2]);
		expect(state.todos.map((item) => item.id)).toEqual([1, 2]);
	});

	it("resets completion age when a task is reopened or removed", () => {
		const state = emptyTodoDisplay();
		applyTodoSnapshot(state, [todo(1, "completed")]);
		state.turns = 8;
		expect(visibleTodos(state)).toEqual([]);
		applyTodoSnapshot(state, [todo(1, "pending")]);
		applyTodoSnapshot(state, [todo(1, "completed")]);
		expect(visibleTodos(state)).toEqual([todo(1, "completed")]);
		applyTodoSnapshot(state, []);
		state.turns = 16;
		applyTodoSnapshot(state, [todo(1, "completed")]);
		expect(visibleTodos(state)).toEqual([todo(1, "completed")]);
	});

	it("rebuilds ages from the current branch, ignoring failed and malformed results", () => {
		const start = [assistant(), result([todo(1, "completed")])];
		const fourLater = [
			...start,
			...Array.from({ length: 4 }, () => assistant()),
			assistant("aborted"),
			assistant("error"),
			result([], true),
			{ type: "message", message: { role: "toolResult", toolName: "todo", details: { tasks: "invalid" } } },
		];
		expect(visibleTodos(todoDisplayFromBranch(fourLater))).toEqual([todo(1, "completed")]);
		expect(visibleTodos(todoDisplayFromBranch([...fourLater, assistant()]))).toEqual([]);
		expect(todoDisplayFromBranch([...fourLater, result([])]).todos).toEqual([]);
		// Moving to a different branch must not carry an old branch's age.
		expect(visibleTodos(todoDisplayFromBranch([assistant(), result([todo(2, "pending")])]))).toEqual([todo(2, "pending")]);
	});
});
