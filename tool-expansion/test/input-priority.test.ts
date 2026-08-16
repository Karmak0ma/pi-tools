import { describe, expect, it } from "vitest";
import { prioritizeInputListener, type InputListener } from "../src/input-priority.js";

function fakeTui(mode: "regular" | "fullscreen", listeners?: Set<InputListener>): any {
  return { mode, ...(listeners === undefined ? {} : { inputListeners: listeners }) };
}

describe("fullscreen input listener priority", () => {
  it("puts the extension listener first and preserves other order", () => {
    const host: InputListener = () => undefined;
    const other: InputListener = () => undefined;
    const extension: InputListener = () => undefined;
    const listeners = new Set([host, other, extension]);

    expect(prioritizeInputListener(fakeTui("fullscreen", listeners), extension)).toBe(true);
    expect([...listeners]).toEqual([extension, host, other]);
  });

  it("is idempotent", () => {
    const host: InputListener = () => undefined;
    const extension: InputListener = () => undefined;
    const listeners = new Set([host, extension]);
    const tui = fakeTui("fullscreen", listeners);

    expect(prioritizeInputListener(tui, extension)).toBe(true);
    expect(prioritizeInputListener(tui, extension)).toBe(true);
    expect([...listeners]).toEqual([extension, host]);
  });

  it("does not modify regular mode", () => {
    const host: InputListener = () => undefined;
    const extension: InputListener = () => undefined;
    const listeners = new Set([host, extension]);
    expect(prioritizeInputListener(fakeTui("regular", listeners), extension)).toBe(false);
    expect([...listeners]).toEqual([host, extension]);
  });

  it("fails closed for missing or invalid private state", () => {
    const extension: InputListener = () => undefined;
    expect(prioritizeInputListener(fakeTui("fullscreen"), extension)).toBe(false);
    expect(prioritizeInputListener(fakeTui("fullscreen", new Set()), extension)).toBe(false);
    expect(prioritizeInputListener({ mode: "fullscreen", inputListeners: [] }, extension)).toBe(false);
  });
});
