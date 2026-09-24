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
export interface JoinMismatch {
  /** Session messages Pi projected but that did not reach DCP's `context` input unchanged. */
  missingExpected: number;
  /** Incoming messages that match no projected session message (other extensions' extras). */
  unexpectedIncoming: number;
}

/**
 * Count fingerprint differences between the projection and the incoming
 * context, as multisets. This is diagnostic only: it explains a raw fallback
 * to the user, and never influences whether the join is accepted.
 *
 * A nonzero `missingExpected` is the useful signal. DCP tolerates added
 * messages, but a session message that is absent from its input was changed or
 * removed before DCP saw it - usually by an earlier `context` handler.
 */
export function describeJoinMismatch(expected: readonly ProjectedMessage[], incoming: readonly AgentMessage[]): JoinMismatch {
  const available = new Map<string, number>();
  for (const message of incoming) {
    const fingerprint = fingerprintMessage(message);
    available.set(fingerprint, (available.get(fingerprint) || 0) + 1);
  }
  let missingExpected = 0;
  for (const item of expected) {
    const count = available.get(item.fingerprint) || 0;
    if (count > 0) available.set(item.fingerprint, count - 1);
    else missingExpected++;
  }
  let unexpectedIncoming = 0;
  for (const count of available.values()) unexpectedIncoming += count;
  return { missingExpected, unexpectedIncoming };
}

function search(candidates: readonly number[][], position: number, previous: number, current: number[], solutions: number[][], limit: number): void {
  if (solutions.length >= limit) return;
  if (position === candidates.length) { solutions.push([...current]); return; }
  for (const candidate of candidates[position]) { if (candidate <= previous) continue; current.push(candidate); search(candidates, position + 1, candidate, current, solutions, limit); current.pop(); }
}
