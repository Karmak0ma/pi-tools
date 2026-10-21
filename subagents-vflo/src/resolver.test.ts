import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { buildToolResolutionOptions, resolveTools, type ToolResolutionOptions } from "./resolver.js";
import type { AgentConfig } from "./types.js";

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "test-agent",
    description: "test",
    systemPrompt: "",
    source: "project",
    ...overrides,
  };
}

const DCP = "/ext/pi-dcp/index.ts";
const WEB = "/ext/pi-web-access/index.ts";
const TODO = "/ext/todo/index.ts";

/**
 * Parent fixture: pi-dcp, pi-web-access, a todo extension and builtin:mcp are
 * registered in the parent. The child `packages` load pi-dcp, pi-web-access
 * and builtin:mcp, but not the todo extension.
 */
function options(): ToolResolutionOptions {
  return {
    parentToolSources: new Map([
      ["read", "builtin:read"],
      ["compress", DCP],
      ["web_enable", WEB],
      ["web_search", WEB],
      ["todo", TODO],
      ["mcp__docs__search", "builtin:mcp"],
    ]),
    childExtensionPaths: [DCP, WEB, "builtin:mcp"],
  };
}

describe("resolveTools with a tool list", () => {
  it("passes the list through unchanged, including patterns", () => {
    const agent = makeAgent({ tools: ["read", "edit", "compress", "mcp__docs__*"] });

    const result = resolveTools(agent, ["read"], options());

    expect(result).toEqual({ tools: ["read", "edit", "compress", "mcp__docs__*"], warnings: [] });
  });

  it("accepts tools the parent registered but has not turned on", () => {
    // pi-web-access keeps web_search off until web_enable. The parent must not
    // have to enable web access for itself to give it to a child.
    const agent = makeAgent({ tools: ["web_enable", "web_search"] });

    const result = resolveTools(agent, ["read"], options());

    expect(result.error).toBeUndefined();
    expect(result.tools).toEqual(["web_enable", "web_search"]);
  });

  it("fails for unknown tools and for tools whose extension the child does not load", () => {
    // packages is the complete list of child extensions, so a listed tool from
    // an extension that is not in it must be a loud error, not a missing tool.
    const agent = makeAgent({ tools: ["read", "todo", "nonsense"] });

    const result = resolveTools(agent, ["read", "todo"], options());

    expect(result.tools).toEqual([]);
    expect(result.error).toContain(`"todo": its extension ${TODO} is not in "packages"`);
    expect(result.error).toContain(`"nonsense": no extension in the parent session registers this tool`);
    expect(result.error).not.toContain('"read"');
  });

  // In a nested session pi registers only the tools in its own --tools list,
  // so the useful fix is the spawning agent's list, not a missing extension.
  it("names the spawning agent's tool list when this session is a subagent", () => {
    const agent = makeAgent({ tools: ["read", "codemode"] });

    const result = resolveTools(agent, ["read"], { ...options(), parentIsSubagent: true });

    expect(result.error).toContain('"codemode": this session is a subagent and does not have this tool');
    expect(result.error).toContain('add "codemode" to the tool list of the agent that spawned this session');
  });

  it("matches a symlinked package path to the parent's real source path", () => {
    // Parent source paths and settings-derived child entries can name the same
    // file through different spellings. Without canonicalization the spawn
    // would fail with a false "not in packages" error.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resolver-symlink-"));
    try {
      const realEntry = path.join(dir, "pkg", "index.ts");
      fs.mkdirSync(path.dirname(realEntry), { recursive: true });
      fs.writeFileSync(realEntry, "");
      fs.symlinkSync(path.join(dir, "pkg"), path.join(dir, "linked"), "dir");

      const result = resolveTools(makeAgent({ tools: ["subagent"] }), [], {
        parentToolSources: new Map([["subagent", realEntry]]),
        childExtensionPaths: [path.join(dir, "linked", "index.ts")],
      });

      expect(result.error).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveTools without a tool list", () => {
  it("inherits the parent's active tools that the child can have", () => {
    // todo comes from an extension the child does not load, and web_search is
    // registered but not active in the parent: neither is inherited.
    const result = resolveTools(makeAgent(), ["read", "edit", "compress", "web_enable", "todo"], options());

    expect(result).toEqual({ tools: ["read", "edit", "compress", "web_enable"], warnings: [] });
  });
});

describe("buildToolResolutionOptions", () => {
  it("maps every registered parent tool to its source path", () => {
    const pi = {
      getAllTools: () => [
        { name: "read", sourceInfo: { path: "builtin:read" } },
        { name: "mcp__docs__search", sourceInfo: { path: "builtin:mcp" } },
        { name: "compress", sourceInfo: { path: DCP } },
      ],
    };

    const result = buildToolResolutionOptions(pi as never);

    expect(result.parentToolSources).toEqual(
      new Map([
        ["read", "builtin:read"],
        ["mcp__docs__search", "builtin:mcp"],
        ["compress", DCP],
      ]),
    );
  });
});
