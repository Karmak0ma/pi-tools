import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type {
	DiffSummary,
	ExpandablePanelId,
	LimitsState,
	SidebarConfig,
	SidebarPanelId,
	SidebarSnapshot,
	SubagentItem,
	TodoItem,
} from "./types.js";

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

type PresetColor = number | `#${string}`;

// Sonokai Andromeda, matching the user's active Neovim colorscheme.
// Keep these as truecolor values so the sidebar matches the selected palette exactly.
const PRESET_COLORS: Record<NonNullable<SidebarTheme["preset"]>, Record<Role, PresetColor>> = {
	monokai: {
		text: "#E1E3E4",
		muted: "#7E8294",
		dim: "#5A5E7A",
		accent: "#6DCAE8",
		working: "#EDC763",
		success: "#9ED06C",
		warning: "#EDC763",
		error: "#FB617E",
		input: "#77D5F0",
		output: "#BB97EE",
		cache: "#9ED06C",
	},
	catppuccin: { text: 189, muted: 146, dim: 103, accent: 183, working: 215, success: 151, warning: 221, error: 210, input: 117, output: 176, cache: 152 },
	dracula: { text: 253, muted: 146, dim: 61, accent: 141, working: 212, success: 84, warning: 228, error: 203, input: 117, output: 212, cache: 141 },
};

const truecolor = (hex: `#${string}`, text: string): string => {
	const value = hex.slice(1);
	const red = Number.parseInt(value.slice(0, 2), 16);
	const green = Number.parseInt(value.slice(2, 4), 16);
	const blue = Number.parseInt(value.slice(4, 6), 16);
	return `\u001b[38;2;${red};${green};${blue}m${text}\u001b[39m`;
};

const paint = (theme: SidebarTheme, role: Role, text: string): string => {
	const preset = theme.preset;
	if (!preset) return theme.fg(colors[role], text);
	const color = PRESET_COLORS[preset][role];
	return typeof color === "number" ? `\u001b[38;5;${color}m${text}\u001b[39m` : truecolor(color, text);
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

// pi-tui's truncateToWidth() has a fast path only for pure printable ASCII
// (see utils.js isPrintableAscii). Every sidebar row carries SGR colour codes,
// so each call falls into the per-grapheme Intl.Segmenter loop and costs about
// 26 us, against 0.12 us for the ASCII path. The sidebar re-renders on every
// keystroke, so ~120 of those calls per frame were ~3.2 ms of input latency.
//
// visibleWidth() is cheap on coloured text (~0.04 us), so measure first and
// only pay for truncation when the text really does not fit. Callers must use
// fit() instead of truncateToWidth() for anything that may contain colour.
function fit(text: string, width: number): string {
	if (width <= 0) return "";
	return visibleWidth(text) <= width ? text : truncateToWidth(text, width, "");
}

function pad(text: string, width: number): string {
	const target = Math.max(0, width);
	// One width measurement serves both the fit test and the padding amount.
	const textWidth = visibleWidth(text);
	if (textWidth <= target) return text + " ".repeat(target - textWidth);
	const value = truncateToWidth(text, target, "");
	return value + " ".repeat(Math.max(0, target - visibleWidth(value)));
}

function pair(left: string, right: string, width: number): string {
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	const gap = Math.max(1, width - leftWidth - rightWidth);
	const line = `${left}${" ".repeat(gap)}${right}`;
	// The gap is sized so the result is exactly `width` whenever the two sides
	// fit. Only the overflow case (gap clamped to 1) needs real truncation.
	if (leftWidth + rightWidth + 1 <= width) return line;
	return truncateToWidth(line, width, "");
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
		paint(theme, "text", fit(model, width)),
		paint(theme, "muted", fit(snapshot.model.provider || "unknown provider", width)),
		pair(paint(theme, "muted", "Thinking"), paint(theme, "accent", safe(snapshot.thinkingLevel, "off")), width),
	];
}

// Subscription rate-limit meters (e.g. Anthropic's 5-hour and weekly windows).
// Each bucket gets its own label/percentage pair plus a bar that EMPTIES as
// the remaining allowance shrinks — the opposite direction of the context
// bar, which fills as usage grows. Low remaining is the "bad" end here, so
// the color thresholds are inverted relative to contextRows().
function limitsRows(limits: LimitsState, theme: SidebarTheme, width: number): string[] {
	const { buckets, note } = limits;
	// The note explains missing or stale data ("Waiting for usage data…",
	// "refresh failed: …"). It is rendered even when bars exist, so the user can
	// see that the numbers below are frozen.
	const noteRows = note === undefined ? [] : [paint(theme, "dim", fit(note, width))];
	if (buckets.length === 0) return noteRows.length > 0 ? noteRows : [paint(theme, "dim", "No subscription data")];
	const meterWidth = Math.max(4, Math.min(18, width - 4));
	return buckets.flatMap((bucket) => {
		const remaining = Math.max(0, Math.min(100, bucket.remaining));
		const role: Role = remaining < 20 ? "error" : remaining < 40 ? "warning" : "accent";
		const filled = Math.round((remaining / 100) * meterWidth);
		return [
			pair(paint(theme, "muted", safe(bucket.label)), paint(theme, role, `${remaining.toFixed(1)}%`), width),
			paint(theme, "dim", "[") + paint(theme, role, "■".repeat(filled)) + paint(theme, "dim", "·".repeat(meterWidth - filled) + "]"),
		];
	}).concat(noteRows);
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

// `expanded` is driven by a mouse click on the panel (index.ts). When
// false, the list caps at 8 items (existing compact behavior) so the panel
// does not dominate a short terminal. When true, every todo is emitted; the
// final safeHeight-based clipping in renderSidebar() still protects against
// overflowing a short terminal, so no extra bookkeeping is needed here.
function todoRows(todos: readonly TodoItem[], theme: SidebarTheme, width: number, expanded: boolean): string[] {
	if (todos.length === 0) return [paint(theme, "dim", "No tasks")];
	const done = todos.filter((todo) => todo.status === "completed").length;
	const rows = [paint(theme, "muted", `${done}/${todos.length} done`)];
	const visible = expanded ? todos : todos.slice(0, 8);
	for (const todo of visible) {
		const role: Role = todo.status === "completed" ? "dim" : todo.status === "in_progress" ? "warning" : "text";
		const marker = todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "◐" : "○";
		rows.push(fit(`${paint(theme, role, marker)} ${paint(theme, "accent", `#${todo.id}`)} ${paint(theme, role, safe(todo.subject))}`, width));
	}
	if (!expanded && todos.length > 8) rows.push(paint(theme, "dim", `… ${todos.length - 8} more (click to expand)`));
	return rows;
}

function subagentRows(items: readonly SubagentItem[], theme: SidebarTheme, width: number): string[] {
	if (items.length === 0) return [paint(theme, "dim", "No active subagents")];
	return items.slice(0, 8).flatMap((item) => {
		const role = statusRole(item.status);
		const head = `${paint(theme, role, item.status === "done" ? "✓" : item.status === "blocked" ? "✕" : "●")} ${paint(theme, "text", safe(item.agent))}`;
		const status = paint(theme, role, item.status);
		const detail = item.task ? paint(theme, "dim", ` · ${safe(item.task)}`) : "";
		return [fit(pair(head + detail, status, width), width)];
	});
}

// How many changed files the Diff panel lists while collapsed.
const DIFF_COLLAPSED_FILES = 5;

// Shortens a path from the START ("…/src/render.ts"), because the end of a
// path (the file name) is the part the user needs to recognise the file.
function fitPathStart(path: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(path) <= width) return path;
	if (width === 1) return "…";
	const chars = Array.from(path);
	let tail = "";
	for (let index = chars.length - 1; index >= 0; index -= 1) {
		const next = chars[index] + tail;
		if (visibleWidth(next) > width - 1) break;
		tail = next;
	}
	return `…${tail}`;
}

// `+12 -3` with the usual diff colors: additions green, removals red.
function lineCounts(theme: SidebarTheme, added: number, removed: number): string {
	return `${paint(theme, "success", `+${added}`)} ${paint(theme, "error", `-${removed}`)}`;
}

// Summary line (`3 files  +120 -45`) plus one row per changed file. Collapsed
// to DIFF_COLLAPSED_FILES rows; a click on the panel shows all files. As for
// Todos, renderSidebar()'s final height cut still protects a short terminal.
function diffRows(diff: DiffSummary, theme: SidebarTheme, width: number, expanded: boolean): string[] {
	const { files } = diff;
	if (files.length === 0) return [paint(theme, "dim", "No changes")];
	// Untracked and binary files have no line counts (null) and add nothing to
	// the totals; they still count as changed files.
	const added = files.reduce((total, file) => total + (file.added ?? 0), 0);
	const removed = files.reduce((total, file) => total + (file.removed ?? 0), 0);
	const rows = [pair(paint(theme, "muted", `${files.length} ${files.length === 1 ? "file" : "files"}`), lineCounts(theme, added, removed), width)];
	const visible = expanded ? files : files.slice(0, DIFF_COLLAPSED_FILES);
	for (const file of visible) {
		const counts = file.untracked
			? paint(theme, "success", "new")
			: file.added === null || file.removed === null
				? paint(theme, "dim", "bin")
				: lineCounts(theme, file.added, file.removed);
		// Size the path to the space left next to the counts. pair() would
		// cut the END of the line when it is too long, which hides the counts.
		const pathWidth = Math.max(1, width - visibleWidth(counts) - 1);
		rows.push(pair(paint(theme, "text", fitPathStart(clean(file.path), pathWidth)), counts, width));
	}
	if (!expanded && files.length > DIFF_COLLAPSED_FILES) {
		rows.push(paint(theme, "dim", `… ${files.length - DIFF_COLLAPSED_FILES} more (click to expand)`));
	}
	return rows;
}

function panel(title: string, rows: readonly string[], width: number, theme: SidebarTheme): string[] {
	const inner = Math.max(1, width - 4);
	const titleText = ` ${title.toUpperCase()} `;
	const topFill = Math.max(0, width - visibleWidth(titleText) - 3);
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

export interface RenderedSidebar {
	lines: string[];
	// [startLine, endLine) within `lines`, 0-based, for each clickable panel
	// that is on screen. index.ts uses these to hit-test mouse clicks. A panel
	// has no entry when it is disabled, hidden, or cut by the height limit.
	panelRanges: Partial<Record<ExpandablePanelId, [number, number]>>;
}

export function renderSidebar(
	snapshot: SidebarSnapshot,
	config: SidebarConfig,
	theme: SidebarTheme,
	width: number,
	height: number,
	expanded: Partial<Record<ExpandablePanelId, boolean>> = {},
): RenderedSidebar {
	const safeWidth = Math.max(4, Math.trunc(width));
	const safeHeight = Math.max(0, Math.trunc(height));
	if (safeHeight === 0) return { lines: [], panelRanges: {} };
	const contentWidth = Math.max(2, safeWidth - 2);
	const panelContentWidth = Math.max(1, contentWidth - 4);
	const definitions: PanelDefinition[] = [
		{ id: "model" as const, title: "Model", rows: modelRows(snapshot, theme, panelContentWidth), required: true },
		{ id: "context" as const, title: "Context", rows: contextRows(snapshot, theme, panelContentWidth), required: true },
		// The panel is dropped only for providers without subscription windows
		// (no buckets and nothing to say). Otherwise it stays visible and states
		// why data is missing.
		...(snapshot.limits.buckets.length > 0 || snapshot.limits.note !== undefined
			? [{ id: "limits" as const, title: "Limits", rows: limitsRows(snapshot.limits, theme, panelContentWidth), required: false }]
			: []),
		{ id: "usage" as const, title: "Session usage", rows: usageRows(snapshot, theme, panelContentWidth), required: false },
		{ id: "todos" as const, title: "Todos", rows: todoRows(snapshot.todos, theme, panelContentWidth, expanded.todos === true), required: false },
		{ id: "subagents" as const, title: "Subagents", rows: subagentRows(snapshot.subagents, theme, panelContentWidth), required: false },
		// Last in the list, so it is the first panel dropped on a short terminal.
		// Hidden (not "No changes") when the folder is not a git repository.
		...(snapshot.diff
			? [{ id: "diff" as const, title: "Diff", rows: diffRows(snapshot.diff, theme, panelContentWidth, expanded.diff === true), required: false }]
			: []),
	].filter((definition) => config.panels[definition.id]);

	let selected = [...definitions];
	// panel() output depends only on (title, rows, contentWidth, theme), all of
	// which are fixed for the duration of this call. The height-fitting loop used
	// to re-render every panel on every iteration, and the final flatMap rendered
	// them all again; memoising makes each panel render exactly once per frame.
	const renderedPanels = new Map<PanelDefinition, string[]>();
	const panelLines = (item: PanelDefinition): string[] => {
		let lines = renderedPanels.get(item);
		if (!lines) {
			lines = panel(item.title, item.rows, contentWidth, theme);
			renderedPanels.set(item, lines);
		}
		return lines;
	};
	const renderedLength = (items: readonly PanelDefinition[]) => items.reduce((total, item) => total + panelLines(item).length, 0);
	while (renderedLength(selected) > safeHeight) {
		const index = [...selected].reverse().findIndex((item) => !item.required);
		if (index < 0) break;
		selected.splice(selected.length - 1 - index, 1);
	}
	const panelRanges: RenderedSidebar["panelRanges"] = {};
	let cursor = 0;
	const lines = selected.flatMap((item) => {
		const rendered = panelLines(item);
		if (item.id === "todos" || item.id === "diff") {
			// Clip to what is visible after the final safeHeight cut. A panel
			// that starts below the last visible line gets no range at all.
			const end = Math.min(cursor + rendered.length, safeHeight);
			if (cursor < end) panelRanges[item.id] = [cursor, end];
		}
		cursor += rendered.length;
		return rendered;
	});
	// pad() already truncates when needed, so the separate truncateToWidth() call
	// that used to sit here was a second full-width scan of every visible line.
	const padded = Array.from({ length: safeHeight }, (_, index) => {
		return `${paint(theme, "dim", "│")} ${pad(lines[index] ?? "", contentWidth)}`;
	});
	return { lines: padded, panelRanges };
}
