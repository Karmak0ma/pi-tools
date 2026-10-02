import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getConfiguredAgentSettings,
  resolveExtensionEntryPoints,
  resetChildExtensionCache,
  withRequiredChildExtensions,
  resolveChildExtensions,
  resolvePackageDir,
  warnOnUnresolvedChildExtensions,
} from "./child-extensions.js";

describe("getConfiguredAgentSettings", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("reads model, thinking and tools defaults for both built-in agents", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-models-"));
    const configPath = path.join(dir, "settings.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        packages: ["npm:provider-extension"],
        default_agents: {
          explore: { model: " provider/explore ", thinking: "medium" },
          build: { model: "provider/build", thinking: "max", tools: ["read", " ask_advisor ", "read"] },
          reviewer: { model: "provider/ignored" },
        },
      }),
    );

    expect(getConfiguredAgentSettings(configPath)).toEqual({
      explore: { model: "provider/explore", thinking: "medium" },
      build: { model: "provider/build", thinking: "max", tools: ["read", "ask_advisor"] },
    });
  });

  it("ignores missing, malformed, and invalid settings field by field", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-models-"));
    const configPath = path.join(dir, "settings.json");

    expect(getConfiguredAgentSettings(configPath)).toEqual({});
    fs.writeFileSync(configPath, "not json");
    expect(getConfiguredAgentSettings(configPath)).toEqual({});
    fs.writeFileSync(configPath, JSON.stringify({ default_agents: [] }));
    expect(getConfiguredAgentSettings(configPath)).toEqual({});
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        default_agents: {
          explore: { model: "  ", thinking: "invalid", tools: [] },
          build: { model: 42, thinking: "high", tools: "read" },
        },
      }),
    );
    // The valid build thinking level survives its invalid neighbours.
    expect(getConfiguredAgentSettings(configPath)).toEqual({ build: { thinking: "high" } });
  });
});

describe("resolvePackageDir", () => {
  it("expands Pi-style home-relative package paths", () => {
    const source = "~/repos/pi-tools/pi-opencode-bridge";

    // Pi accepts ~/... in settings, but child argv bypasses shell expansion; resolving
    // to an absolute directory here is required before constructing child -e flags.
    expect(resolvePackageDir(source)).toBe(
      path.join(os.homedir(), "repos/pi-tools/pi-opencode-bridge"),
    );
  });

  it("leaves missing home-relative packages unresolved", () => {
    // Missing entries must still be reported rather than passed as unusable child paths.
    expect(resolvePackageDir("~/.definitely-missing-pi-extension")).toBeNull();
  });
});

describe("resolveExtensionEntryPoints", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("finds a non-index-named file inside a manifest-declared directory", () => {
    // Regression test for @henryqw/pi-herdr-rename: package.json declares
    // "pi": {"extensions": ["./extensions"]}, and the file inside is named
    // rename.ts (not index.ts). Real pi (package-manager.js) scans direct
    // .ts/.js files in the declared directory instead of requiring an index
    // file; this package's resolver must do the same or the package silently
    // drops into resolveChildExtensions()'s "unresolved" list.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "child-ext-nonidx-"));
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "fixture", pi: { extensions: ["./extensions"] } }),
    );
    fs.mkdirSync(path.join(dir, "extensions"));
    fs.writeFileSync(path.join(dir, "extensions", "rename.ts"), "export default function(){}");

    expect(resolveExtensionEntryPoints(dir)).toEqual([path.join(dir, "extensions", "rename.ts")]);
  });

  it("still prefers index.ts when present inside a manifest-declared directory", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "child-ext-idx-"));
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "fixture", pi: { extensions: ["./extensions"] } }),
    );
    fs.mkdirSync(path.join(dir, "extensions"));
    fs.writeFileSync(path.join(dir, "extensions", "index.ts"), "export default function(){}");
    fs.writeFileSync(path.join(dir, "extensions", "helper.ts"), "export const x = 1;");

    // index.ts wins outright, matching pi's own resolveExtensionEntries(): the
    // recursive-glob fallback only kicks in when no index file exists.
    expect(resolveExtensionEntryPoints(dir)).toEqual([path.join(dir, "extensions", "index.ts")]);
  });

  it("descends one level into a subdirectory only if it has its own index.ts/js", () => {
    // Matches real pi's collectAutoExtensionEntries exactly: a subdirectory of a
    // manifest-declared directory entry is only picked up if IT has an index
    // file. A subdirectory with a loose, non-index .ts file (like "orphan.ts"
    // below) is silently skipped -- this is real pi's own behavior, not a gap
    // introduced by this resolver.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "child-ext-nested-"));
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "fixture", pi: { extensions: ["./extensions"] } }),
    );
    const extDir = path.join(dir, "extensions");
    fs.mkdirSync(path.join(extDir, "has-index"), { recursive: true });
    fs.mkdirSync(path.join(extDir, "loose-file-only"), { recursive: true });
    fs.mkdirSync(path.join(extDir, "node_modules", "noise"), { recursive: true });
    fs.mkdirSync(path.join(extDir, ".hidden"), { recursive: true });
    fs.writeFileSync(path.join(extDir, "has-index", "index.ts"), "export default function(){}");
    fs.writeFileSync(path.join(extDir, "loose-file-only", "orphan.ts"), "not picked up");
    fs.writeFileSync(path.join(extDir, "node_modules", "noise", "index.ts"), "ignored");
    fs.writeFileSync(path.join(extDir, ".hidden", "index.ts"), "ignored");
    fs.writeFileSync(path.join(extDir, "README.md"), "not a source file");
    fs.writeFileSync(path.join(extDir, "top-level.js"), "export default function(){}");

    // Sorted by name: "has-index" is visited before "top-level.js".
    expect(resolveExtensionEntryPoints(dir)).toEqual([
      path.join(extDir, "has-index", "index.ts"),
      path.join(extDir, "top-level.js"),
    ]);
  });
});

describe("warnOnUnresolvedChildExtensions", () => {
  it("does not log when every configured package resolves", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      warnOnUnresolvedChildExtensions([]);
      expect(warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it("logs one aggregated warning with the unresolved sources and config path", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      warnOnUnresolvedChildExtensions(["npm:missing-extension", "~/missing-local-extension"]);
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning.mock.calls[0]?.[0]).toContain("npm:missing-extension");
      expect(warning.mock.calls[0]?.[0]).toContain("~/missing-local-extension");
      expect(warning.mock.calls[0]?.[0]).toContain("subagents-vflo_settings.json");
    } finally {
      warning.mockRestore();
    }
  });
});

describe("resolvePackageDir npm: resolution under the real module system", () => {
  // Regression guard for the require("module") call inside resolvePackageDir's
  // npm: branch: that call only works where `require` exists (CJS, or ESM with
  // createRequire). Vitest's transform gives .ts files CJS-style `require`, so
  // this test reproduces the actual runtime shape pi's own extension loader
  // uses (not a plain `node --input-type=module` import, which does NOT
  // provide `require` and was confirmed separately to throw there).
  it("resolves an installed @scope/name npm package without throwing", () => {
    const dir = resolvePackageDir("npm:@henryqw/pi-herdr-rename");
    expect(dir).toBe(
      path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "@henryqw/pi-herdr-rename"),
    );
  });
});

describe("resolveChildExtensions builtin entries", () => {
  // `--no-extensions` also turns off pi's built-in extensions, so a
  // `builtin:<name>` entry must reach the child as `-e builtin:<name>`
  // instead of being dropped as an unresolvable package path.
  it("passes builtin:<name> through verbatim", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-home-"));
    fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".pi", "agent", "subagents-vflo_settings.json"),
      JSON.stringify({ packages: ["builtin:codemode"] }),
    );
    vi.stubEnv("HOME", home);
    resetChildExtensionCache();
    try {
      expect(resolveChildExtensions()).toEqual({ paths: ["builtin:codemode"], unresolved: [] });
    } finally {
      vi.unstubAllEnvs();
      resetChildExtensionCache();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("withRequiredChildExtensions", () => {
  // --no-extensions turns off builtin:codemode, so a child given the codemode
  // tool must also get the extension, exactly once.
  it("loads builtin:codemode only when the child has the codemode tool", () => {
    expect(withRequiredChildExtensions(["/ext/a.ts"], ["read", "codemode"])).toEqual([
      "/ext/a.ts",
      "builtin:codemode",
    ]);
    expect(withRequiredChildExtensions(["builtin:codemode"], ["codemode"])).toEqual(["builtin:codemode"]);
    expect(withRequiredChildExtensions(undefined, ["read"])).toEqual([]);
  });
});
