import { describe, expect, it } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { createInstance } from "../tracker.js";
import { TaskHeaderComponent } from "./task-header.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

describe("TaskHeaderComponent usage display", () => {
  it("renders live token totals and context-window utilization", () => {
    initTheme();

    const instance = createInstance({
      id: "subagent-1",
      agent: "worker",
      source: "builtin",
      task: "inspect the repository",
      cwd: "/tmp",
      model: "openai/test-model",
      contextWindow: 128_000,
    });
    instance.summary.usage = {
      input: 1_234,
      output: 345,
      cacheRead: 2_000,
      cacheWrite: 500,
      cost: 0,
      contextTokens: 12_345,
      turns: 1,
    };

    const header = new TaskHeaderComponent(theme);
    header.setInstance(instance);
    const initial = header.render(120).join("\n");

    expect(initial).toContain("tokens: input 1.2k  output 345  cached 2.5k");
    expect(initial).toContain("context: 12k / 128k (9.6%)");
  });

  it("invalidates the cached header when usage changes", () => {
    initTheme();

    const instance = createInstance({
      id: "subagent-1",
      agent: "worker",
      source: "builtin",
      task: "inspect the repository",
      cwd: "/tmp",
      model: "openai/test-model",
      contextWindow: 100_000,
    });
    const header = new TaskHeaderComponent(theme);
    header.setInstance(instance);

    const initial = header.render(120).join("\n");
    expect(initial).toContain("context: 0 / 100k (0.0%)");

    instance.summary.usage.input = 2_000;
    instance.summary.usage.cacheRead = 1_000;
    instance.summary.usage.contextTokens = 80_000;
    header.setInstance(instance);

    const updated = header.render(120).join("\n");
    expect(updated).toContain("tokens: input 2.0k  output 0  cached 1.0k");
    expect(updated).toContain("context: 80k / 100k (80.0%)");
    expect(updated).not.toBe(initial);
  });
});
