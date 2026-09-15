import { describe, expect, it } from "vitest";
import { isTaskFailed } from "./types.js";

describe("delegated task lifecycle classification", () => {
  it("does not classify an interrupted live turn as a failure", () => {
    expect(isTaskFailed({
      lifecycle: "interrupted",
      status: "running",
      stopReason: "aborted",
    })).toBe(false);
  });

  it("classifies a closed child as a terminal failure even with an exit code of zero", () => {
    expect(isTaskFailed({
      lifecycle: "closed",
      status: "aborted",
      stopReason: "aborted",
    })).toBe(true);
  });

  it("classifies a normally completed child as successful", () => {
    expect(isTaskFailed({
      lifecycle: "completed",
      status: "completed",
      stopReason: "stop",
    })).toBe(false);
  });
});
