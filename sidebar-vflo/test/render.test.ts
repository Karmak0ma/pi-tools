import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderSidebar } from "../src/render.js";
import { DEFAULT_CONFIG } from "../src/types.js";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

const monokaiTheme = { ...theme, preset: "monokai" as const };

describe("Sidebar VFLO renderer", () => {
	it("renders a subscription limit bar when available", () => {
		const { lines } = renderSidebar(
			{
				model: { provider: "openai-codex", id: "model", name: "Model" },
				thinkingLevel: "medium",
				diff: undefined,
				context: undefined,
				limits: { buckets: [{ id: "codex:primary", label: "5-hour window", remaining: 42.5 }] },
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				todos: [],
				subagents: [],
			},
			DEFAULT_CONFIG,
			theme,
			44,
			20,
		);
		expect(lines.some((line) => line.includes("LIMITS"))).toBe(true);
		expect(lines.some((line) => line.includes("5-hour window"))).toBe(true);
		expect(lines.some((line) => line.includes("42.5%"))).toBe(true);
	});

	it("renders one bar per bucket for providers with multiple limit windows", () => {
		const { lines } = renderSidebar(
			{
				model: { provider: "anthropic", id: "model", name: "Model" },
				thinkingLevel: "medium",
				diff: undefined,
				context: undefined,
				limits: {
					buckets: [
						{ id: "anthropic:5h", label: "5-hour window", remaining: 80, windowMinutes: 300 },
						{ id: "anthropic:7d", label: "Weekly window", remaining: 55, windowMinutes: 10080 },
					],
				},
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				todos: [],
				subagents: [],
			},
			DEFAULT_CONFIG,
			theme,
			44,
			60,
		);
		expect(lines.some((line) => line.includes("5-hour window"))).toBe(true);
		expect(lines.some((line) => line.includes("Weekly window"))).toBe(true);
		expect(lines.some((line) => line.includes("80.0%"))).toBe(true);
		expect(lines.some((line) => line.includes("55.0%"))).toBe(true);
		// Two buckets means two independent meter bars.
		expect(lines.filter((line) => line.includes("[") && line.includes("]")).length).toBeGreaterThanOrEqual(2);
	});

	it("omits the Limits panel for providers without subscription windows", () => {
		const { lines } = renderSidebar(
			{
				model: { provider: "provider", id: "model", name: "Model" },
				thinkingLevel: "medium",
				diff: undefined,
				context: undefined,
				limits: { buckets: [] },
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				todos: [],
				subagents: [],
			},
			DEFAULT_CONFIG,
			theme,
			44,
			20,
		);
		expect(lines.some((line) => line.includes("LIMITS"))).toBe(false);
	});

	// Regression guard: the panel used to vanish whenever a usage refresh
	// failed, which hid the failure completely. A subscription provider must
	// keep the box and state why the numbers are missing.
	it("keeps the Limits panel and shows the note when data is missing", () => {
		const { lines } = renderSidebar(
			{
				model: { provider: "anthropic", id: "model", name: "Model" },
				thinkingLevel: "medium",
				diff: undefined,
				context: undefined,
				limits: { buckets: [], note: "Waiting for usage data…" },
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				todos: [],
				subagents: [],
			},
			DEFAULT_CONFIG,
			theme,
			44,
			20,
		);
		expect(lines.some((line) => line.includes("LIMITS"))).toBe(true);
		expect(lines.some((line) => line.includes("Waiting for usage data"))).toBe(true);
	});

	it("shows stale/failed refresh notes next to the last known bars", () => {
		const { lines } = renderSidebar(
			{
				model: { provider: "anthropic", id: "model", name: "Model" },
				thinkingLevel: "medium",
				diff: undefined,
				context: undefined,
				limits: {
					buckets: [{ id: "anthropic:5h", label: "5-hour window", remaining: 80 }],
					note: "12m ago",
				},
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				todos: [],
				subagents: [],
			},
			DEFAULT_CONFIG,
			theme,
			44,
			40,
		);
		expect(lines.some((line) => line.includes("80.0%"))).toBe(true);
		expect(lines.some((line) => line.includes("12m ago"))).toBe(true);
	});

	it("renders a width-safe context meter and enabled panels", () => {
		const { lines } = renderSidebar(
			{
				model: { provider: "provider", id: "model", name: "Model" },
				thinkingLevel: "high",
				diff: undefined,
				context: { tokens: 75, contextWindow: 100, percent: 75 },
				limits: { buckets: [] },
				usage: { input: 1000, output: 200, cacheRead: 300, cacheWrite: 0 },
				todos: [{ id: 1, subject: "Write a very long task subject", status: "pending" }],
				subagents: [{ id: "1", agent: "explore", task: "Inspect", status: "idle", sourceStatus: "running" }],
			},
			DEFAULT_CONFIG,
			theme,
			44,
			80,
		);
		expect(lines).toHaveLength(80);
		expect(lines.some((line) => line.includes("CONTEXT"))).toBe(true);
		expect(lines.some((line) => line.includes("75.0%"))).toBe(true);
		expect(lines.every((line) => visibleWidth(line) <= 44)).toBe(true);
	});

	it("caps the Todos list by default and expands it on request", () => {
		const todos = Array.from({ length: 12 }, (_, index) => ({
			id: index + 1,
			subject: `Task ${index + 1}`,
			status: "pending" as const,
		}));
		const snapshot = {
			model: { provider: "provider", id: "model", name: "Model" },
			thinkingLevel: "medium",
			diff: undefined,
			context: undefined,
			limits: { buckets: [] },
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			todos,
			subagents: [],
		};

		const collapsed = renderSidebar(snapshot, DEFAULT_CONFIG, theme, 44, 80, { todos: false });
		expect(collapsed.lines.some((line) => line.includes("Task 9"))).toBe(false);
		expect(collapsed.lines.some((line) => line.includes("more"))).toBe(true);

		const expanded = renderSidebar(snapshot, DEFAULT_CONFIG, theme, 44, 80, { todos: true });
		expect(expanded.lines.some((line) => line.includes("Task 9"))).toBe(true);
		expect(expanded.lines.some((line) => line.includes("Task 12"))).toBe(true);
		expect(expanded.lines.some((line) => line.includes("more"))).toBe(false);
	});

	it("reports the rendered Todos panel's line range for click hit-testing", () => {
		const snapshot = {
			model: { provider: "provider", id: "model", name: "Model" },
			thinkingLevel: "medium",
			diff: undefined,
			context: undefined,
			limits: { buckets: [] },
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			todos: [{ id: 1, subject: "Task", status: "pending" as const }],
			subagents: [],
		};
		const { lines, panelRanges } = renderSidebar(snapshot, DEFAULT_CONFIG, theme, 44, 80);
		const todosRange = panelRanges.todos;
		expect(todosRange).toBeDefined();
		const [start, end] = todosRange ?? [0, 0];
		expect(start).toBeGreaterThanOrEqual(0);
		expect(end).toBeGreaterThan(start);
		expect(lines.slice(start, end).some((line) => line.includes("TODOS"))).toBe(true);

		const withoutTodos = renderSidebar(
			snapshot,
			{ ...DEFAULT_CONFIG, panels: { ...DEFAULT_CONFIG.panels, todos: false } },
			theme,
			44,
			80,
		);
		expect(withoutTodos.panelRanges.todos).toBeUndefined();
	});

	it("renders the Diff panel last: totals, 5 files collapsed, all files expanded", () => {
		const files = [
			{ path: "src/a.ts", added: 10, removed: 2, untracked: false },
			{ path: "src/b.ts", added: 5, removed: 0, untracked: false },
			{ path: "logo.png", added: null, removed: null, untracked: false },
			{ path: "src/c.ts", added: 1, removed: 1, untracked: false },
			{ path: "src/d.ts", added: 0, removed: 7, untracked: false },
			{ path: "src/new-file.ts", added: null, removed: null, untracked: true },
		];
		const snapshot = {
			model: { provider: "provider", id: "model", name: "Model" },
			thinkingLevel: "medium",
			context: undefined,
			limits: { buckets: [] },
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			todos: [],
			subagents: [],
			diff: { files },
		};

		const collapsed = renderSidebar(snapshot, DEFAULT_CONFIG, theme, 44, 80);
		const text = collapsed.lines.join("\n");
		// Last panel: its title comes after the Subagents title.
		expect(text.indexOf("DIFF")).toBeGreaterThan(text.indexOf("SUBAGENTS"));
		// Binary and untracked files count as files but add no lines.
		expect(collapsed.lines.some((line) => /6 files\s+\+16 -10/.test(line))).toBe(true);
		expect(text).toContain("bin");
		expect(text).not.toContain("new-file.ts");
		expect(text).toContain("1 more (click to expand)");
		const range = collapsed.panelRanges.diff;
		expect(range).toBeDefined();
		expect(collapsed.lines.slice(...(range ?? [0, 0])).some((line) => line.includes("DIFF"))).toBe(true);

		const expanded = renderSidebar(snapshot, DEFAULT_CONFIG, theme, 44, 80, { diff: true });
		expect(expanded.lines.some((line) => /new-file\.ts\s+new/.test(line))).toBe(true);
		expect(expanded.lines.some((line) => line.includes("more"))).toBe(false);

		// Not a git repository: no panel, rather than a false "No changes".
		const hidden = renderSidebar({ ...snapshot, diff: undefined }, DEFAULT_CONFIG, theme, 44, 80);
		expect(hidden.lines.some((line) => line.includes("DIFF"))).toBe(false);
		expect(hidden.panelRanges.diff).toBeUndefined();
	});

	it("colors diff additions green and removals red, and keeps counts visible for long paths", () => {
		const { lines } = renderSidebar(
			{
				model: undefined,
				thinkingLevel: undefined,
				context: undefined,
				limits: { buckets: [] },
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				todos: [],
				subagents: [],
				diff: { files: [{ path: "a/very/long/directory/path/that/does/not/fit/render.ts", added: 3, removed: 4, untracked: false }] },
			},
			DEFAULT_CONFIG,
			monokaiTheme,
			32,
			60,
		);
		const rendered = lines.join("\n");
		expect(rendered).toContain("\u001b[38;2;158;208;108m+3\u001b[39m");
		expect(rendered).toContain("\u001b[38;2;251;97;126m-4\u001b[39m");
		// The path is cut from the start, so the file name and counts stay.
		expect(lines.some((line) => line.includes("…") && line.includes("render.ts") && line.includes("-4"))).toBe(true);
	});

	it("uses the Sonokai Andromeda truecolor palette", () => {
		const { lines } = renderSidebar(
			{
				model: { provider: "provider", id: "Model", name: "Model" },
				thinkingLevel: "medium",
				diff: undefined,
				context: undefined,
				limits: { buckets: [] },
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				todos: [],
				subagents: [],
			},
			{ ...DEFAULT_CONFIG, panels: { ...DEFAULT_CONFIG.panels, usage: false, todos: false, subagents: false } },
			monokaiTheme,
			24,
			20,
		);
		const rendered = lines.join("\n");
		expect(rendered).toContain("\u001b[38;2;225;227;228mModel\u001b[39m");
		expect(rendered).toContain("\u001b[38;2;109;202;232m╭─ MODEL");
	});

	it("keeps panel corners aligned with the body and bottom borders", () => {
		const { lines } = renderSidebar(
			{
				model: { provider: "provider", id: "model", name: "Model" },
				thinkingLevel: "medium",
				diff: undefined,
				context: undefined,
				limits: { buckets: [] },
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				todos: [],
				subagents: [],
			},
			{ ...DEFAULT_CONFIG, panels: { ...DEFAULT_CONFIG.panels, usage: false, todos: false, subagents: false } },
			theme,
			24,
			20,
		);
		const top = lines.find((line) => line.includes("MODEL"));
		const body = lines.find((line) => line.includes("Thinking"));
		const bottom = lines.find((line) => line.includes("╰"));
		expect(top).toBeDefined();
		expect(body).toBeDefined();
		expect(bottom).toBeDefined();
		expect(visibleWidth(top ?? "")).toBe(24);
		expect(visibleWidth(body ?? "")).toBe(24);
		expect(visibleWidth(bottom ?? "")).toBe(24);
		expect((top ?? "").at(-1)).toBe("╮");
		expect((body ?? "").at(-1)).toBe("│");
		expect((bottom ?? "").at(-1)).toBe("╯");
	});
});
