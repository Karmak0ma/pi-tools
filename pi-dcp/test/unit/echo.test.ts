import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { stripEchoedLabels } from "../../src/transform/echo.ts";
import { stripLeakedLabelTags } from "../../src/ui/strip-labels.ts";

const TAG = "<pi-dcp-message-id>m0004</pi-dcp-message-id>";

describe("stripEchoedLabels", () => {
  it("removes a tag the model echoed into its own text", () => {
    // Observed live on 2026-08-19: told to emit no text at all, claude-opus-5
    // still wrote a label as its only text part, one ordinal off from the real
    // label pi-dcp had assigned to that same turn.
    const message = { role: "assistant", content: [{ type: "text", text: TAG }, { type: "toolCall", id: "t1", name: "bash", arguments: {} }] } as any;

    const cleaned = stripEchoedLabels(message) as any;

    // The emptied text part is dropped; the tool call is preserved untouched.
    expect(cleaned.content).toEqual([{ type: "toolCall", id: "t1", name: "bash", arguments: {} }]);
  });

  it("keeps surrounding prose and drops only the tag", () => {
    const message = { role: "assistant", content: [{ type: "text", text: `done\n${TAG}` }] } as any;

    expect((stripEchoedLabels(message) as any).content).toEqual([{ type: "text", text: "done" }]);
  });

  it("never edits a thinking part, whose signature covers its exact bytes", () => {
    const message = { role: "assistant", content: [{ type: "thinking", thinking: `reasoning ${TAG}`, thinkingSignature: "sig" }, { type: "text", text: TAG }] } as any;

    const cleaned = stripEchoedLabels(message) as any;

    expect(cleaned.content).toEqual([{ type: "thinking", thinking: `reasoning ${TAG}`, thinkingSignature: "sig" }]);
  });

  it("never touches tool results, which legitimately contain the tag text", () => {
    // A bash/read of src/transform/labels.ts contains the literal tag. Rewriting
    // it would corrupt a faithful file read.
    const message = { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: TAG }] } as any;

    expect(stripEchoedLabels(message)).toBeUndefined();
  });

  it("returns undefined when there is nothing to strip", () => {
    expect(stripEchoedLabels({ role: "assistant", content: [{ type: "text", text: "plain" }] } as any)).toBeUndefined();
    expect(stripEchoedLabels({ role: "user", content: TAG } as any)).toBeUndefined();
  });

  it("agrees with the markdown transformer on what a tag is", () => {
    const text = `before\n${TAG}after`;
    const message = { role: "assistant", content: [{ type: "text", text }] } as AgentMessage;

    expect((stripEchoedLabels(message) as any).content[0].text).toBe(stripLeakedLabelTags(text));
  });
});
