import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { getChildExtensionConfigPath } from "./child-extensions.js";
import { buildToolResolutionOptions, resolveTools, type ToolResolutionOptions } from "./resolver.js";
import { DEFAULT_BUILD_TOOLS, type AgentConfig } from "./types.js";

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "test-agent",
    description: "test",
    systemPrompt: "",
    source: "project",
    ...overrides,
  };
}

/**
 * Fixture mirroring the real setup: the parent has the subagents-vflo
 * extension active, so "subagent" is a parent-active extension tool whose
 * providing entry point is /ext/subagents-vflo/src/index.ts.
 */
const SUBAGENT_ENTRY = "/ext/subagents-vflo/src/index.ts";

function backedOptions(): ToolResolutionOptions {
  return {
    extensionToolSources: new Map([["subagent", SUBAGENT_ENTRY]]),
    childExtensionPaths: [SUBAGENT_ENTRY],
  };
}

describe("resolveTools declared tools", () => {
  it("passes declared built-in tools through verbatim", () => {
    const agent = makeAgent({ tools: ["read", "bash", "grep"] });

    const result = resolveTools(agent, ["read", "bash", "edit", "write"]);

    expect(result).toEqual({ tools: ["read", "bash", "grep"], warnings: [] });
  });

  it("accepts a declared extension tool that is active in the parent and backed in the child", () => {
    // This is the wp-owner case: an orchestrator agent that recursively
    // dispatches specialists. The declared name must survive validation so it
    // flows into the child's --tools allowlist, where the -e-loaded extension
    // registers the actual tool.
    const agent = makeAgent({ tools: ["read", "bash", "subagent"] });
    const parentActive = ["read", "bash", "edit", "write", "subagent"];

    const result = resolveTools(agent, parentActive, backedOptions());

    expect(result).toEqual({ tools: ["read", "bash", "subagent"], warnings: [] });
  });

  it("warns when a declared extension tool has no backing extension in the child", () => {
    const agent = makeAgent({ tools: ["read", "subagent"] });

    const result = resolveTools(agent, ["read", "bash", "subagent"], {
      extensionToolSources: new Map([["subagent", SUBAGENT_ENTRY]]),
      childExtensionPaths: [], // settings file does not list the extension
    });

    expect(result.tools).toEqual(["read", "subagent"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Tool "subagent"');
    expect(result.warnings[0]).toContain(SUBAGENT_ENTRY);
    expect(result.warnings[0]).toContain("subagents-vflo_settings.json");
  });

  it("matches a symlinked child entry path to the real parent source path", () => {
    // Parent-reported SourceInfo paths and settings-derived child entries can
    // point at the same file through different spellings (symlinked package
    // dirs). Canonicalization must collapse them or the warning misfires.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resolver-symlink-"));
    try {
      const realEntry = path.join(dir, "pkg", "src", "index.ts");
      fs.mkdirSync(path.dirname(realEntry), { recursive: true });
      fs.writeFileSync(realEntry, "");
      const linkedPkg = path.join(dir, "linked");
      fs.symlinkSync(path.join(dir, "pkg"), linkedPkg, "dir");
      const viaLink = path.join(linkedPkg, "src", "index.ts");
      expect(viaLink).not.toBe(realEntry); // textual difference is the point

      const result = resolveTools(makeAgent({ tools: ["subagent"] }), ["read", "subagent"], {
        extensionToolSources: new Map([["subagent", realEntry]]),
        childExtensionPaths: [viaLink],
      });

      expect(result.warnings).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips the backing-extension warning when source info is unavailable", () => {
    // Older callers and tests may omit the options; declaration validity must
    // not depend on them.
    const agent = makeAgent({ tools: ["subagent"] });

    const result = resolveTools(agent, ["read", "subagent"]);

    expect(result).toEqual({ tools: ["subagent"], warnings: [] });
  });

  it("rejects declared tools that are neither built-in nor parent-active", () => {
    const agent = makeAgent({ tools: ["read", "subagent", "nonsense"] });

    const result = resolveTools(agent, ["read", "bash", "edit", "write", "subagent"]);

    expect(result.tools).toEqual([]);
    expect(result.error).toContain("nonsense");
    expect(result.error).not.toContain("subagent, nonsense");
  });

  it("rejects a bare extension tool name when the parent does not have it active", () => {
    // A child parent (e.g. a subagent) that loaded no subagents-vflo extension
    // must not accept recursive declarations it cannot back.
    const agent = makeAgent({ tools: ["subagent"] });

    const result = resolveTools(agent, ["read", "bash", "edit", "write"]);

    expect(result.tools).toEqual([]);
    expect(result.error).toContain("subagent");
    expect(result.error).toContain("parent session");
  });
});

describe("resolveTools optional tools", () => {
  // Built-in explore/build list compress as optional. A parent without pi-dcp
  // must not stop the built-in agents from starting.
  it("adds optional tools the parent has and silently drops the rest", () => {
    const agent = makeAgent({ tools: ["read", "bash"], optionalTools: ["compress", "todo"] });

    const result = resolveTools(agent, ["read", "bash", "compress"]);

    expect(result).toEqual({ tools: ["read", "bash", "compress"], warnings: [] });
  });
});

describe("resolveTools codemode follows the parent", () => {
  // Codemode is given to every agent whose parent has it, so agent files do
  // not opt in one by one. Its source is "builtin:codemode", which the spawn
  // loads itself, so no unbacked-tool warning even with an empty child list.
  const options: ToolResolutionOptions = {
    extensionToolSources: new Map([["codemode", "builtin:codemode"]]),
    childExtensionPaths: [],
  };

  it("adds codemode to a restricted agent and keeps the rest of its allowlist", () => {
    const agent = makeAgent({ tools: ["read"] });

    expect(resolveTools(agent, ["read", "bash", "todo", "codemode"], options)).toEqual({
      tools: ["read", "codemode"],
      warnings: [],
    });
  });

  it("adds codemode to agents that inherit built-ins", () => {
    expect(resolveTools(makeAgent(), ["read", "todo", "codemode"]).tools).toEqual(["read", "codemode"]);
  });

  it("leaves codemode out when the parent does not have it", () => {
    expect(resolveTools(makeAgent({ tools: ["read"] }), ["read"]).tools).toEqual(["read"]);
  });
});

describe("resolveTools inherited tools", () => {
  it("inherits only built-in tools from the parent for agents without an MCP policy", () => {
    // Inheritance stays least-privilege: agents that declare no tools must
    // not silently gain subagent/extension tools and their prompt guidelines.
    const agent = makeAgent();
    const parentActive = ["read", "bash", "grep", "subagent", "todo", "ask_user_question"];

    const result = resolveTools(agent, parentActive);

    expect(result.tools).toEqual(["read", "bash", "grep"]);
    expect(result.warnings).toEqual([]);
  });

  it("falls back to default build tools when nothing inheritable is active", () => {
    const agent = makeAgent();

    const result = resolveTools(agent, ["subagent"]);

    expect(result.tools).toEqual([...DEFAULT_BUILD_TOOLS]);
    expect(result.warnings.some((w) => w.includes("default build tools"))).toBe(true);
  });

  it("inherits active MCP tools for Build but not unrelated extension tools", () => {
    const agent = makeAgent({
      name: "build",
      tools: ["read", "bash", "edit", "write"],
      mcpToolInheritance: "active",
    });
    const mcpRead = "mcp__files__read_file";
    const mcpWrite = "mcp__files__write_file";
    const options: ToolResolutionOptions = {
      mcpTools: new Map([
        [mcpRead, { annotations: { readOnlyHint: true }, exposure: "direct" }],
        [mcpWrite, { annotations: { readOnlyHint: false }, exposure: "direct" }],
      ]),
      extensionToolSources: new Map([[mcpRead, "builtin:mcp"], [mcpWrite, "builtin:mcp"]]),
      childExtensionPaths: ["builtin:mcp"],
    };

    const result = resolveTools(agent, ["read", "bash", "edit", "write", mcpRead, mcpWrite], options);

    expect(result.tools).toEqual(["read", "bash", "edit", "write", mcpRead, mcpWrite]);
    expect(result.warnings).toEqual([]);
  });

  it("inherits only active MCP tools explicitly marked read-only for Explore", () => {
    const agent = makeAgent({
      name: "explore",
      tools: ["read", "grep", "find", "ls", "bash"],
      mcpToolInheritance: "read-only",
    });
    const readOnly = "mcp__docs__search";
    const write = "mcp__docs__update";
    const unannotated = "mcp__docs__unknown";
    const inactive = "mcp__docs__inactive_read";
    const options: ToolResolutionOptions = {
      mcpTools: new Map([
        [readOnly, { annotations: { readOnlyHint: true }, exposure: "direct" }],
        [write, { annotations: { readOnlyHint: false }, exposure: "direct" }],
        [unannotated, { exposure: "direct" }],
        [inactive, { annotations: { readOnlyHint: true }, exposure: "direct" }],
        ["mcp__docs__hidden_read", { annotations: { readOnlyHint: true }, exposure: "hidden" }],
      ]),
      extensionToolSources: new Map([
        [readOnly, "builtin:mcp"],
        [write, "builtin:mcp"],
        [unannotated, "builtin:mcp"],
        [inactive, "builtin:mcp"],
        ["mcp__docs__hidden_read", "builtin:mcp"],
      ]),
      childExtensionPaths: ["builtin:mcp"],
    };

    const result = resolveTools(
      agent,
      ["read", "grep", "find", "ls", "bash", readOnly, write, unannotated],
      options,
    );

    expect(result.tools).toEqual(["read", "grep", "find", "ls", "bash", readOnly]);
    expect(result.warnings).toEqual([]);
  });

  it("does not inherit MCP tools by default for custom agents", () => {
    const tool = "mcp__docs__search";
    const result = resolveTools(makeAgent({ tools: ["read"] }), ["read", tool], {
      mcpTools: new Map([[tool, { annotations: { readOnlyHint: true } }]]),
    });

    expect(result.tools).toEqual(["read"]);
  });

  it("warns when an inherited MCP tool has no backing builtin:mcp package", () => {
    const tool = "mcp__docs__search";
    const result = resolveTools(
      makeAgent({ tools: ["read"], mcpToolInheritance: "read-only" }),
      ["read", tool],
      {
        mcpTools: new Map([[tool, { annotations: { readOnlyHint: true } }]]),
        extensionToolSources: new Map([[tool, "builtin:mcp"]]),
        childExtensionPaths: [],
      },
    );

    expect(result.tools).toEqual(["read", tool]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(`Tool "${tool}"`);
    expect(result.warnings[0]).toContain("builtin:mcp");
  });

  it("does not add tools when there are no MCP tools to inherit", () => {
    const result = resolveTools(
      makeAgent({ tools: ["read", "bash"], mcpToolInheritance: "active" }),
      ["read", "bash"],
      { mcpTools: new Map() },
    );

    expect(result.tools).toEqual(["read", "bash"]);
  });

  it("classifies tools by the built-in MCP source, not annotations or names", () => {
    const pi = {
      getAllTools: () => [
        {
          name: "mcp__docs__search",
          sourceInfo: { path: "builtin:mcp" },
          annotations: { readOnlyHint: true },
        },
        {
          name: "looks_like_mcp",
          sourceInfo: { path: "/extensions/other.js" },
          annotations: { readOnlyHint: true },
        },
      ],
    };

    const options = buildToolResolutionOptions(pi as never);

    expect(options.mcpTools).toEqual(
      new Map([["mcp__docs__search", { annotations: { readOnlyHint: true }, exposure: undefined }]]),
    );
    expect(options.extensionToolSources?.get("mcp__docs__search")).toBe("builtin:mcp");
    expect(options.mcpTools?.has("looks_like_mcp")).toBe(false);
  });
});
