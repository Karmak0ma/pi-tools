import type { SidebarColorPreset, SidebarConfig, SidebarPanelId, SidebarSnapshot, SubagentItem, TodoItem, TokenUsage } from "./types.js";

const TODO_STATUSES = new Set(["pending", "in_progress", "completed"]);
const SUBAGENT_STATUSES = new Set(["queued", "running", "completed", "error", "aborted"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const finite = (value: unknown): number =>
	typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;

export function normalizeTodoDetails(details: unknown): TodoItem[] | undefined {
	if (!isRecord(details) || typeof details.error === "string") return undefined;
	if (!Array.isArray(details.tasks)) return undefined;
	const tasks: TodoItem[] = [];
	for (const task of details.tasks) {
		if (
			!isRecord(task) ||
			typeof task.id !== "number" ||
			!Number.isFinite(task.id) ||
			typeof task.subject !== "string"
		)
			return undefined;
		if (typeof task.status !== "string") return undefined;
		if (task.status === "deleted") continue;
		if (!TODO_STATUSES.has(task.status)) return undefined;
		tasks.push({
			id: Math.max(0, Math.trunc(task.id)),
			subject: task.subject,
			status: task.status as TodoItem["status"],
		});
	}
	return tasks;
}

function subagentDisplayStatus(status: unknown, failed = false): SubagentItem["status"] {
	if (failed || status === "error" || status === "aborted") return "blocked";
	if (status === "completed") return "done";
	// subagents-vflo exposes queued/running, but not a blocked state. The
	// sidebar reserves "blocked" for failed/aborted work and labels all
	// non-blocked work idle, including work currently running in a child.
	return "idle";
}

function safeString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

export function subagentItemsFromStart(
	toolCallId: string,
	args: unknown,
): SubagentItem[] {
	if (!isRecord(args) || !Array.isArray(args.tasks)) return [];
	return args.tasks.flatMap((task, index) => {
		if (!isRecord(task) || typeof task.agent !== "string") return [];
		return [
			{
				id: `${toolCallId}:${index + 1}`,
				agent: task.agent,
				task: safeString(task.task),
				status: "idle" as const,
				sourceStatus: "queued",
			},
		];
	});
}

function isTaskDetails(details: unknown): details is { mode: "tasks"; summaries: unknown[] } {
	return isRecord(details) && details.mode === "tasks" && Array.isArray(details.summaries);
}

export function applySubagentDetails(
	current: SubagentItem[],
	details: unknown,
): SubagentItem[] {
	if (!isTaskDetails(details)) return current;
	const next = current.map((item) => ({ ...item }));
	for (const [index, raw] of details.summaries.entries()) {
		if (!isRecord(raw)) continue;
		const rawId = typeof raw.id === "string" || typeof raw.id === "number" ? String(raw.id) : undefined;
		const itemIndex = rawId
			? next.findIndex((item) => item.id.endsWith(`:${rawId}`) || item.id === rawId)
			: index < next.length
				? index
				: -1;
		if (itemIndex < 0) continue;
		const item = next[itemIndex];
		if (!item) continue;
		const rawStatus = raw.status;
		const failed = raw.failed === true || typeof raw.errorMessage === "string";
		next[itemIndex] = {
			...item,
			agent: safeString(raw.agent) || item.agent,
			task: safeString(raw.task) || item.task,
			status: subagentDisplayStatus(rawStatus, failed),
			sourceStatus:
				typeof rawStatus === "string" && SUBAGENT_STATUSES.has(rawStatus) ? rawStatus : item.sourceStatus,
		};
	}
	return next;
}

export function finishSubagents(current: SubagentItem[], failed: boolean): SubagentItem[] {
	return current.map((item) => ({
		...item,
		status: failed || item.status === "blocked" ? "blocked" : "done",
		sourceStatus: failed ? "error" : "completed",
	}));
}

export function sumBranchUsage(branch: readonly unknown[]): TokenUsage {
	const usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	for (const entry of branch) {
		if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
		if (entry.message.role !== "assistant" || !isRecord(entry.message.usage)) continue;
		usage.input += finite(entry.message.usage.input);
		usage.output += finite(entry.message.usage.output);
		usage.cacheRead += finite(entry.message.usage.cacheRead);
		usage.cacheWrite += finite(entry.message.usage.cacheWrite);
	}
	return usage;
}

export function panelEnabled(config: SidebarConfig, panel: SidebarPanelId): boolean {
	return config.panels[panel];
}

export function parseConfig(value: unknown, fallback: SidebarConfig): SidebarConfig {
	if (!isRecord(value)) return { ...fallback, panels: { ...fallback.panels } };
	const panels = { ...fallback.panels };
	if (isRecord(value.panels)) {
		for (const panel of Object.keys(panels) as SidebarPanelId[]) {
			if (typeof value.panels[panel] === "boolean") panels[panel] = value.panels[panel] as boolean;
		}
	}
	const width = typeof value.width === "number" && Number.isFinite(value.width) ? Math.trunc(value.width) : fallback.width;
	const colorPreset: SidebarColorPreset = value.colorPreset === "catppuccin" || value.colorPreset === "dracula" || value.colorPreset === "monokai"
		? value.colorPreset
		: fallback.colorPreset;
	return {
		showSidebarOnStartup:
			typeof value.showSidebarOnStartup === "boolean" ? value.showSidebarOnStartup : fallback.showSidebarOnStartup,
		colorPreset,
		width: Math.min(72, Math.max(28, width)),
		panels,
	};
}

export function emptySnapshot(): SidebarSnapshot {
	return {
		model: undefined,
		thinkingLevel: undefined,
		activity: { state: "ready", label: "Ready", activeTools: [] },
		context: undefined,
		limits: { buckets: [] },
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		todos: [],
		subagents: [],
	};
}
