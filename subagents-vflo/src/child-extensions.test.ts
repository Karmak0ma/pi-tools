import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePackageDir } from "./child-extensions.js";

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
