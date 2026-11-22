import { describe, expect, it } from "vitest";
import { buildProtocolUnits } from "../../src/identity/protocol.ts";
import { deduplicate } from "../../src/strategies/deduplicate.ts";
import { estimateOutputPruneTokens, estimateTokens, estimateToolResultTokens, IMAGE_TOKEN_COST } from "../../src/tokens/estimate.ts";
import { projectCurrentEntries } from "../helpers/current-host.ts";

/** Base64 text of a roughly 3 MB PNG. The old rule charged every character of it as text. */
const LARGE_PNG = "A".repeat(4 * 1024 * 1024);
const READ_TEXT = "Read image file [image/png]";
const READ_TEXT_TOKENS = Math.ceil(READ_TEXT.length / 4);

function imageResult(toolCallId: string, data: string, timestamp: number): any {
  return { role: "toolResult", toolCallId, toolName: "read", content: [{ type: "text", text: READ_TEXT }, { type: "image", data, mimeType: "image/png" }], isError: false, timestamp };
}

function assistantRead(toolCallId: string, timestamp: number): any {
  return { role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "screenshot.png" } }], api: "test", provider: "test", model: "model", stopReason: "toolUse", timestamp };
}

function indexOf(messages: any[]) {
  const entries = messages.map((message, index) => ({ type: "message", id: `entry-${index + 1}`, parentId: index ? `entry-${index}` : null, timestamp: new Date(index + 1).toISOString(), message }));
  const projection = projectCurrentEntries(entries as any);
  if (!projection.ok) throw new Error(projection.reason);
  const index = buildProtocolUnits(projection.messages);
  if (!("units" in index)) throw new Error(index.reason);
  return index;
}

describe("token estimate for images and tool results", () => {
  it("charges an image a fixed cost, whatever its base64 size", () => {
    expect(estimateTokens([imageResult("read-1", LARGE_PNG, 1)]).total).toBe(IMAGE_TOKEN_COST + READ_TEXT_TOKENS);
    expect(estimateTokens([imageResult("read-1", "AAAA", 1)]).total).toBe(IMAGE_TOKEN_COST + READ_TEXT_TOKENS);
  });

  it("counts text parts as their text, not as their JSON wrapper", () => {
    // JSON.stringify escapes every quote and newline, so the old rule overcounted code.
    const code = 'const label = "x";\n'.repeat(100);
    expect(estimateToolResultTokens({ content: [{ type: "text", text: code }] })).toBe(Math.ceil(code.length / 4));
  });

  it("keeps the source estimate and the pruning decision on one rule", () => {
    const result = imageResult("read-1", LARGE_PNG, 1);
    expect(estimateToolResultTokens(result)).toBe(estimateTokens([result]).categories.toolResults);
    // A real decision is never 0: 0 means "already counted by an earlier decision".
    expect(estimateOutputPruneTokens({ content: [] })).toBe(1);
  });
});

describe("dedup decisions use the shared estimate", () => {
  it("records the image cost, not the base64 size, for a duplicated read", () => {
    const index = indexOf([
      { role: "user", content: "inspect the screenshot", timestamp: 1 },
      assistantRead("read-old", 2),
      imageResult("read-old", LARGE_PNG, 3),
      { role: "user", content: "inspect it again", timestamp: 4 },
      assistantRead("read-new", 5),
      imageResult("read-new", LARGE_PNG, 6),
      { role: "user", content: "what changed", timestamp: 7 },
    ]);

    const decisions = deduplicate(index, { cwd: "/tmp", protectedTools: [], protectedFilePatterns: [] });

    expect(decisions).toEqual([{ toolCallId: "read-old", kind: "dedup-output", estimatedTokens: IMAGE_TOKEN_COST + READ_TEXT_TOKENS }]);
  });
});
