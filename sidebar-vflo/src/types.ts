export type SidebarPanelId = "model" | "activity" | "context" | "usage" | "todos" | "subagents";

export type ActivityState = "ready" | "working" | "warning" | "error";

export interface SidebarConfig {
	showSidebarOnStartup: boolean;
	width: number;
	panels: Record<SidebarPanelId, boolean>;
}

export interface TodoItem {
	id: number;
	subject: string;
	status: "pending" | "in_progress" | "completed";
}

export type SubagentStatus = "idle" | "blocked" | "done";

export interface SubagentItem {
	id: string;
	agent: string;
	task: string;
	status: SubagentStatus;
	sourceStatus: string;
}

export interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface ContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export interface ModelState {
	provider: string;
	id: string;
	name: string;
}

export interface ActivitySnapshot {
	state: ActivityState;
	label: string;
	activeTools: string[];
}

export interface SidebarSnapshot {
	model: ModelState | undefined;
	thinkingLevel: string | undefined;
	activity: ActivitySnapshot;
	context: ContextUsage | undefined;
	usage: TokenUsage;
	todos: TodoItem[];
	subagents: SubagentItem[];
}

export const DEFAULT_CONFIG: SidebarConfig = {
	showSidebarOnStartup: true,
	width: 44,
	panels: {
		model: true,
		activity: true,
		context: true,
		usage: true,
		todos: true,
		subagents: true,
	},
};
