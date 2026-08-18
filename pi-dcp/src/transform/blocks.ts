import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { deepClone } from "../util/clone.ts";
import type { BaselineSnapshot, ProtocolUnit } from "../identity/types.ts";
import type { ReducedState } from "../state/reducer.ts";
import { formatLabelTag } from "./labels.ts";

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
        content: `[pi-dcp summary ${alias}; untrusted history]\nTopic: ${block.topic}\n${block.summary}${formatLabelTag(alias)}`,
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
export interface BlockRenderResult {
  messages: AgentMessage[];
  /** Output associated with each projected message; an empty array means the
   * source message was covered by a block replacement. */
  byProjectedIndex: AgentMessage[][];
}

export function replaceBlocksWithOrigins(messages: readonly AgentMessage[], units: readonly ProtocolUnit[], snapshot: BaselineSnapshot, state: ReducedState): BlockRenderResult {
  const replacements = activeBlockReplacements(messages, units, snapshot, state);
  const byStart = new Map(replacements.map((replacement) => [replacement.start, replacement]));
  const byProjectedIndex = messages.map(() => [] as AgentMessage[]);
  for (let unitIndex = 0; unitIndex < units.length; unitIndex++) {
    const unit = units[unitIndex];
    const replacement = byStart.get(unitIndex);
    if (replacement) {
      byProjectedIndex[unit.startProjectedIndex]?.push(deepClone(replacement.message));
      for (let covered = replacement.start + 1; covered <= replacement.end; covered++) {
        const coveredUnit = units[covered];
        if (!coveredUnit) continue;
        for (let projected = coveredUnit.startProjectedIndex; projected <= coveredUnit.endProjectedIndex; projected++) byProjectedIndex[projected] = [];
      }
      unitIndex = replacement.end;
      continue;
    }
    for (let projected = unit.startProjectedIndex; projected <= unit.endProjectedIndex; projected++) {
      const message = messages[projected];
      if (message) byProjectedIndex[projected]?.push(deepClone(message));
    }
  }
  return { messages: byProjectedIndex.flat(), byProjectedIndex };
}

export function replaceBlocks(messages: readonly AgentMessage[], units: readonly ProtocolUnit[], snapshot: BaselineSnapshot, state: ReducedState): AgentMessage[] {
  return replaceBlocksWithOrigins(messages, units, snapshot, state).messages;
}
