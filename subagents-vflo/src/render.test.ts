/**
 * Core behavior of the subagent tool card. The rules tested here came from
 * the user, so a regression would show the wrong things in every session:
 * - a task's answer is never shown, not even when expanded;
 * - only running and failed tasks show their last tool call;
 * - the context bar is hidden when the model's window is unknown.
 */
import { describe, expect, it } from "vitest";
import { renderResult, type RenderTheme } from "./render.js";
import { emptyUsage, type PersistedTaskSummary } from "./types.js";

/** Plain theme: no escape codes, so the output can be compared as text. */
const theme: RenderTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
  getBgAnsi: () => "",
};

function task(overrides: Partial<PersistedTaskSummary>): PersistedTaskSummary {
  return {
    agent: "explore",
    source: "builtin",
    task: "Find the auth files",
    cwd: "/tmp",
    model: "anthropic/claude-haiku-4-5",
    warnings: [],
    lifecycle: "completed",
    toolCalls: [{ name: "bash", argsPreview: JSON.stringify({ command: "npm test" }) }],
    finalOutput: "SECRET ANSWER",
    usage: { ...emptyUsage(), turns: 3, input: 38000, output: 2100, cost: 0.012, contextTokens: 50000 },
    ...overrides,
  };
}

function draw(summaries: object[], expanded: boolean, live = false): string {
  const details = { mode: "tasks", taskCount: summaries.length, summaries, ...(live ? { live: true } : {}) };
  return renderResult({ content: [{ type: "text", text: "model text" }], details }, { expanded }, theme)
    .render(120)
    .map((line) => line.trimEnd())
    .join("\n");
}

describe("renderResult", () => {
  it("never shows the answer and hides the last tool call of a done task", () => {
    for (const expanded of [false, true]) {
      const out = draw([task({ contextWindow: 200000 })], expanded);
      expect(out).not.toContain("SECRET ANSWER");
      expect(out).not.toContain("npm test");
      expect(out).toContain("DONE");
      expect(out).toContain("claude-haiku-4-5");
      expect(out).toContain("25%");
    }
    // The task text is only in the expanded view.
    expect(draw([task({})], false)).not.toContain("Find the auth files");
    expect(draw([task({})], true)).toContain("Find the auth files");
  });

  it("shows the last tool call and the error of a failed task", () => {
    const out = draw([task({ lifecycle: "failed", failed: true, errorMessage: "Tests failed" })], false);
    expect(out).toContain("FAIL");
    expect(out).toContain("└ $ npm test");
    expect(out).toContain("✗ Tests failed");
  });

  it("shows the last tool call of a running task, and hides the bar without a context window", () => {
    const running = { ...task({}), id: "task-1", status: "running", lifecycle: "running", isPartial: true, latestOutput: "" };
    const out = draw([running], false, true);
    expect(out).toContain("RUN");
    expect(out).toContain("└ $ npm test");
    expect(out).not.toContain("%");
    expect(out).not.toContain("to expand");
  });

  it("shows the plain text when there are no task summaries (async start)", () => {
    const out = renderResult(
      { content: [{ type: "text", text: "Started 2 subagent task(s) in the background" }], details: { mode: "tasks", taskCount: 2, summaries: [], background: true } },
      { expanded: false },
      theme,
    ).render(120).join("\n");
    expect(out).toContain("Started 2 subagent task(s)");
  });
});
