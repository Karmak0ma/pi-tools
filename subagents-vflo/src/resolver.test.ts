import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { getChildExtensionConfigPath } from "./child-extensions.js";
import { resolveTools, type ToolResolutionOptions } from "./resolver.js";
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

describe("resolveTools inherited tools", () => {
  it("inherits only built-in tools from the parent, never extension tools", () => {
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
});