/**
 * Anthropic prompt-cache breakpoint relocation.
 *
 * Pi's Anthropic adapter places its single rolling `cache_control` breakpoint on
 * the last block of the last user message. Because the transient nudge message
 * is appended as the request tail when needed, that breakpoint lands on it —
 * and a breakpoint on the nudge block can never produce a reusable cache entry:
 * Anthropic only stores prefixes that END at a breakpoint, and next turn the
 * nudge block is replaced by the new assistant/tool traffic, so the stored
 * prefix is no longer a prefix of the request. The cost is the whole message
 * history being re-written to cache while only the system blocks hit.
 *
 * Moving the breakpoint back onto the last real (non-nudge) block makes the
 * cached prefix strictly-growing history, which every later turn extends, so it
 * hits. Only the few tokens of the nudge suffix are recomputed for that request.
 *
 * The relocation is Anthropic-shape specific and deliberately conservative: it
 * touches nothing unless the tail block is our own nudge block carrying a
 * `cache_control` that Pi put there, so payloads from other providers (which
 * have no `cache_control` at all) pass through untouched.
 */

import { NUDGE_PREFIX } from "../prompts/nudge.ts";

/** Content block types Anthropic accepts a `cache_control` marker on. */
const CACHEABLE_BLOCK_TYPES = new Set(["text", "image", "document", "tool_use", "tool_result", "search_result"]);

type Block = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function blocksOf(message: unknown): Block[] | undefined {
  if (!isRecord(message) || !Array.isArray(message.content)) return undefined;
  return message.content.filter(isRecord) as Block[];
}

/** The tail block Pi marked, when the tail message is our transient nudge suffix. */
function nudgeBreakpointBlock(messages: unknown[]): Block | undefined {
  const blocks = blocksOf(messages.at(-1));
  const last = blocks?.at(-1);
  if (!last || last.cache_control === undefined) return undefined;
  if (last.type !== "text" || typeof last.text !== "string" || !last.text.startsWith(NUDGE_PREFIX)) return undefined;
  return last;
}

/** Last cacheable block of the real history, scanning backwards from the nudge suffix. */
function lastStableBlock(messages: unknown[]): Block | undefined {
  for (let index = messages.length - 2; index >= 0; index--) {
    const blocks = blocksOf(messages[index]);
    if (!blocks) continue;
    for (let position = blocks.length - 1; position >= 0; position--) {
      const block = blocks[position];
      if (typeof block.type === "string" && CACHEABLE_BLOCK_TYPES.has(block.type)) return block;
    }
  }
  return undefined;
}

/** True when the real history already carries a breakpoint of its own. */
function historyAlreadyMarked(messages: unknown[]): boolean {
  for (let index = messages.length - 2; index >= 0; index--) {
    const blocks = blocksOf(messages[index]);
    if (blocks?.some((block) => block.cache_control !== undefined)) return true;
  }
  return false;
}

/**
 * Move the rolling cache breakpoint off the transient nudge suffix and onto the
 * last stable history block. Mutates and returns `payload`; returns it unchanged
 * when the shape does not match (non-Anthropic providers, caching disabled, or a
 * tail that is not our nudge message).
 */
export function relocateCacheBreakpoint(payload: unknown): unknown {
  if (!isRecord(payload) || !Array.isArray(payload.messages) || payload.messages.length === 0) return payload;
  const nudgeBlock = nudgeBreakpointBlock(payload.messages);
  if (!nudgeBlock) return payload;

  // The suffix must lose the breakpoint either way: keeping it only buys a cache
  // write that no later request can read.
  const cacheControl = nudgeBlock.cache_control;
  delete nudgeBlock.cache_control;

  // Never add a second breakpoint next to one another extension already placed:
  // Anthropic allows at most four, and the existing one already anchors history.
  if (historyAlreadyMarked(payload.messages)) return payload;

  const target = lastStableBlock(payload.messages);
  if (target) target.cache_control = cacheControl;
  return payload;
}
