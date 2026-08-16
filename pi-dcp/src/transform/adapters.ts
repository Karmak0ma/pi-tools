import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ModelKey, ProtocolUnit } from "../identity/types.ts";

/**
 * pi-dcp is intentionally adapter-scoped. A provider conversion can merge
 * adjacent roles or discard custom-message metadata, so an extension-wide
 * cache claim would be unsound without a named certification boundary.
 */
export interface AliasTransportAdapter {
  id: string;
  annotate(messages: readonly AgentMessage[], units: readonly ProtocolUnit[]): AgentMessage[];
  /** Deterministic pre-dispatch representation used by cache differential tests. */
  canonicalWire(messages: readonly AgentMessage[]): unknown;
  validateWire(wire: unknown): { ok: true } | { ok: false; reason: string };
}

const certified = new Map<string, AliasTransportAdapter>([
  ["openai-completions", makeAdapter("openai-chat-completions")],
  ["openai-responses", makeAdapter("openai-responses")],
  ["opencode-cli-runner", makeAdapter("opencode-cli-runner")],
  // A deliberately explicit fixture adapter used by deterministic unit tests.
  ["test", makeAdapter("test-fixture")],
]);

export function adapterForModel(model: Pick<ModelKey, "api">): AliasTransportAdapter | undefined { return certified.get(model.api); }
export function isCertifiedAdapter(model: Pick<ModelKey, "api">): boolean { return adapterForModel(model) !== undefined; }
export function certifiedAdapterIds(): string[] { return [...certified.keys()]; }

function makeAdapter(id: string): AliasTransportAdapter {
  return {
    id,
    // Annotation is performed by transform/blocks.ts so replacements and
    // protocol-unit boundaries can share one deterministic implementation.
    annotate: (messages, _units) => [...messages],
    canonicalWire: (messages) => messages.map((message) => {
      // Details and timestamps are intentionally excluded: Pi provider
      // adapters do not treat them as model content, and including them would
      // make an internal random block ID observable in a wire diagnostic.
      if (message.role === "custom") return { role: "user", content: message.content };
      if (message.role === "compactionSummary") return { role: "user", content: message.summary };
      if (message.role === "branchSummary") return { role: "user", content: message.summary };
      if (message.role === "toolResult") return { role: "tool", toolCallId: message.toolCallId, toolName: message.toolName, content: message.content, isError: message.isError };
      return { role: message.role, content: "content" in message ? message.content : undefined };
    }),
    validateWire: (wire) => Array.isArray(wire) && wire.every((message) => !!message && typeof message === "object" && typeof (message as { role?: unknown }).role === "string")
      ? { ok: true }
      : { ok: false, reason: "wire_not_array" },
  };
}
