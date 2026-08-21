import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { deepClone } from "../util/clone.ts";
import type { BaselineSnapshot, ProtocolUnit } from "../identity/types.ts";
import { unitAlias } from "../identity/snapshot.ts";

export const LABEL_TAG_NAME = "pi-dcp-message-id";

export function formatLabelTag(ref: string): string {
  return `\n<${LABEL_TAG_NAME}>${ref}</${LABEL_TAG_NAME}>`;
}

/**
 * Would the provider actually send this message?
 *
 * Provider adapters drop messages that carry no usable content. Pi's Anthropic
 * adapter filters whitespace-only text blocks and empty unsigned thinking
 * blocks, then skips the whole message with `if (blocks.length === 0) continue`
 * (pi-ai/dist/api/anthropic-messages.js). A message Pi decided to drop must stay
 * dropped.
 *
 * This guard exists because label injection is content: appending a
 * <pi-dcp-message-id> tag to an otherwise-empty message makes it non-empty, so
 * the adapter starts sending a message it had deliberately omitted. When that
 * message is the tail - an assistant turn that stopped with no visible text -
 * the conversation then ends with an assistant message, and Anthropic rejects
 * the whole request with "This model does not support assistant message
 * prefill. The conversation must end with a user message." (2026-08-19
 * incident, reproduced in test/unit/label-visibility.test.ts).
 *
 * The rule for pi-dcp is therefore: annotate what the provider sends, never
 * change what the provider sends. Deciding message visibility belongs to Pi and
 * its adapters, and pi-dcp must not silently overrule it in either direction.
 */
export function hasProviderVisibleContent(message: AgentMessage): boolean {
  const value = message as any;
  // Pi drops incomplete turns before the adapter runs, on stop reason alone and
  // regardless of content (pi-ai transformMessages: "Skip errored/aborted
  // assistant messages entirely"). Labelling one is wasted bytes at best.
  if (value.role === "assistant" && (value.stopReason === "error" || value.stopReason === "aborted")) return false;
  // A toolResult always becomes a tool_result block, even with empty content:
  // the block is required to answer its tool_use, so it is never dropped.
  if (value.role === "toolResult") return true;
  // Summaries are rendered through a non-empty prefix/suffix by convertToLlm.
  if (value.role === "compactionSummary" || value.role === "branchSummary") return true;

  const content = value.content;
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((part: any) => {
    if (!part || typeof part !== "object") return false;
    if (part.type === "text") return typeof part.text === "string" && part.text.trim().length > 0;
    if (part.type === "thinking") return !!part.redacted || (part.thinking || "").trim().length > 0 || (part.thinkingSignature || "").trim().length > 0;
    // toolCall, image and any other structured part is always sent verbatim.
    return true;
  });
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
    // transient, non-cached nudge/error text instead (prompts/nudge.ts,
    // compression/errors.ts).
    const unit = units[unitIndex];
    const tag = unit.compressible ? unitAlias(unitIndex) : "BLOCKED";
    // Anchor the label on the first message the provider will actually send.
    // Skipping invisible messages keeps them invisible (see
    // hasProviderVisibleContent). A unit with no visible message at all gets no
    // label: the model cannot reference content it cannot see, and the unit
    // still keeps its ordinal, because unitAlias() is positional - nothing is
    // renumbered and every other label stays byte-identical.
    const offset = group.findIndex((message) => hasProviderVisibleContent(message));
    if (offset >= 0) output[cursor + offset] = appendLabel(group[offset], tag);
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
      return next;
    }
    // No text part to extend, so a new one is synthesized. It MUST NOT go at
    // the end when the turn contains tool calls: Anthropic treats an assistant
    // message whose content ends with a text block as a prefill, and
    // claude-opus-5 rejects the whole request with "This model does not support
    // assistant message prefill. The conversation must end with a user
    // message." - even when the last message really is a user message. That is
    // the 2026-08-19 incident; it only ever fired after a silent tool call,
    // because that is the only case where a turn has tool calls and no text of
    // its own. Inserting before the first tool call keeps the natural shape
    // Claude itself produces (thinking, then text, then tool_use last) and
    // leaves thinking signatures and tool call JSON untouched.
    const part = { type: "text", text: suffix };
    const firstToolCall = next.content.findIndex((item: any) => item.type === "toolCall");
    next.content = firstToolCall >= 0
      ? [...next.content.slice(0, firstToolCall), part, ...next.content.slice(firstToolCall)]
      : [...next.content, part];
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

