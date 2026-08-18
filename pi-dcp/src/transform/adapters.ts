import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ModelKey, ProtocolUnit } from "../identity/types.ts";

/**
 * Provider conversion is deliberately represented by one conservative generic
 * adapter. pi-dcp validates the canonical wire shape after every transform;
 * an allow-list would make otherwise valid pi-ai APIs fail before that safety
 * net can run.
 */
export interface AliasTransportAdapter {
  id: string;
  annotate(messages: readonly AgentMessage[], units: readonly ProtocolUnit[]): AgentMessage[];
  /** Deterministic pre-dispatch representation used by cache differential tests. */
  canonicalWire(messages: readonly AgentMessage[]): unknown;
  validateWire(wire: unknown): { ok: true } | { ok: false; reason: string };
}

const KNOWN_ADAPTER_IDS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "azure-openai-responses",
  "google-generative-ai",
  "openai-codex-responses",
] as const;

/** Every API receives the same conservative transport representation. */
export function adapterForModel(model: Pick<ModelKey, "api">): AliasTransportAdapter {
  return makeAdapter(model.api || "unknown");
}

/** Diagnostics-only inventory; this list never gates a transform. */
export function knownAdapterIds(): string[] { return [...KNOWN_ADAPTER_IDS]; }

export function makeAdapter(id: string): AliasTransportAdapter {
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
