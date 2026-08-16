import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { projectContextEntries } from "../../src/identity/project.ts";
import { buildProtocolUnits } from "../../src/identity/protocol.ts";
import { joinProjectedMessages } from "../../src/identity/join.ts";
import { createSnapshot } from "../../src/identity/snapshot.ts";
import { emptyState, reduceEnvelope } from "../../src/state/reducer.ts";
import { buildCompressionEnvelope } from "../../src/compression/service.ts";
import { createEnvelope } from "../../src/state/operations.ts";
import { transformOutgoingContext } from "../../src/transform/pipeline.ts";
import { defaults } from "../../src/config/defaults.ts";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function messages(): AgentMessage[] { return [
  { role: "user", content: "first", timestamp: 1 },
  { role: "assistant", content: [{ type: "text", text: "answer" }, { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a" } }], api: "openai-completions", provider: "openai", model: "m", usage, stopReason: "toolUse", timestamp: 2 },
  { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "contents" }], isError: false, timestamp: 3 },
  { role: "user", content: [{ type: "text", text: "latest" }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }], timestamp: 4 },
]; }
function entries(): any[] { return messages().map((message, index) => ({ type: "message", id: `e${index + 1}`, parentId: index ? `e${index}` : null, timestamp: new Date(1000 * (index + 1)).toISOString(), message })); }
function fakeContext(entriesValue: any[], inputModel: any = { provider: "openai", id: "m", api: "openai-completions", contextWindow: 128000 }) { return { cwd: "/tmp", model: inputModel, getContextUsage: () => ({ tokens: null, contextWindow: 128000, percent: null }), sessionManager: { buildContextEntries: () => entriesValue, getLeafId: () => "e4", getSessionId: () => "s", getSessionFile: () => undefined }, } as any; }

describe("identity and protocol foundation", () => {
  it("projects Pi 0.84.1 entries and joins a cloned context", () => { const projection = projectContextEntries(entries()); expect(projection.ok).toBe(true); if (!projection.ok) return; const joined = joinProjectedMessages(projection.messages, messages()); expect(joined).toEqual({ ok: true, incomingByExpected: [0, 1, 2, 3] }); const index = buildProtocolUnits(projection.messages); expect("units" in index && index.units).toHaveLength(3); if ("units" in index) expect(index.units[1].toolCallIds).toEqual(["call-1"]); });
  it("rejects ambiguous or unrelated context instead of transforming it", () => { const projection = projectContextEntries(entries()); if (!projection.ok) throw new Error("projection"); expect(joinProjectedMessages(projection.messages, messages().slice(0, 3))).toEqual({ ok: false, reason: "join_ambiguous" }); });
});

describe("atomic compression", () => {
  it("creates one envelope for one range and replays it idempotently", () => { const projection = projectContextEntries(entries()); if (!projection.ok) throw new Error("projection"); const index = buildProtocolUnits(projection.messages); if (!("units" in index)) throw new Error("protocol"); const snapshot = createSnapshot({ sessionId: "s", leafId: "e4", model: { provider: "openai", id: "m", api: "openai-completions", contextWindow: 128000 }, generation: 1, ttlMs: 600000, index, state: emptyState(), configHash: "config" }); const built = buildCompressionEnvelope({ sessionId: "s", extensionVersion: "0.1.0", snapshot, state: emptyState(), params: { topic: "old work", content: [{ startId: "m0001", endId: "m0002", summary: "first work is complete" }] }, model: undefined, toolCallId: "call-compress" }); expect(built.ok).toBe(true); if (!built.ok) return; const reduced = reduceEnvelope(emptyState(), built.envelope); expect(reduced.blocks.size).toBe(1); expect(reduced.runs.size).toBe(1); expect(reduceEnvelope(reduced, built.envelope).operationCount).toBe(1); });
});

describe("outgoing lens", () => {
  it("returns an immutable transformed context and preserves the latest user unit", () => { const projection = projectContextEntries(entries()); if (!projection.ok) throw new Error("projection"); const index = buildProtocolUnits(projection.messages); if (!("units" in index)) throw new Error("protocol"); const snapshot = createSnapshot({ sessionId: "s", leafId: "e4", model: { provider: "openai", id: "m", api: "openai-completions", contextWindow: 128000 }, generation: 1, ttlMs: 600000, index, state: emptyState(), configHash: "config" }); const built = buildCompressionEnvelope({ sessionId: "s", extensionVersion: "0.1.0", snapshot, state: emptyState(), params: { topic: "old work", content: [{ startId: "m0001", endId: "m0002", summary: "first work is complete" }] }, model: undefined, toolCallId: "call-compress" }); if (!built.ok) throw new Error(built.reason); const state = reduceEnvelope(emptyState(), built.envelope); const input = messages(); const before = structuredClone(input); const result = transformOutgoingContext(input, { ctx: fakeContext(entries()), sessionId: "s", generation: 2, state, config: defaults as any }); expect(input).toEqual(before); expect(result.changed).toBe(true); expect(result.messages.some((message) => message.role === "custom" && message.customType === "pi-dcp.v2.summary")).toBe(true); expect(result.messages.some((message) => message.role === "user" && (typeof message.content === "string" ? message.content : "") === "first")).toBe(false); expect(result.messages.some((message) => message.role === "user" && Array.isArray(message.content))).toBe(true); });
});
