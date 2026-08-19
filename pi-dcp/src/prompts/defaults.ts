import type { EffectiveConfig } from "../config/defaults.ts";

/**
 * Configuration this module needs to describe selection rules accurately.
 * Deliberately narrow: the guidance must depend only on the settings that
 * actually change which units the model may select, so an unrelated config
 * change cannot rewrite the system prompt and evict the prompt cache.
 */
export type GuidanceConfig = Pick<EffectiveConfig, "turnProtection"> & {
  compress: Pick<EffectiveConfig["compress"], "protectUserMessages">;
};

/**
 * The turn-relative half of compression eligibility, stated as a rule.
 *
 * This is the single fact the model cannot read off the inline
 * <pi-dcp-message-id> tags. The tags carry the permanent half (a unit is
 * either a selectable mNNNN or a permanently BLOCKED one); the rules below
 * carry the moving half (which recent user turns are still live), because
 * baking that into a tag would rewrite a historical message's bytes on every
 * later turn and destroy prompt-cache prefix stability - see
 * transform/labels.ts and compression/eligibility.ts.
 *
 * It is a *rule*, not data. It is constant for a whole session, so it lives
 * here in the cached system prompt instead of being re-sent as a per-request
 * message. pi-dcp used to append a "[pi-dcp status]" line listing the
 * currently eligible labels to every single request; that line was a fresh
 * user turn on the wire (Pi's convertToLlm maps the "custom" role to "user"),
 * which is the turn a model is most likely to feel compelled to answer, and
 * it carried nothing the model could not derive from these two sentences.
 *
 * Kept in one function so SYSTEM_GUIDANCE and the compress tool description
 * cannot drift apart, and so both always match what
 * compression/eligibility.ts actually enforces.
 */
export function selectionRules(config: GuidanceConfig): string {
  const lines = [
    "- Select only whole protocol units, contiguous, by their mNNNN labels. A unit tagged BLOCKED can never be selected: its exchange is not complete and settled.",
  ];
  if (config.compress.protectUserMessages) {
    // protectUserMessages makes every user unit ineligible, but labels.ts
    // still tags them mNNNN (BLOCKED reflects only permanent protocol
    // structure), so the model has to be told.
    lines.push("- No user turn can be selected at all: compress.protectUserMessages is enabled. Select only assistant tool-call units, and split ranges around every user turn.");
  } else if (config.turnProtection.enabled && config.turnProtection.turns > 0) {
    lines.push(`- The ${config.turnProtection.turns} most recent user turns are still live and can never be selected. Neither can any range that spans them.`);
  } else {
    lines.push("- The newest user turn is still live and can never be selected. Neither can any range that ends on it.");
  }
  lines.push("- Everything else that is labelled mNNNN is selectable. You do not need a list: derive it from the two rules above. The compress tool is the authority - if a range is wrong it is rejected, unchanged, with the exact labels you may use instead.");
  return lines.join("\n");
}

export function buildSystemGuidance(config: GuidanceConfig): string {
  return `pi-dcp context management guidance.

Compression is model-authored through the compress tool. Compress older, closed work to keep this session focused; treat summaries as authoritative records, not deletions.

COMPRESS WHEN
- Research concluded and findings are clear.
- Implementation finished and verified.
- Exploration exhausted and patterns understood.
- Dead-end noise can be discarded without waiting for a whole chapter to close.

DO NOT COMPRESS IF
- Raw context is still relevant and needed for edits or precise references.
- The target content is still actively in progress.
- You may need exact code, error messages, or file contents in the immediate next steps.

Labels: every message in this conversation carries a local label attached to its content: <pi-dcp-message-id>mNNNN</pi-dcp-message-id> for a compressible protocol unit, <pi-dcp-message-id>bNNNN</pi-dcp-message-id> for an active compressed block, or <pi-dcp-message-id>BLOCKED</pi-dcp-message-id> for a unit that cannot be included. A protocol unit is one user turn, or one assistant tool-call message together with ALL of its tool results; always select whole units. Labels are stable: mNNNN names a fixed position and never moves to different content.

What you may select
${selectionRules(config)}

Copy labels from the visible context only. Never invent labels and never inspect the session file on disk. If no labels are visible, do not call compress.

These tags are read-only bookkeeping for you to reference when calling compress. Never write a <pi-dcp-message-id> tag yourself, in any reply: do not copy one, do not invent one, do not end a message with one. They are not part of the conversation and the person you are talking to must never see one.

Suggestions: on rare turns a short line starting with "[pi-dcp status]" is appended to the request. It is from this extension, never from the user. It appears only when pi-dcp suggests you compress something now. Act on it or ignore it as you judge best, but never reply to it, quote it, summarize it, or ask the user about it.

Before compressing, ask yourself: is this section closed enough to become summary-only right now?`;
}
