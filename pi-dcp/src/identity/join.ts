import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fingerprintMessage } from "./fingerprint.ts";
import type { ProjectedMessage, JoinResult } from "./types.ts";

export function joinProjectedMessages(expected: readonly ProjectedMessage[], incoming: readonly AgentMessage[]): JoinResult {
  const incomingFingerprints = incoming.map(fingerprintMessage);
  // Duplicate fingerprints among `expected` are not preemptively rejected:
  // equal-fingerprint messages are content-identical by construction, so any
  // order-preserving pairing between them produces the same labeled output.
  // The search below still fails closed on genuine ambiguity (0 or >1
  // strictly-increasing solutions) — e.g. an inserted extra that duplicates
  // an expected fingerprint and creates a second valid mapping.
  const candidates = expected.map((item) => incomingFingerprints.map((fingerprint, index) => fingerprint === item.fingerprint ? index : -1).filter((index) => index >= 0));
  const solutions: number[][] = [];
  search(candidates, 0, -1, [], solutions, 2);
  if (solutions.length !== 1) return { ok: false, reason: "join_ambiguous" };
  const mapping = solutions[0];
  const seenCalls = new Set<string>();
  for (const message of incoming) if (message.role === "assistant") for (const part of message.content) if (part.type === "toolCall") { if (seenCalls.has(part.id)) return { ok: false, reason: "protocol_invalid" }; seenCalls.add(part.id); }
  return { ok: true, incomingByExpected: mapping };
}
function search(candidates: readonly number[][], position: number, previous: number, current: number[], solutions: number[][], limit: number): void {
  if (solutions.length >= limit) return;
  if (position === candidates.length) { solutions.push([...current]); return; }
  for (const candidate of candidates[position]) { if (candidate <= previous) continue; current.push(candidate); search(candidates, position + 1, candidate, current, solutions, limit); current.pop(); }
}
