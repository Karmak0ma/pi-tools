import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { deepClone } from "../util/clone.ts";
import type { BaselineSnapshot, ProtocolUnit } from "../identity/types.ts";
import { unitAlias } from "../identity/snapshot.ts";

export const LABEL_TAG_NAME = "pi-dcp-message-id";

export function formatLabelTag(ref: string): string {
  return `\n<${LABEL_TAG_NAME}>${ref}</${LABEL_TAG_NAME}>`;
}

/**
 * Attach the local alias to the first message of each protocol unit. Labels
 * live beside the bytes they identify so the model can discover them without
 * a separately ordered catalog. The function clones every message because a
 * context transform must never mutate SessionManager's source messages.
 */
export function injectInlineLabels(
  messages: readonly AgentMessage[],
  units: readonly ProtocolUnit[],
  snapshot: BaselineSnapshot,
): AgentMessage[] {
  const output = deepClone([...messages]);
  let cursor = 0;
  for (let unitIndex = 0; unitIndex < units.length && cursor < output.length; unitIndex++) {
    const messageCount = units[unitIndex].endProjectedIndex - units[unitIndex].startProjectedIndex + 1;
    const end = Math.min(output.length, cursor + Math.max(1, messageCount));
    const group = output.slice(cursor, end);
    if (!group.length) continue;

    // This branch also makes the helper safe for callers that already rendered
    // block replacements. The normal pipeline labels source units first and
    // adds the block tag in blocks.ts, because a replacement has no source
    // messages left to inspect.
    const replacement = group[0];
    if (replacement?.role === "custom" && replacement.customType === "pi-dcp.v2.summary") {
      const alias = typeof replacement.details === "object" && replacement.details && "alias" in replacement.details
        ? String((replacement.details as { alias?: unknown }).alias || "b????")
        : "b????";
      const suffix = formatLabelTag(alias);
      const content = typeof replacement.content === "string" ? replacement.content : "";
      output[cursor] = content.endsWith(suffix) ? replacement : appendLabel(replacement, alias);
      const block = snapshot.blockAliases.get(alias);
      const range = block ? snapshot.blockRanges?.get(block.blockId) : undefined;
      if (range) unitIndex = range.end;
      cursor++;
      continue;
    }

    // BLOCKED here reflects only the permanent property `compressible`
    // (settled protocol structure). It deliberately excludes tool-output
    // protection (absorbed into summaries now, never a block reason - see
    // compression/protected.ts) and the turn-relative eligibility rules
    // (live user turn / recent-turns window / protectUserMessages - see
    // compression/eligibility.ts). Those rules necessarily shift which unit
    // they apply to as new turns are appended, so baking them into an inline
    // tag would change a historical message's bytes on every later
    // transform and defeat prompt-cache prefix stability. They are enforced
    // at actual compress-call time in service.ts and surfaced through the
    // transient, non-cached status/error text instead (prompts/status.ts,
    // compression/errors.ts).
    const unit = units[unitIndex];
    const tag = unit.compressible ? unitAlias(unitIndex) : "BLOCKED";
    output[cursor] = appendLabel(group[0], tag);
    cursor = end;
  }
  return output;
}

function appendLabel(message: AgentMessage, tag: string): AgentMessage {
  const suffix = formatLabelTag(tag);
  const next = deepClone(message) as any;
  if (next.role === "user" || next.role === "custom") {
    if (typeof next.content === "string") next.content += suffix;
    else if (Array.isArray(next.content)) next.content = [...next.content, { type: "text", text: suffix }];
    return next;
  }
  if (next.role === "assistant") {
    const lastText = [...next.content].map((part: any, index: number) => part.type === "text" ? index : -1).filter((index: number) => index >= 0).at(-1);
    if (lastText !== undefined && lastText >= 0) {
      next.content[lastText] = { ...next.content[lastText], text: `${next.content[lastText].text}${suffix}` };
    } else {
      // A trailing synthetic text part preserves thinking signatures and tool
      // call JSON exactly; no existing non-text part is reordered or edited.
      next.content = [...next.content, { type: "text", text: suffix }];
    }
    return next;
  }
  if (next.role === "toolResult") {
    next.content = [...next.content, { type: "text", text: suffix }];
    return next;
  }
  if (next.role === "compactionSummary" || next.role === "branchSummary") {
    next.summary += suffix;
    return next;
  }
  return next;
}

