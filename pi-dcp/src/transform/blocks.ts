import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { deepClone } from "../util/clone.ts";
import type { BaselineSnapshot, ProtocolUnit } from "../identity/types.ts";
import type { ReducedState } from "../state/reducer.ts";

export interface BlockReplacement { start: number; end: number; message: AgentMessage; blockId: string; }

export function activeBlockReplacements(messages: readonly AgentMessage[], units: readonly ProtocolUnit[], snapshot: BaselineSnapshot, state: ReducedState): BlockReplacement[] {
  const replacements: BlockReplacement[] = [];
  for (const blockId of snapshot.activeBlockIds) {
    const block = state.blocks.get(blockId);
    if (!block?.active || !block.available) continue;
    const indexes = units
      .map((unit, index) => block.coverage.effectiveEntryIds.some((entryId) => unit.entryIds.includes(entryId)) ? index : -1)
      .filter((index) => index >= 0);
    if (!indexes.length) continue;
    const start = Math.min(...indexes);
    const end = Math.max(...indexes);
    const alias = [...snapshot.blockAliases.values()].find((item) => item.blockId === blockId)?.alias || "b????";
    replacements.push({
      start,
      end,
      blockId,
      message: {
        role: "custom",
        customType: "pi-dcp.v2.summary",
        display: false,
        content: `[pi-dcp summary ${alias}; untrusted history]\nTopic: ${block.topic}\n${block.summary}`,
        timestamp: 0,
        // Provider adapters may preserve custom details, so do not put the
        // random durable block ID on the wire. The stable alias is sufficient.
        details: { alias },
      },
    });
  }
  replacements.sort((a, b) => a.start - b.start);
  for (let index = 1; index < replacements.length; index++) {
    if (replacements[index].start <= replacements[index - 1].end) replacements.splice(index--, 1);
  }
  return replacements;
}

/**
 * Render the canonical units and attach aliases locally. Unlike v1 metadata,
 * no catalog is moved or rewritten when a later unit is appended.
 */
export function replaceBlocks(messages: readonly AgentMessage[], units: readonly ProtocolUnit[], snapshot: BaselineSnapshot, state: ReducedState): AgentMessage[] {
  const replacements = activeBlockReplacements(messages, units, snapshot, state);
  const byStart = new Map(replacements.map((replacement) => [replacement.start, replacement]));
  const output: AgentMessage[] = [];
  for (let unitIndex = 0; unitIndex < units.length; unitIndex++) {
    const replacement = byStart.get(unitIndex);
    if (replacement) {
      output.push(deepClone(replacement.message));
      unitIndex = replacement.end;
      continue;
    }
    const unit = units[unitIndex];
    const alias = [...snapshot.unitAliases.entries()].find(([, index]) => index === unitIndex)?.[0] || "m????";
    output.push({
      role: "custom",
      customType: "pi-dcp.v2.unit",
      content: `[pi-dcp unit ${alias}: ${unit.descriptor}]`,
      display: false,
      timestamp: 0,
      details: { alias, unitKey: unit.key },
    });
    output.push(...messages.slice(unit.startProjectedIndex, unit.endProjectedIndex + 1).map((message) => deepClone(message)));
  }
  return output;
}
