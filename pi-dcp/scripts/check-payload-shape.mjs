#!/usr/bin/env node
/**
 * Check dispatched Anthropic payloads for the shape that pi-dcp broke on
 * 2026-08-19.
 *
 * THE INVARIANT: no assistant message may END with a text block.
 *
 * Anthropic treats an assistant message whose content ends with text as a
 * prefill. claude-opus-5 does not support prefill and rejects the whole request
 * with:
 *
 *   400 This model does not support assistant message prefill.
 *       The conversation must end with a user message.
 *
 * That error text is misleading. The failure was reproduced with a payload
 * whose last message really was a user tool_result; the offending message was
 * an assistant turn in the middle, ending with a text block. An earlier version
 * of this script checked the tail role instead, and passed on a payload that
 * had just been rejected. Do not reintroduce that check as the primary signal.
 *
 * pi-dcp hit this by appending its <pi-dcp-message-id> label as a trailing text
 * part on assistant turns that had no text of their own - i.e. silent tool
 * calls. Fixed in src/transform/labels.ts by inserting the label before the
 * first tool call so tool_use stays last.
 *
 * Usage:
 *   1. PI_CLAUDE_CODE_USE_DEBUG_LOG=/tmp/dcp-payloads.log pi -e <path-to>/pi-dcp/src/index.ts
 *   2. node scripts/check-payload-shape.mjs /tmp/dcp-payloads.log
 *
 * Exit code 0 means every dispatched payload is a shape Anthropic accepts.
 */
import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("usage: node scripts/check-payload-shape.mjs <debug-log-path>");
  process.exit(2);
}

// @benvargas/pi-claude-code-use writes "<iso timestamp>\n<indented json>\n---\n"
// per record, twice per request (stage "before" and stage "after").
const records = readFileSync(path, "utf8")
  .split("\n---\n")
  .map((chunk) => chunk.trim())
  .filter(Boolean)
  .map((chunk) => {
    const newline = chunk.indexOf("\n");
    try {
      return { timestamp: chunk.slice(0, newline).trim(), record: JSON.parse(chunk.slice(newline + 1)) };
    } catch {
      return undefined;
    }
  })
  .filter(Boolean);

let checked = 0;
let echoedLabels = 0;
const prefillShaped = [];
const assistantTails = [];

for (const { timestamp, record } of records) {
  const messages = record?.payload?.messages;
  if (!Array.isArray(messages) || messages.length === 0) continue;
  checked++;

  for (const [index, message] of messages.entries()) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const last = message.content.at(-1);
    if (last?.type === "text") {
      prefillShaped.push({ timestamp, stage: record.stage, index, blocks: message.content.map((b) => b?.type) });
    }
    // pi-dcp legitimately injects exactly ONE label per unit, so a tag count is
    // meaningless on its own. Two tags in one text block means the model echoed
    // one of its own - the signal transform/echo.ts (message_end sanitation)
    // exists to drive to zero.
    for (const block of message.content) {
      if (block?.type !== "text" || typeof block.text !== "string") continue;
      const tags = block.text.match(/<pi-dcp-message-id>/g)?.length ?? 0;
      if (tags > 1) echoedLabels += tags - 1;
    }
  }

  // Secondary signal only. A user tail is necessary but not sufficient.
  if (messages.at(-1)?.role === "assistant") assistantTails.push({ timestamp, stage: record.stage });
}

console.log(`records parsed  : ${records.length}`);
console.log(`payloads checked: ${checked}`);
console.log(`echoed pi-dcp tags (model-authored duplicates): ${echoedLabels}`);

if (prefillShaped.length === 0 && assistantTails.length === 0) {
  console.log("\nOK: no assistant message ends with a text block, and no payload ends with an assistant message.");
  process.exit(0);
}

for (const failure of prefillShaped.slice(0, 20)) {
  console.log(`FAIL prefill-shaped  ${failure.timestamp} stage=${failure.stage} message[${failure.index}] blocks=[${failure.blocks.join(", ")}]`);
}
for (const failure of assistantTails.slice(0, 20)) {
  console.log(`FAIL assistant tail  ${failure.timestamp} stage=${failure.stage}`);
}
console.log(`\n${prefillShaped.length} prefill-shaped assistant message(s), ${assistantTails.length} assistant-tailed payload(s).`);
process.exit(1);
