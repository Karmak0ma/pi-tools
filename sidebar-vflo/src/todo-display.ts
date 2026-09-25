import { normalizeTodoDetails } from "./state.js";
import type { TodoItem } from "./types.js";

// Age only the sidebar's copy of a completed task. The todo tool still owns
// the full task list, including tasks that this panel no longer shows.
export const COMPLETED_TODO_TURNS = 5;

export interface TodoDisplayState {
	turns: number;
	todos: TodoItem[];
	completedAt: Map<number, number>;
}

export function emptyTodoDisplay(): TodoDisplayState {
	return { turns: 0, todos: [], completedAt: new Map() };
}

export function applyTodoSnapshot(state: TodoDisplayState, todos: TodoItem[], completionTurn = state.turns + 1): void {
	const previous = state.completedAt;
	const completedAt = new Map<number, number>();
	for (const todo of todos) {
		if (todo.status === "completed") {
			// Repeated 'list' results must not make an old completion young again.
			// A task that was reopened (or removed) has no age to retain.
			completedAt.set(todo.id, previous.get(todo.id) ?? completionTurn);
		}
	}
	state.todos = todos;
	state.completedAt = completedAt;
}

export function visibleTodos(state: TodoDisplayState): TodoItem[] {
	const active: TodoItem[] = [];
	const recent: TodoItem[] = [];
	for (const todo of state.todos) {
		if (todo.status !== "completed") {
			active.push(todo);
		} else if (state.turns - (state.completedAt.get(todo.id) ?? state.turns) < COMPLETED_TODO_TURNS) {
			recent.push(todo);
		}
	}
	// The collapsed panel shows the first eight rows. Keep active work ahead
	// of completed work without changing order inside either group.
	return [...active, ...recent];
}

function branchMessage(entry: unknown): Record<string, unknown> | undefined {
	if (typeof entry !== "object" || entry === null || !("type" in entry) || entry.type !== "message" ||
		!("message" in entry)) return undefined;
	const message = entry.message;
	return typeof message === "object" && message !== null ? message as Record<string, unknown> : undefined;
}

export function todoDisplayFromBranch(branch: readonly unknown[]): TodoDisplayState {
	const state = emptyTodoDisplay();
	for (const entry of branch) {
		const message = branchMessage(entry);
		if (!message) continue;
		// An assistant message represents one turn on the saved branch. Its tool
		// results follow it, so a completion in those results starts at this
		// turn, not at the next one. Live tool results arrive before turn_end.
		if (message.role === "assistant") {
			// Failed or cancelled responses do not finish a work turn. Keep
			// branch replay in step with the live turn_end handler.
			if (message.stopReason !== "aborted" && message.stopReason !== "error") {
				state.turns += 1;
			}
			continue;
		}
		if (message.role !== "toolResult" || message.toolName !== "todo" || message.isError === true) continue;
		const todos = normalizeTodoDetails(message.details);
		if (todos !== undefined) applyTodoSnapshot(state, todos, state.turns);
	}
	return state;
}
