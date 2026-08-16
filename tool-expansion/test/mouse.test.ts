import { describe, expect, it } from "vitest";
import { isUnmodifiedPrimaryPress, parseSgrMouseEvent } from "../src/mouse.js";

describe("SGR mouse parsing", () => {
  it("parses a primary press and converts coordinates to zero-based", () => {
    const event = parseSgrMouseEvent("\u001b[<0;4;7M");
    expect(event).toEqual({
      button: 0,
      x: 3,
      y: 6,
      release: false,
      motion: false,
      wheel: false,
      modified: false,
    });
    expect(event && isUnmodifiedPrimaryPress(event)).toBe(true);
  });

  it("parses releases but does not classify them as toggle clicks", () => {
    const event = parseSgrMouseEvent("\u001b[<0;4;7m");
    expect(event?.release).toBe(true);
    expect(event && isUnmodifiedPrimaryPress(event)).toBe(false);
  });

  it.each([
    [32, "motion"],
    [64, "wheel"],
    [1, "secondary button"],
    [2, "middle button"],
    [4, "shift"],
    [8, "meta"],
    [16, "control"],
  ])("ignores %s reports", (button) => {
    const event = parseSgrMouseEvent(`\u001b[<${button};4;7M`);
    expect(event && isUnmodifiedPrimaryPress(event)).toBe(false);
  });

  it("rejects malformed and incomplete reports", () => {
    expect(parseSgrMouseEvent("\u001b[<0;0;7M")).toBeUndefined();
    expect(parseSgrMouseEvent("\u001b[<0;4;0M")).toBeUndefined();
    expect(parseSgrMouseEvent("\u001b[<0;4;7")).toBeUndefined();
    expect(parseSgrMouseEvent("\u001b[M")).toBeUndefined();
    expect(parseSgrMouseEvent("not a mouse report")).toBeUndefined();
  });
});
