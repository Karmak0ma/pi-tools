import { describe, expect, it } from "vitest";
import { stripLeakedLabelTags } from "../../src/ui/strip-labels.ts";

describe("stripLeakedLabelTags", () => {
  it("removes a leaked label tag and its leading newline", () => {
    const leaked = "Here is my answer.\n<pi-dcp-message-id>m0053</pi-dcp-message-id>";
    expect(stripLeakedLabelTags(leaked)).toBe("Here is my answer.");
  });

  it("removes a block-alias tag", () => {
    const leaked = "Done.\n<pi-dcp-message-id>b0002</pi-dcp-message-id>";
    expect(stripLeakedLabelTags(leaked)).toBe("Done.");
  });

  it("removes multiple leaked tags in one message", () => {
    const leaked = "First.\n<pi-dcp-message-id>m0001</pi-dcp-message-id>\nSecond.\n<pi-dcp-message-id>m0002</pi-dcp-message-id>";
    expect(stripLeakedLabelTags(leaked)).toBe("First.\nSecond.");
  });

  it("removes truncated tags from a response stopped at a tool call", () => {
    const leaked = "I will check that.\n\n<pi-dcp-message-id>m0082\n";
    expect(stripLeakedLabelTags(leaked)).toBe("I will check that.");
  });

  it("removes a bare opening tag after a truncated label", () => {
    const leaked = "Working.\n\n<pi-dcp-message-id>m0074\n\n<pi-dcp-message-id>";
    expect(stripLeakedLabelTags(leaked)).toBe("Working.");
  });

  it("leaves ordinary Markdown untouched", () => {
    const clean = "# Title\n\nSome **bold** text with a <not-a-label>tag</not-a-label>.";
    expect(stripLeakedLabelTags(clean)).toBe(clean);
  });

  it("leaves text mentioning the tag name without angle brackets untouched", () => {
    const clean = "The tag is called pi-dcp-message-id.";
    expect(stripLeakedLabelTags(clean)).toBe(clean);
  });
});
