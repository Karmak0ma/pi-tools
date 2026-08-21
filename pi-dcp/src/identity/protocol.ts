import { hashJson } from "../util/hash.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CanonicalIndex, ProjectedMessage, ProtocolUnit } from "./types.ts";

export function buildProtocolUnits(projected: readonly ProjectedMessage[]): CanonicalIndex | { ok: false; reason: "protocol_invalid" } {
  const units: ProtocolUnit[] = [];
  const messageToUnit = new Map<string, number>();
  const toolCalls = new Map<string, { index: number; name: string }>();
  const toolResults = new Map<string, number>();
  for (let index = 0; index < projected.length; index++) {
    const item = projected[index];
    if (item.message.role === "assistant") for (const part of item.message.content) if (part.type === "toolCall") { if (toolCalls.has(part.id)) return { ok: false, reason: "protocol_invalid" }; toolCalls.set(part.id, { index, name: part.name }); }
    if (item.message.role === "toolResult") { if (toolResults.has(item.message.toolCallId)) return { ok: false, reason: "protocol_invalid" }; toolResults.set(item.message.toolCallId, index); const call = toolCalls.get(item.message.toolCallId); if (call && call.name !== item.message.toolName) return { ok: false, reason: "protocol_invalid" }; }
  }
  const consumed = new Set<number>();
  for (let index = 0; index < projected.length; index++) {
    if (consumed.has(index)) continue;
    const item = projected[index];
    if (item.message.role === "assistant") {
      const calls = item.message.content.filter((part): part is Extract<typeof part, { type: "toolCall" }> => part.type === "toolCall");
      if (calls.length > 0) {
        const resultIndices = calls.map((call) => toolResults.get(call.id));
        const settled = resultIndices.every((result): result is number => result !== undefined && result > index);
        const end = settled ? Math.max(index, ...resultIndices as number[]) : index;
        const contiguous = settled && projected.slice(index, end + 1).every((candidate) => candidate === item || candidate.message.role === "toolResult");
        units.push(makeUnit(projected.slice(index, end + 1), index, end, settled && contiguous));
        for (let i = index; i <= end; i++) consumed.add(i);
        continue;
      }
    }
    const resultCall = item.message.role === "toolResult" ? toolCalls.get(item.message.toolCallId) : undefined;
    units.push(makeUnit([item], index, index, item.message.role !== "toolResult" || (resultCall !== undefined && resultCall.index < index && resultCall.name === item.message.toolName)));
    consumed.add(index);
  }
  const unitForProjected = new Map<number, number>();
  for (let unitIndex = 0; unitIndex < units.length; unitIndex++) for (let projectedIndex = units[unitIndex].startProjectedIndex; projectedIndex <= units[unitIndex].endProjectedIndex; projectedIndex++) unitForProjected.set(projectedIndex, unitIndex);
  for (const [toolCallId, resultIndex] of toolResults) { const call = toolCalls.get(toolCallId); if (!call || resultIndex <= call.index || unitForProjected.get(call.index) !== unitForProjected.get(resultIndex)) return { ok: false, reason: "protocol_invalid" }; }
  for (let i = 0; i < units.length; i++) for (const key of units[i].messageKeys) messageToUnit.set(`${key.entryId}:${key.projection}`, i);
  return { entries: [...projected], units, messageToUnit };
}

function makeUnit(items: readonly ProjectedMessage[], start: number, end: number, settled: boolean): ProtocolUnit {
  const messageKeys = items.map((item) => item.key);
  const entryIds = [...new Set(items.map((item) => item.key.entryId))];
  const toolCallIds = [...new Set(items.flatMap((item) => item.toolCallIds))];
  const first = items[0]?.message;
  // A bashExecution message has no content array where DCP can attach a stable
  // model-facing alias. Keep it canonical for exact joining, but do not let a
  // caller select an invisible alias or remove shell provenance via a block.
  const permanentlyBlocked = first?.role === "custom"
    || first?.role === "compactionSummary"
    || first?.role === "branchSummary"
    || first?.role === "bashExecution";
  return { key: hashJson({ keys: messageKeys, calls: toolCallIds }), entryIds, messageKeys, toolCallIds, startProjectedIndex: start, endProjectedIndex: end, settled, compressible: settled && !permanentlyBlocked, role: first?.role || "unknown", descriptor: describe(first), contentDigest: hashJson(items.map((item) => item.fingerprint)) };
}
function describe(message: AgentMessage | undefined): string { if (!message) return "unknown"; if (message.role === "user") return "user intent"; if (message.role === "assistant") return message.content.some((part) => part.type === "toolCall") ? "tool exchange" : "assistant response"; if (message.role === "toolResult") return "tool result"; if (message.role === "bashExecution") return "shell execution"; return message.role; }
