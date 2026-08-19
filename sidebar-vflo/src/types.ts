export type SidebarPanelId = "model" | "activity" | "context" | "limits" | "usage" | "todos" | "subagents";
export type SidebarColorPreset = "monokai" | "catppuccin" | "dracula";

export type ActivityState = "ready" | "working" | "warning" | "error";

export interface SidebarConfig {
	showSidebarOnStartup: boolean;
	colorPreset: SidebarColorPreset;
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

// One consumption bucket reported by a subscription provider (e.g. Anthropic's
// 5-hour and weekly windows, or Codex's primary/secondary limits). `remaining`
// is a percentage (0-100) of the bucket left before the limit resets.
export interface SubscriptionBucket {
	id: string;
	label: string;
	remaining: number;
	windowMinutes?: number;
}

// What the Limits panel should display right now.
//
// `buckets` empty AND `note` undefined means "this provider has no
// subscription windows" (e.g. plain API-key billing) and the panel is hidden.
// For a subscription provider the panel is always rendered: `note` carries the
// reason when numbers are missing or stale, because hiding the box silently is
// what made a broken refresh invisible.
export interface LimitsState {
	buckets: SubscriptionBucket[];
	note?: string;
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
	// Subscription rate-limit state for the current model/provider.
	limits: LimitsState;
	usage: TokenUsage;
	todos: TodoItem[];
	subagents: SubagentItem[];
}

export const DEFAULT_CONFIG: SidebarConfig = {
	showSidebarOnStartup: true,
	colorPreset: "monokai",
	width: 44,
	panels: {
		model: true,
		activity: true,
		context: true,
		limits: true,
		usage: true,
		todos: true,
		subagents: true,
	},
};
