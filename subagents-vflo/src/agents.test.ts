import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockSettings = vi.hoisted(() => ({
  agentRoot: "",
  defaults: {} as Record<string, { model?: string; thinking?: string; tools?: string[] }>,
}));

// Keep these tests focused on discovery precedence. The fake parser supplies
// only the named fixtures, so unrelated agent files cannot affect the result.
vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => mockSettings.agentRoot,
  parseFrontmatter: (content: string) => {
    if (content === "user-explore") {
      return {
        frontmatter: { name: "explore", description: "user override", model: "user/explore", thinking: "high" },
        body: "user prompt",
      };
    }
    if (content === "project-build") {
      return {
        frontmatter: { name: "build", description: "project override", model: "project/build", thinking: "low" },
        body: "project prompt",
      };
    }
    return { frontmatter: {}, body: "" };
  },
}));
vi.mock("./child-extensions.js", () => ({
  getConfiguredAgentSettings: () => mockSettings.defaults,
}));

import { discoverAgents, findAgent } from "./agents.js";

describe("discoverAgents built-in settings", () => {
  let cwd: string | undefined;

  afterEach(() => {
    if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
    cwd = undefined;
    mockSettings.agentRoot = "";
    mockSettings.defaults = {};
  });

  it("applies configured model and thinking defaults to Explore and Build", () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-agent-settings-"));
    mockSettings.agentRoot = path.join(cwd, "user-agent-home");
    mockSettings.defaults = {
      explore: { model: "openai-codex/gpt-6-luna", thinking: "medium" },
      build: { model: "openai-codex/gpt-6-luna", thinking: "max" },
    };

    const { agents } = discoverAgents(cwd);

    expect(findAgent(agents, "explore")).toMatchObject({
      model: "openai-codex/gpt-6-luna",
      thinking: "medium",
      source: "builtin",
      mcpToolInheritance: "read-only",
    });
    expect(findAgent(agents, "build")).toMatchObject({
      model: "openai-codex/gpt-6-luna",
      thinking: "max",
      source: "builtin",
      mcpToolInheritance: "active",
    });
  });

  it("replaces the bundled tools and optional tools with configured tools", () => {
    // Settings tools are the user's explicit choice, so they also drop the
    // soft optional list; resolveTools() then checks them strictly.
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-agent-settings-"));
    mockSettings.agentRoot = path.join(cwd, "user-agent-home");
    mockSettings.defaults = { build: { tools: ["read", "ask_advisor"] } };

    const { agents } = discoverAgents(cwd);

    const build = findAgent(agents, "build");
    expect(build?.tools).toEqual(["read", "ask_advisor"]);
    expect(build?.optionalTools).toBeUndefined();
    expect(findAgent(agents, "explore")).toMatchObject({
      tools: ["read", "grep", "find", "ls", "bash"],
      optionalTools: ["compress"],
    });
  });

  it("keeps bundled defaults when no model or thinking key is configured", () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-agent-settings-"));
    mockSettings.agentRoot = path.join(cwd, "user-agent-home");

    const { agents } = discoverAgents(cwd);

    expect(findAgent(agents, "explore")).toMatchObject({
      model: "openai-codex/gpt-5.6-luna",
      thinking: "medium",
      source: "builtin",
    });
    expect(findAgent(agents, "build")).toMatchObject({
      model: "openai-codex/gpt-5.6-luna",
      thinking: "xhigh",
      source: "builtin",
    });
  });

  it("lets user and project agent files override configured built-in defaults", () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-agent-settings-"));
    mockSettings.agentRoot = path.join(cwd, "user-agent-home");
    mockSettings.defaults = {
      explore: { model: "openai-codex/gpt-6-luna", thinking: "medium" },
      build: { model: "openai-codex/gpt-6-luna", thinking: "max" },
    };

    const userAgentsDir = path.join(mockSettings.agentRoot, "agents");
    fs.mkdirSync(userAgentsDir, { recursive: true });
    fs.writeFileSync(path.join(userAgentsDir, "explore.md"), "user-explore");

    const projectAgentsDir = path.join(cwd, ".pi", "agents");
    fs.mkdirSync(projectAgentsDir, { recursive: true });
    fs.writeFileSync(path.join(projectAgentsDir, "build.md"), "project-build");

    const { agents } = discoverAgents(cwd);

    expect(findAgent(agents, "explore")).toMatchObject({
      model: "user/explore",
      thinking: "high",
      source: "user",
    });
    expect(findAgent(agents, "build")).toMatchObject({
      model: "project/build",
      thinking: "low",
      source: "project",
    });
  });
});
