/**
 * Replay a real session through pi-dcp AND the real Anthropic adapter, and
 * report the exact payload that would be dispatched.
 *
 * This is the offline equivalent of PI_CLAUDE_CODE_USE_DEBUG_LOG: instead of
 * hand-simulating the adapter (which hid the bug once already), it calls
 * pi-ai's real `stream()` and intercepts `options.onPayload` - the same hook
 * Pi's sdk.js uses to expose the payload to `before_provider_request`. The
 * network call is aborted immediately afterwards.
 *
 * Usage: node --experimental-strip-types scripts/replay-session-payload.ts <session.jsonl> [entryLimit]
 */
import { readFileSync } from "node:fs";
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { transformOutgoingContext } from "../src/transform/pipeline.ts";
import { reconstructFromBranch } from "../src/state/reconstruct.ts";
import { defaults } from "../src/config/defaults.ts";

const file = process.argv[2];
if (!file) {
  console.error("usage: replay-session-payload.ts <session.jsonl> [entryLimit]");
  process.exit(2);
}

let entries: any[] = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
// The persisted failure record did not exist when the failing request was sent.
while (entries.at(-1)?.message?.stopReason === "error") entries = entries.slice(0, -1);
if (process.argv[3]) entries = entries.slice(0, Number(process.argv[3]));
// buildContextEntries() does not surface the session header entry.
const contextEntries = entries.filter((entry) => entry.type !== "session");
const messages = entries.filter((entry) => entry.type === "message").map((entry) => entry.message);

const model: any = {
  id: "claude-opus-5", provider: "anthropic", api: "anthropic-messages",
  contextWindow: 200_000, maxTokens: 8192, input: ["text", "image"], reasoning: true,
  baseUrl: "https://api.anthropic.com", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const ctx: any = {
  cwd: "/tmp", model,
  getContextUsage: () => ({ tokens: null, contextWindow: 200_000 }),
  sessionManager: { buildContextEntries: () => contextEntries, getLeafId: () => contextEntries.at(-1)?.id ?? null },
};

function report(label: string, list: any[]) {
  // Pi's convertToLlm: custom / summaries / bashExecution all become user.
  const llm = list.map((m: any) =>
    (m.role === "custom" || m.role === "branchSummary" || m.role === "compactionSummary" || m.role === "bashExecution")
      ? { role: "user", content: typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? [{ type: "text", text: m.summary ?? "" }]), timestamp: m.timestamp ?? 0 }
      : m);

  let captured: any;
  const handle = stream(model, { systemPrompt: "system", messages: llm, tools: [] } as any, {
    apiKey: "sk-ant-not-a-real-key",
    onPayload: (payload: any) => { captured = payload; throw new Error("__captured__"); },
  } as any);
  // Drain so the async body runs; the thrown error stops it before any network I/O.
  return (async () => {
    try { for await (const _ of handle as any) { /* no-op */ } } catch { /* expected */ }
    const wire = captured?.messages ?? [];
    console.log(`\n=== ${label} ===`);
    wire.forEach((m: any, i: number) => {
      const blocks = Array.isArray(m.content) ? m.content.map((b: any) => b.type).join("+") : "string";
      console.log(`${String(i).padStart(3)} ${m.role.padEnd(9)} ${blocks}`);
    });
    console.log(`TAIL ROLE: ${wire.at(-1)?.role}${wire.at(-1)?.role === "assistant" ? "   <-- 400 assistant prefill" : ""}`);
    return wire;
  })();
}

const rebuilt = reconstructFromBranch(contextEntries as any);
const result = transformOutgoingContext(messages, {
  ctx, sessionId: "replay", generation: 1, state: rebuilt.state, config: structuredClone(defaults) as any,
});
console.log(`transform changed=${result.changed} reason=${result.reason} blocks=${rebuilt.state.blocks.size}`);

await report("WITHOUT pi-dcp", messages);
await report("WITH pi-dcp", result.messages as any[]);
