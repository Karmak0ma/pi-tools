import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { defaults } from "../../src/config/defaults.ts";
import { emptyState } from "../../src/state/reducer.ts";
import { transformOutgoingContext } from "../../src/transform/pipeline.ts";

const APIs = ["openai-completions", "openai-responses", "anthropic-messages", "azure-openai-responses", "google-generative-ai", "openai-codex-responses", "opencode-cli-runner", "test"];

function fixture(api: string) {
  const messages: AgentMessage[] = [
    { role: "user", content: "closed user intent", timestamp: 1 },
    { role: "assistant", content: [{ type: "thinking", thinking: "opaque", thinkingSignature: "sig" }, { type: "text", text: "completed response" }, { type: "toolCall", id: `read-${api}`, name: "read", arguments: { path: "src/example.ts" } }], provider: "provider", model: "model", api, stopReason: "toolUse", timestamp: 2 } as any,
    { role: "toolResult", toolCallId: `read-${api}`, toolName: "read", content: [{ type: "text", text: "result" }], isError: false, timestamp: 3 },
    { role: "custom", customType: "block-summary", content: "historical summary", display: false, timestamp: 4 },
  ];
  const entries = messages.map((message, index) => ({ type: "message", id: `entry-${index + 1}`, parentId: index ? `entry-${index}` : null, timestamp: new Date(index + 1).toISOString(), message }));
  return { messages, ctx: { cwd: "/tmp", model: { provider: "provider", id: "model", api, contextWindow: 20_000 }, getContextUsage: () => ({ tokens: null, contextWindow: 20_000 }), sessionManager: { buildContextEntries: () => entries, getLeafId: () => `entry-${entries.length}` } } as any };
}

describe("generic adapter transforms", () => {
  it.each(APIs)("transforms %s", (api) => {
    const { messages, ctx } = fixture(api);
    const result = transformOutgoingContext(messages, { ctx, sessionId: "s", generation: 1, state: emptyState(), config: structuredClone(defaults) as any });
    expect(result.snapshot).toBeDefined();
    expect(result.messages.some((message) => JSON.stringify(message).includes("pi-dcp-message-id"))).toBe(true);
    const thinking = (result.messages.find((message) => message.role === "assistant") as any)?.content.find((part: any) => part.type === "thinking");
    expect(thinking).toEqual({ type: "thinking", thinking: "opaque", thinkingSignature: "sig" });
  });
});
