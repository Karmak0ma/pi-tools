import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { LABEL_TAG_NAME } from "./labels.ts";

/**
 * Matches one inline label tag as formatLabelTag() writes it, including the
 * leading newline(s) that surround it. A model can stop generation immediately
 * after copying the opening tag (or its alias), usually because a tool call
 * follows. The truncated alternatives are therefore intentional: leaving an
 * opening-only tag in the transcript leaks bookkeeping into the UI and lets
 * the next context transform treat model text as a real label.
 *
 * The truncated form is restricted to aliases pi-dcp can actually emit and to
 * whitespace/end-of-input (or the start of another tag). This is important:
 * `stripLeakedLabelTags()` is also used for ordinary Markdown, and must not
 * delete arbitrary prose merely because it mentions an opening tag.
 *
 * Global, so a reply containing several leaked tags is fully cleaned. Shared
 * with the markdown transformer in ui/strip-labels.ts so what the user sees
 * and what the model sees next turn can never disagree.
 */
export function labelTagPattern(): RegExp {
  const alias = "(?:m[0-9]{4}|b[0-9]{4}|BLOCKED)";
  return new RegExp(`\\n*<${LABEL_TAG_NAME}>(?:[^<]*</${LABEL_TAG_NAME}>|${alias}?\\s*(?=<|$))`, "g");
}

/**
 * Remove pi-dcp label tags the model wrote into its own reply.
 *
 * pi-dcp injects labels into the outgoing request only (transform/labels.ts);
 * they are never persisted. So any tag inside a stored assistant message is,
 * by construction, generated text - the model imitating the pattern it sees on
 * every turn.
 *
 * Left alone, an echoed tag is indistinguishable from a real label on the next
 * request, and it is usually WRONG. Observed live on 2026-08-19 with
 * claude-opus-5: pi-dcp labelled two turns m0003 and m0004, while the model had
 * echoed "m0004" and "m0005" into those same turns - every echo off by one.
 * A model reading that back can select a compress range that does not mean what
 * it thinks it means, so this is a correctness fix, not only hygiene.
 *
 * Scope is deliberately narrow:
 * - Assistant messages only. Tool results are NOT touched: a tool that read
 *   src/transform/labels.ts or grepped the repo legitimately contains the tag
 *   text, and rewriting tool output would corrupt a faithful file read.
 * - Text parts only. A thinking part is never edited, because its signature
 *   covers the exact thinking bytes and any change invalidates it for replay.
 * - A text part emptied by the strip is dropped, matching what the provider
 *   adapter would have done with it anyway.
 *
 * Returns undefined when there was nothing to strip, so the caller can leave
 * the finalized message untouched instead of rewriting it every turn.
 */
export function stripEchoedLabels(message: AgentMessage): AgentMessage | undefined {
  const value = message as any;
  if (value?.role !== "assistant" || !Array.isArray(value.content)) return undefined;
  const marker = `<${LABEL_TAG_NAME}>`;
  if (!value.content.some((part: any) => part?.type === "text" && typeof part.text === "string" && part.text.includes(marker))) {
    return undefined;
  }

  const pattern = labelTagPattern();
  const content = value.content.flatMap((part: any) => {
    if (part?.type !== "text" || typeof part.text !== "string" || !part.text.includes(marker)) return [part];
    const text = part.text.replace(pattern, "");
    return text.trim().length > 0 ? [{ ...part, text }] : [];
  });
  return { ...value, content } as AgentMessage;
}
