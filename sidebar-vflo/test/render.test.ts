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
	it("renders subscription allowance when available", () => {
		const lines = renderSidebar(
			{
				model: { provider: "openai-codex", id: "model", name: "Model", subscriptionRemaining: 42.5 },
				thinkingLevel: "medium",
				activity: { state: "ready", label: "Ready", activeTools: [] },
				context: undefined,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				todos: [],
				subagents: [],
			},
			DEFAULT_CONFIG,
			theme,
			44,
			20,
		);
		expect(lines.some((line) => line.includes("42.5% left"))).toBe(true);
	});

	it("renders a width-safe context meter and enabled panels", () => {
		const lines = renderSidebar(
			{
				model: { provider: "provider", id: "model", name: "Model" },
				thinkingLevel: "high",
				activity: { state: "working", label: "Responding", activeTools: ["bash"] },
				context: { tokens: 75, contextWindow: 100, percent: 75 },
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

	it("uses the Sonokai Andromeda truecolor palette", () => {
		const lines = renderSidebar(
			{
				model: { provider: "provider", id: "Model", name: "Model" },
				thinkingLevel: "medium",
				activity: { state: "ready", label: "Ready", activeTools: [] },
				context: undefined,
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
		const lines = renderSidebar(
			{
				model: { provider: "provider", id: "model", name: "Model" },
				thinkingLevel: "medium",
				activity: { state: "ready", label: "Ready", activeTools: [] },
				context: undefined,
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
		const body = lines.find((line) => line.includes("Ready"));
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
