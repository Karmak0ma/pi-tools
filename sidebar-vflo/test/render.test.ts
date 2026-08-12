import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderSidebar } from "../src/render.js";
import { DEFAULT_CONFIG } from "../src/types.js";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

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
});
