import { describe, expect, it } from "vitest";
import piDcp from "../../src/index.ts";

describe("command registration", () => {
  it("registers /dcp even when the optional runtime surface is unavailable", () => {
    const commands: string[] = [];
    let options: any;
    piDcp({ registerCommand: (name: string, registered: unknown) => { commands.push(name); options = registered; } } as any);
    expect(commands).toEqual(["dcp"]);
    expect(options.getArgumentCompletions("co")).toEqual([{ value: "context", label: "context", description: "show context usage" }, { value: "compress", label: "compress", description: "request model-authored compression" }]);
  });
});
