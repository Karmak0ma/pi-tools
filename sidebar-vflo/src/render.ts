import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { SidebarConfig, SidebarPanelId, SidebarSnapshot, SubagentItem, TodoItem } from "./types.js";

export interface SidebarTheme {
	fg(color: ThemeColor, text: string): string;
	bold(text: string): string;
	preset?: "monokai" | "catppuccin" | "dracula";
}

type Role = "text" | "muted" | "dim" | "accent" | "working" | "success" | "warning" | "error" | "input" | "output" | "cache";

const colors: Record<Role, ThemeColor> = {
	text: "text",
	muted: "muted",
	dim: "dim",
	accent: "accent",
	working: "thinkingHigh",
	success: "success",
	warning: "warning",
	error: "error",
	input: "thinkingLow",
	output: "thinkingHigh",
	cache: "syntaxType",
};

const PRESET_CODES: Record<NonNullable<SidebarTheme["preset"]>, Record<Role, number>> = {
	monokai: { text: 252, muted: 245, dim: 240, accent: 148, working: 208, success: 148, warning: 221, error: 197, input: 81, output: 141, cache: 115 },
	catppuccin: { text: 189, muted: 146, dim: 103, accent: 183, working: 215, success: 151, warning: 221, error: 210, input: 117, output: 176, cache: 152 },
	dracula: { text: 253, muted: 146, dim: 61, accent: 141, working: 212, success: 84, warning: 228, error: 203, input: 117, output: 212, cache: 141 },
};

const paint = (theme: SidebarTheme, role: Role, text: string): string => {
	const preset = theme.preset;
	return preset ? `\u001b[38;5;${PRESET_CODES[preset][role]}m${text}\u001b[39m` : theme.fg(colors[role], text);
};
const clean = (value: string): string => value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
const safe = (value: unknown, fallback = "—"): string => {
	const text = typeof value === "string" ? clean(value) : "";
	return text || fallback;
};

export function formatTokens(value: number): string {
	const count = Number.isFinite(value) ? Math.max(0, value) : 0;
	if (count < 1_000) return Math.trunc(count).toString();
	if (count < 1_000_000) return `${(count / 1_000).toFixed(count < 10_000 ? 1 : 0)}k`;
	if (count < 1_000_000_000) return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 1 : 0)}M`;
	return `${(count / 1_000_000_000).toFixed(1)}B`;
}

function pad(text: string, width: number): string {
	const value = truncateToWidth(text, Math.max(0, width), "");
	return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

function pair(left: string, right: string, width: number): string {
	const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
	return truncateToWidth(`${left}${" ".repeat(gap)}${right}`, width, "");
}

function statusRole(status: string): Role {
	if (status === "done") return "success";
	if (status === "blocked") return "error";
	return "working";
}

function modelRows(snapshot: SidebarSnapshot, theme: SidebarTheme, width: number): string[] {
	if (!snapshot.model) return [paint(theme, "dim", "No model selected")];
	const model = snapshot.model.id || snapshot.model.name || "unknown";
	return [
		paint(theme, "text", truncateToWidth(model, width, "")),
		paint(theme, "muted", truncateToWidth(snapshot.model.provider || "unknown provider", width, "")),
		pair(paint(theme, "muted", "Thinking"), paint(theme, "accent", safe(snapshot.thinkingLevel, "off")), width),
		...(snapshot.model.subscriptionRemaining === undefined
			? []
			: [pair(paint(theme, "muted", "Subscription"), paint(theme, "accent", `${snapshot.model.subscriptionRemaining.toFixed(1)}% left`), width)]),
	];
}

function activityRows(snapshot: SidebarSnapshot, theme: SidebarTheme, width: number): string[] {
	const state = snapshot.activity.state;
	const role: Role = state === "error" ? "error" : state === "warning" ? "warning" : state === "working" ? "working" : "success";
	const symbol = state === "error" ? "✕" : state === "warning" ? "▲" : state === "working" ? "◆" : "●";
	const rows = [theme.bold(paint(theme, role, `${symbol} ${safe(snapshot.activity.label, state)}`))];
	for (const tool of snapshot.activity.activeTools.slice(0, 3)) rows.push(paint(theme, "muted", `Tool · ${safe(tool)}`));
	return rows;
}

function contextRows(snapshot: SidebarSnapshot, theme: SidebarTheme, width: number): string[] {
	const usage = snapshot.context;
	if (!usage) return [paint(theme, "dim", "Context unavailable")];
	const percent = usage.percent === null || !Number.isFinite(usage.percent) ? null : Math.max(0, Math.min(100, usage.percent));
	const percentText = percent === null ? "?" : `${percent.toFixed(1)}%`;
	const tokenText = usage.tokens === null ? "?" : formatTokens(usage.tokens);
	const maxText = usage.contextWindow > 0 ? formatTokens(usage.contextWindow) : "—";
	const role: Role = percent !== null && percent > 60 ? "error" : percent !== null && percent > 40 ? "warning" : "accent";
	const meterWidth = Math.max(4, Math.min(18, width - 4));
	const filled = percent === null ? 0 : Math.round((percent / 100) * meterWidth);
	return [
		pair(paint(theme, role, `${tokenText} / ${maxText}`), paint(theme, role, percentText), width),
		paint(theme, "dim", "[") + paint(theme, role, "■".repeat(filled)) + paint(theme, "dim", "·".repeat(meterWidth - filled) + "]"),
	];
}

function usageRows(snapshot: SidebarSnapshot, theme: SidebarTheme, width: number): string[] {
	const usage = snapshot.usage;
	const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
	const hit = prompt > 0 ? (usage.cacheRead / prompt) * 100 : null;
	return [
		pair(paint(theme, "muted", "In"), paint(theme, "input", formatTokens(usage.input)), width),
		pair(paint(theme, "muted", "Out"), paint(theme, "output", formatTokens(usage.output)), width),
		pair(paint(theme, "muted", "Cache"), paint(theme, "cache", formatTokens(usage.cacheRead)), width),
		pair(paint(theme, "muted", "Hit"), paint(theme, hit === null ? "dim" : "cache", hit === null ? "—" : `${hit.toFixed(1)}%`), width),
	];
}

function todoRows(todos: readonly TodoItem[], theme: SidebarTheme, width: number): string[] {
	if (todos.length === 0) return [paint(theme, "dim", "No tasks")];
	const done = todos.filter((todo) => todo.status === "completed").length;
	const rows = [paint(theme, "muted", `${done}/${todos.length} done`)];
	for (const todo of todos.slice(0, 8)) {
		const role: Role = todo.status === "completed" ? "dim" : todo.status === "in_progress" ? "warning" : "text";
		const marker = todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "◐" : "○";
		rows.push(truncateToWidth(`${paint(theme, role, marker)} ${paint(theme, "accent", `#${todo.id}`)} ${paint(theme, role, safe(todo.subject))}`, width, ""));
	}
	if (todos.length > 8) rows.push(paint(theme, "dim", `… ${todos.length - 8} more`));
	return rows;
}

function subagentRows(items: readonly SubagentItem[], theme: SidebarTheme, width: number): string[] {
	if (items.length === 0) return [paint(theme, "dim", "No active subagents")];
	return items.slice(0, 8).flatMap((item) => {
		const role = statusRole(item.status);
		const head = `${paint(theme, role, item.status === "done" ? "✓" : item.status === "blocked" ? "✕" : "●")} ${paint(theme, "text", safe(item.agent))}`;
		const status = paint(theme, role, item.status);
		const detail = item.task ? paint(theme, "dim", ` · ${safe(item.task)}`) : "";
		return [truncateToWidth(pair(head + detail, status, width), width, "")];
	});
}

function panel(title: string, rows: readonly string[], width: number, theme: SidebarTheme): string[] {
	const inner = Math.max(1, width - 4);
	const titleText = ` ${title.toUpperCase()} `;
	const topFill = Math.max(0, width - visibleWidth(titleText) - 4);
	const top = `${paint(theme, "accent", `╭─${titleText}${"─".repeat(topFill)}╮`)}`;
	const body = rows.map((row) => `${paint(theme, "dim", "│")} ${pad(row, inner)} ${paint(theme, "dim", "│")}`);
	return [top, ...body, paint(theme, "dim", `╰${"─".repeat(Math.max(0, width - 2))}╯`), ""];
}

interface PanelDefinition {
	id: SidebarPanelId;
	title: string;
	rows: string[];
	required: boolean;
}

export function renderSidebar(
	snapshot: SidebarSnapshot,
	config: SidebarConfig,
	theme: SidebarTheme,
	width: number,
	height: number,
): string[] {
	const safeWidth = Math.max(4, Math.trunc(width));
	const safeHeight = Math.max(0, Math.trunc(height));
	if (safeHeight === 0) return [];
	const contentWidth = Math.max(2, safeWidth - 2);
	const panelContentWidth = Math.max(1, contentWidth - 4);
	const definitions: PanelDefinition[] = [
		{ id: "model" as const, title: "Model", rows: modelRows(snapshot, theme, panelContentWidth), required: true },
		{ id: "activity" as const, title: "Activity", rows: activityRows(snapshot, theme, panelContentWidth), required: true },
		{ id: "context" as const, title: "Context", rows: contextRows(snapshot, theme, panelContentWidth), required: true },
		{ id: "usage" as const, title: "Session usage", rows: usageRows(snapshot, theme, panelContentWidth), required: false },
		{ id: "todos" as const, title: "Todos", rows: todoRows(snapshot.todos, theme, panelContentWidth), required: false },
		{ id: "subagents" as const, title: "Subagents", rows: subagentRows(snapshot.subagents, theme, panelContentWidth), required: false },
	].filter((definition) => config.panels[definition.id]);

	let selected = [...definitions];
	const renderedLength = (items: readonly PanelDefinition[]) => items.reduce((total, item) => total + panel(item.title, item.rows, contentWidth, theme).length, 0);
	while (renderedLength(selected) > safeHeight) {
		const index = [...selected].reverse().findIndex((item) => !item.required);
		if (index < 0) break;
		selected.splice(selected.length - 1 - index, 1);
	}
	const lines = selected.flatMap((item) => panel(item.title, item.rows, contentWidth, theme));
	return Array.from({ length: safeHeight }, (_, index) => {
		const line = truncateToWidth(lines[index] ?? "", contentWidth, "");
		return `${paint(theme, "dim", "│")} ${pad(line, contentWidth)}`;
	});
}
