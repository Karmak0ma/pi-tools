import { describe, expect, it } from "vitest";
import { relocateCacheBreakpoint } from "../../src/transform/cache-breakpoint.ts";
import { STATUS_PREFIX } from "../../src/prompts/status.ts";

const cc = { type: "ephemeral" };

function statusMessage(marked = true) {
  return { role: "user", content: [{ type: "text", text: `${STATUS_PREFIX} Compression ready. Current labels: m0001-m0002.`, ...(marked ? { cache_control: cc } : {}) }] };
}

function anthropicPayload(messages: unknown[]) {
  return { model: "claude-opus-5", system: [{ type: "text", text: "system", cache_control: cc }], messages };
}

describe("cache breakpoint relocation", () => {
  it("moves the tail breakpoint onto the last stable history block", () => {
    const payload = anthropicPayload([
      { role: "user", content: [{ type: "text", text: "prompt" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "..." }, { type: "tool_use", id: "t1", name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "out" }] },
      statusMessage(),
    ]) as any;

    relocateCacheBreakpoint(payload);

    expect(payload.messages[3].content[0].cache_control).toBeUndefined();
    expect(payload.messages[2].content[0].cache_control).toEqual(cc);
    expect(payload.system[0].cache_control).toEqual(cc);
  });

  it("keeps the marked prefix stable as the conversation grows", () => {
    const history: unknown[] = [{ role: "user", content: [{ type: "text", text: "prompt" }] }];
    // Content of every message up to and including the marked one, with the
    // markers stripped: this is the prefix Anthropic stores and matches on.
    const cachedPrefix = () => {
      const payload = anthropicPayload([...history.map((m) => structuredClone(m)), statusMessage()]) as any;
      relocateCacheBreakpoint(payload);
      const index = payload.messages.findIndex((m: any) => m.content.some((b: any) => b.cache_control));
      expect(index).toBeGreaterThanOrEqual(0);
      const prefix = payload.messages.slice(0, index + 1);
      for (const message of prefix) for (const block of message.content) delete block.cache_control;
      return JSON.stringify(prefix).slice(1, -1);
    };

    const first = cachedPrefix();
    history.push({ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] });
    history.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "out" }] });
    const second = cachedPrefix();

    // The turn-one cached prefix is still a prefix of the turn-two request, so
    // turn two reads it instead of re-writing the history.
    expect(second.startsWith(first)).toBe(true);
    expect(second.length).toBeGreaterThan(first.length);
  });

  it("skips thinking blocks, which cannot carry cache_control", () => {
    const payload = anthropicPayload([
      { role: "user", content: [{ type: "text", text: "prompt" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "..." }] },
      statusMessage(),
    ]) as any;

    relocateCacheBreakpoint(payload);

    expect(payload.messages[1].content[0].cache_control).toBeUndefined();
    expect(payload.messages[0].content[0].cache_control).toEqual(cc);
  });

  it("does not add a second breakpoint when history already carries one", () => {
    const payload = anthropicPayload([
      { role: "user", content: [{ type: "text", text: "prompt", cache_control: cc }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "out" }] },
      statusMessage(),
    ]) as any;

    relocateCacheBreakpoint(payload);

    expect(payload.messages[2].content[0].cache_control).toBeUndefined();
    expect(payload.messages[1].content[0].cache_control).toBeUndefined();
    expect(payload.messages[0].content[0].cache_control).toEqual(cc);
  });

  it("leaves a tail that is not the status suffix untouched", () => {
    const payload = anthropicPayload([
      { role: "user", content: [{ type: "text", text: "prompt" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "out", cache_control: cc }] },
    ]) as any;

    relocateCacheBreakpoint(payload);

    expect(payload.messages[1].content[0].cache_control).toEqual(cc);
    expect(payload.messages[0].content[0].cache_control).toBeUndefined();
  });

  it("is a no-op when caching is off or the payload is another provider's shape", () => {
    const unmarked = anthropicPayload([{ role: "user", content: [{ type: "text", text: "prompt" }] }, statusMessage(false)]) as any;
    expect(relocateCacheBreakpoint(unmarked)).toBe(unmarked);
    expect(JSON.stringify(unmarked)).not.toContain("cache_control\":{\"type\":\"ephemeral\"},\"messages");

    const openai = { model: "gpt", messages: [{ role: "user", content: "prompt" }, { role: "user", content: `${STATUS_PREFIX} ready` }] };
    expect(JSON.stringify(relocateCacheBreakpoint(openai))).toEqual(JSON.stringify(openai));

    expect(relocateCacheBreakpoint(undefined)).toBeUndefined();
    expect(relocateCacheBreakpoint({ messages: [] })).toEqual({ messages: [] });
  });
});
