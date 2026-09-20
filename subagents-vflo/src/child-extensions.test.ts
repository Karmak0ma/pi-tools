import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolvePackageDir, warnOnUnresolvedChildExtensions } from "./child-extensions.js";

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
