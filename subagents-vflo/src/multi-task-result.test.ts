import { describe, expect, it } from "vitest";
import { emptyUsage, type PersistedTaskSummary } from "./types.js";
import { buildMultiTaskToolResult, MULTI_TASK_OUTPUT_LIMIT } from "./multi-task-result.js";

function task(agent: string, finalOutput: string): PersistedTaskSummary {
  return {
    agent,
    source: "builtin",
    task: `Task for ${agent}`,
    cwd: "/repo",
    warnings: [],
    lifecycle: "completed",
    stopReason: "stop",
    toolCalls: [],
    finalOutput,
    usage: emptyUsage(),
  };
}

function previewForAgent(text: string, agent: string): string {
  const startMarker = `[${agent}] completed\n\n`;
  const start = text.indexOf(startMarker) + startMarker.length;
  return text.slice(start).split("\n\n[Output truncated")[0];
}

describe("multi-task subagent result formatting", () => {
  it("keeps output at exactly the limit in the parent-facing text", () => {
    const output = "x".repeat(MULTI_TASK_OUTPUT_LIMIT);
    const result = buildMultiTaskToolResult([task("explore", output)], {
      toolCallId: "toolu-at-limit",
      sessionFile: "/sessions/current.jsonl",
    });

    expect(result.content[0].text).toContain(output);
    expect(result.content[0].text).not.toContain("Output truncated");
  });

  it("raises the preview cap to 12,000 characters", () => {
    const output = "x".repeat(MULTI_TASK_OUTPUT_LIMIT + 1);
    const result = buildMultiTaskToolResult([task("explore", output)], {
      toolCallId: "toolu-over-limit",
      sessionFile: "/sessions/current.jsonl",
    });

    expect(previewForAgent(result.content[0].text, "explore")).toBe(output.slice(0, MULTI_TASK_OUTPUT_LIMIT));
    expect(result.content[0].text).toContain("Output truncated at 12000 characters");
  });

  it("prints a jq command for the exact session tool result and summary index", () => {
    const output = "y".repeat(MULTI_TASK_OUTPUT_LIMIT + 1);
    const result = buildMultiTaskToolResult(
      [task("short", "done"), task("long", output)],
      { toolCallId: "toolu-123", sessionFile: "/sessions/current.jsonl" },
    );

    expect(result.content[0].text).toContain(
      `jq -r --arg id 'toolu-123' 'select(.type=="message" and .message.role=="toolResult" and .message.toolCallId==$id) | .message.details.summaries[1].finalOutput' '/sessions/current.jsonl'`,
    );
  });

  it("quotes session paths and passes unusual tool-call IDs as jq data", () => {
    const result = buildMultiTaskToolResult([task("long", "z".repeat(MULTI_TASK_OUTPUT_LIMIT + 1))], {
      toolCallId: "toolu|123",
      sessionFile: "/sessions/user's session.jsonl",
    });

    expect(result.content[0].text).toContain("--arg id 'toolu|123'");
    expect(result.content[0].text).toContain("'/sessions/user'\\''s session.jsonl'");
  });

  it("keeps complete output in persisted details for completed and failed tasks", () => {
    const completedOutput = "z".repeat(MULTI_TASK_OUTPUT_LIMIT + 1);
    const failedOutput = "f".repeat(MULTI_TASK_OUTPUT_LIMIT + 1);
    const failedTask: PersistedTaskSummary = {
      ...task("failed", failedOutput),
      lifecycle: "failed",
      errorMessage: "Child failed after producing output",
    };
    const result = buildMultiTaskToolResult(
      [task("explore", completedOutput), failedTask],
      { toolCallId: "toolu-full-details", sessionFile: "/sessions/current.jsonl" },
    );

    expect(result.details.summaries[0].finalOutput).toBe(completedOutput);
    expect(result.details.summaries[1].finalOutput).toBe(failedOutput);
    expect(result.content[0].text).toContain("[failed] failed");
    expect(result.content[0].text).toContain("message.details.summaries[1].finalOutput");
  });

  it("explains where to look when no persistent parent session file is available", () => {
    for (const sessionFile of [undefined, ""]) {
      const result = buildMultiTaskToolResult([task("explore", "x".repeat(MULTI_TASK_OUTPUT_LIMIT + 1))], {
        toolCallId: "toolu-no-file",
        sessionFile,
      });

      expect(result.content[0].text).toContain("No persistent session file path is available");
      expect(result.content[0].text).toContain("toolCallId toolu-no-file");
      expect(result.content[0].text).toContain("message.details.summaries[0].finalOutput");
      expect(result.content[0].text).not.toContain("jq -r");
    }
  });

  it("does not split a surrogate pair at the preview boundary", () => {
    const output = `${"x".repeat(MULTI_TASK_OUTPUT_LIMIT - 1)}😀tail`;
    const result = buildMultiTaskToolResult([task("explore", output)], {
      toolCallId: "toolu-surrogate",
      sessionFile: "/sessions/current.jsonl",
    });
    const preview = previewForAgent(result.content[0].text, "explore");

    expect(preview).toBe("x".repeat(MULTI_TASK_OUTPUT_LIMIT - 1));
    expect(preview).not.toContain("\ud83d");
  });
});
