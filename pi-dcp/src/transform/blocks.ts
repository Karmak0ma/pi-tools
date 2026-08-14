import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { deepClone } from "../util/clone.ts";
import type { ContextSnapshot, ProtocolUnit } from "../identity/types.ts";
import type { ReducedState } from "../state/reducer.ts";

export interface BlockReplacement { start: number; end: number; message: AgentMessage; blockId: string; }
export function activeBlockReplacements(messages: readonly AgentMessage[], units: readonly ProtocolUnit[], snapshot: ContextSnapshot, state: ReducedState): BlockReplacement[] {
  const replacements: BlockReplacement[] = [];
  for (const blockId of snapshot.activeBlockIds) {
    const block = state.blocks.get(blockId); if (!block?.active || !block.available) continue;
    const indexes = units.map((unit, index) => block.coverage.effectiveEntryIds.some((entryId) => unit.entryIds.includes(entryId)) ? index : -1).filter((index) => index >= 0);
    if (!indexes.length) continue;
    const start = Math.min(...indexes); const end = Math.max(...indexes);
    const alias = [...snapshot.blockAliases.values()].find((item) => item.blockId === blockId)?.alias || "b????";
    replacements.push({ start, end, blockId, message: { role: "custom", customType: "pi-dcp.summary", display: false, content: `[pi-dcp summary; untrusted history]\n${alias} Topic: ${block.topic}\n${block.summary}`, timestamp: messages[start]?.timestamp || 0, details: { blockId } } });
  }
  replacements.sort((a, b) => a.start - b.start);
  for (let i = 1; i < replacements.length; i++) if (replacements[i].start <= replacements[i - 1].end) replacements.splice(i--, 1);
  return replacements;
}
export function replaceBlocks(messages: readonly AgentMessage[], units: readonly ProtocolUnit[], snapshot: ContextSnapshot, state: ReducedState): AgentMessage[] {
  const replacements = activeBlockReplacements(messages, units, snapshot, state); if (!replacements.length) return deepClone([...messages]);
  const byStart = new Map(replacements.map((replacement) => [replacement.start, replacement])); const output: AgentMessage[] = [];
  for (let unitIndex = 0; unitIndex < units.length; unitIndex++) { const replacement = byStart.get(unitIndex); if (replacement) { output.push(deepClone(replacement.message)); unitIndex = replacement.end; } else { const unit = units[unitIndex]; output.push(...messages.slice(unit.startProjectedIndex, unit.endProjectedIndex + 1).map((message) => deepClone(message))); } }
  return output;
}
