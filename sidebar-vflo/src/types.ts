export type SidebarPanelId = "model" | "context" | "limits" | "usage" | "todos" | "subagents" | "diff";
// Panels whose list can be expanded/collapsed by clicking on them.
export type ExpandablePanelId = "todos" | "diff";
export type SidebarColorPreset = "monokai" | "catppuccin" | "dracula";

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
// 5-hour and weekly windows used by Anthropic and OpenAI Codex). `remaining`
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

// One changed file in the working tree, relative to HEAD.
//
// `added`/`removed` are null when git gives no line counts: binary files, and
// untracked files. Untracked files are listed but their lines are NOT counted
// on purpose: counting would mean reading every new file after every tool run,
// and an un-ignored build folder could make that very slow.
export interface DiffFile {
	path: string;
	added: number | null;
	removed: number | null;
	untracked: boolean;
}

// What the Diff panel shows. The snapshot holds `undefined` instead of this
// when the session folder is not a git repository (or git is missing); the
// panel is then hidden, because "no changes" would be a false statement.
export interface DiffSummary {
	files: DiffFile[];
}

export interface SidebarSnapshot {
	model: ModelState | undefined;
	thinkingLevel: string | undefined;
	context: ContextUsage | undefined;
	// Subscription rate-limit state for the current model/provider.
	limits: LimitsState;
	usage: TokenUsage;
	todos: TodoItem[];
	subagents: SubagentItem[];
	diff: DiffSummary | undefined;
}

export const DEFAULT_CONFIG: SidebarConfig = {
	showSidebarOnStartup: true,
	colorPreset: "monokai",
	width: 44,
	panels: {
		model: true,
		context: true,
		limits: true,
		usage: true,
		todos: true,
		subagents: true,
		diff: true,
	},
};
