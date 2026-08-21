import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { defaults } from "../../src/config/defaults.ts";
import { emptyState } from "../../src/state/reducer.ts";
import { transformOutgoingContext } from "../../src/transform/pipeline.ts";
import { hasProviderVisibleContent, LABEL_TAG_NAME } from "../../src/transform/labels.ts";

/**
 * Regression guard for the 2026-08-19 "assistant message prefill" incident.
 *
 * Pi's Anthropic adapter omits any message whose content produces no blocks
 * (`if (blocks.length === 0) continue;`). pi-dcp used to append a
 * <pi-dcp-message-id> tag to such a message, which made it non-empty and put it
 * back on the wire. When the message was the tail, the request then ended with
 * an assistant turn and Anthropic returned:
 *
 *   400 This model does not support assistant message prefill.
 *       The conversation must end with a user message.
 *
 * The bug was invisible while pi-dcp appended a transient status message to
 * every request, because that status message was itself a user-role tail.
 */

function harness(messages: AgentMessage[]) {
  const entries = messages.map((message, index) => ({
    type: "message", id: `e${index + 1}`, parentId: index ? `e${index}` : null,
    timestamp: new Date(index + 1).toISOString(), message,
  }));
  const ctx = {
    cwd: "/tmp",
    model: { provider: "anthropic", id: "claude-opus-5", api: "anthropic-messages", contextWindow: 200_000 },
    getContextUsage: () => ({ tokens: null, contextWindow: 200_000 }),
    sessionManager: { buildContextEntries: () => entries, getLeafId: () => `e${messages.length}` },
  } as any;
  return transformOutgoingContext(messages, { ctx, sessionId: "s", generation: 1, state: emptyState(), config: structuredClone(defaults) as any });
}

function serialized(message: AgentMessage): string {
  return JSON.stringify(message);
}

describe("label injection respects provider visibility", () => {
  it("leaves a zero-block assistant tail untouched so the adapter still drops it", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "do a thing", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "on it" }, { type: "toolCall", id: "t1", name: "bash", arguments: {} }], timestamp: 2 } as any,
      { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "output" }], timestamp: 3 } as any,
      // Whitespace-only assistant turn: kept by transformMessages (its stop
      // reason is normal) but dropped by convertMessages. It must stay dropped.
      { role: "assistant", stopReason: "stop", provider: "anthropic", api: "anthropic-messages", model: "claude-opus-5", content: [{ type: "text", text: "  " }], timestamp: 4 } as any,
    ];

    const result = harness(messages);

    expect(result.changed).toBe(true);
    expect(serialized(result.messages.at(-1)!)).not.toContain(LABEL_TAG_NAME);
    expect(serialized(result.messages.at(-1)!)).toBe(serialized(messages.at(-1)!));
  });

  it("still labels every message the provider does send", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "question", timestamp: 1 },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "answer" }], timestamp: 2 } as any,
    ];

    const result = harness(messages);

    expect(serialized(result.messages[0])).toContain(LABEL_TAG_NAME);
    expect(serialized(result.messages[1])).toContain(LABEL_TAG_NAME);
  });
});

describe("label placement never ends an assistant turn with text", () => {
  /**
   * Reproduced live against claude-opus-5 on 2026-08-19: an assistant message
   * whose content ends with a text block is treated as a prefill, and the whole
   * request is rejected with "This model does not support assistant message
   * prefill. The conversation must end with a user message." - even though the
   * last message really was a user tool_result. Only silent tool calls (a turn
   * with tool calls and no text of its own) could hit it, which is why the
   * failure always appeared right after a tool call.
   */
  it("inserts the label before the first tool call when the turn has no text", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "go", timestamp: 1 },
      { role: "assistant", content: [{ type: "thinking", thinking: "quiet", thinkingSignature: "sig" }, { type: "toolCall", id: "t1", name: "bash", arguments: {} }], timestamp: 2 } as any,
      { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "out" }], timestamp: 3 } as any,
    ];

    const assistant = harness(messages).messages[1] as any;

    expect(assistant.content.map((part: any) => part.type)).toEqual(["thinking", "text", "toolCall"]);
    // The invariant that matters to the provider: tool_use stays last.
    expect(assistant.content.at(-1).type).toBe("toolCall");
    expect(assistant.content[1].text).toContain(LABEL_TAG_NAME);
    // Thinking must stay first and keep its signature intact.
    expect(assistant.content[0]).toEqual({ type: "thinking", thinking: "quiet", thinkingSignature: "sig" });
  });

  it("still extends an existing text block rather than adding another", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "go", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "working" }, { type: "toolCall", id: "t1", name: "bash", arguments: {} }], timestamp: 2 } as any,
      { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "out" }], timestamp: 3 } as any,
    ];

    const assistant = harness(messages).messages[1] as any;

    expect(assistant.content.map((part: any) => part.type)).toEqual(["text", "toolCall"]);
    expect(assistant.content[0].text).toContain("working");
    expect(assistant.content[0].text).toContain(LABEL_TAG_NAME);
  });

  it("appends at the end only when the turn has no tool calls at all", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "go", timestamp: 1 },
      { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "done", thinkingSignature: "sig" }], timestamp: 2 } as any,
    ];

    const assistant = harness(messages).messages[1] as any;

    expect(assistant.content.map((part: any) => part.type)).toEqual(["thinking", "text"]);
  });
});

describe("hasProviderVisibleContent", () => {
  it("treats blank text and unsigned empty thinking as invisible", () => {
    expect(hasProviderVisibleContent({ role: "assistant", content: [] } as any)).toBe(false);
    expect(hasProviderVisibleContent({ role: "assistant", content: [{ type: "text", text: "   " }] } as any)).toBe(false);
    expect(hasProviderVisibleContent({ role: "assistant", content: [{ type: "thinking", thinking: "", thinkingSignature: "" }] } as any)).toBe(false);
    expect(hasProviderVisibleContent({ role: "user", content: "" } as any)).toBe(false);
  });

  it("treats tool calls, signed thinking, images and tool results as visible", () => {
    expect(hasProviderVisibleContent({ role: "assistant", content: [{ type: "toolCall", id: "t", name: "bash", arguments: {} }] } as any)).toBe(true);
    expect(hasProviderVisibleContent({ role: "assistant", content: [{ type: "thinking", thinking: "", thinkingSignature: "sig" }] } as any)).toBe(true);
    expect(hasProviderVisibleContent({ role: "user", content: [{ type: "image", data: "x", mimeType: "image/png" }] } as any)).toBe(true);
    // A tool_result block must answer its tool_use, so it is never dropped.
    expect(hasProviderVisibleContent({ role: "toolResult", toolCallId: "t", toolName: "bash", content: [] } as any)).toBe(true);
  });

  it("treats turns Pi drops on stop reason alone as invisible", () => {
    // pi-ai transformMessages: "Skip errored/aborted assistant messages entirely".
    expect(hasProviderVisibleContent({ role: "assistant", stopReason: "error", content: [{ type: "text", text: "partial" }] } as any)).toBe(false);
    expect(hasProviderVisibleContent({ role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "partial" }] } as any)).toBe(false);
  });
});
