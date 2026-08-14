import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { deepClone } from "../util/clone.ts";
import type { ReducedState } from "../state/reducer.ts";
import { redactOldErrorArguments } from "../strategies/purge-errors.ts";
import { adapterForQuestion } from "../questions/registry.ts";

const CLEARED = "[Old tool result content cleared by pi-dcp]";
export function applyPersistedRedactions(messages: readonly AgentMessage[], state: ReducedState): AgentMessage[] {
  const output = deepClone([...messages]); for (const message of output) {
    if (message.role === "assistant") for (const part of message.content) if (part.type === "toolCall") { const prune = state.toolPrunes.get(part.id); if (prune?.oldErrorInput) part.arguments = redactOldErrorArguments(part.arguments) as Record<string, any>; const question = prune?.questionInput; if (question) { const adapter = adapterForQuestion(part.name, part.arguments); if (adapter) part.arguments = adapter.redact(part.arguments) as Record<string, any>; } }
    if (message.role === "toolResult") { const prune = state.toolPrunes.get(message.toolCallId); if (prune?.output) message.content = [{ type: "text", text: CLEARED }]; }
  } return output;
}
export function clearedMarker(): string { return CLEARED; }
