import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type DcpRuntime } from "../runtime.ts";
import { stableNudgeText, type NudgeKind, type NudgeType } from "../transform/metadata.ts";

/** Marker every transient nudge message starts with; also identifies the block
 * carrying the request's tail cache breakpoint (see transform/cache-breakpoint.ts). */
export const NUDGE_PREFIX = "[pi-dcp nudge]";

/**
 * Build the transient, model-visible request suffix. It exists only to deliver
 * a pending nudge, and therefore appears on almost no requests at all.
 *
 * Why nothing else is sent here. Pi's `convertToLlm`
 * (core/messages.js) maps pi-dcp's "custom" role to a plain "user" message, so
 * anything returned from this function lands as a brand-new user turn at the
 * tail of the request - the turn a model is statistically most likely to feel
 * compelled to answer. An earlier revision paid that cost on *every* request
 * to list which mNNNN units were compressible right now. That inventory was
 * pure derived data: the inline <pi-dcp-message-id> tags already say which
 * units exist and which are permanently BLOCKED, and the only missing fact -
 * which recent user turns are still live - is a fixed rule, now stated once in
 * the cached system prompt (see prompts/defaults.ts selectionRules). Sending
 * derived data as a fresh conversational turn, forever, to save the model one
 * subtraction was the wrong trade.
 *
 * Position is not negotiable, which is why the nudge still goes here rather
 * than into the system prompt. Anthropic prompt caching is a prefix hierarchy
 * (tools, then system, then messages), so any per-request byte placed in the
 * system channel invalidates the conversation cache breakpoint that sits after
 * it - a full context re-read on every turn. Per-request content can only live
 * after the last cache breakpoint, i.e. at the message tail, where
 * transform/cache-breakpoint.ts already relocates the breakpoint off it.
 *
 * Readiness is deliberately not reported. A model that tries to compress an
 * unavailable state gets an explanatory tool-call failure from
 * compression/errors.ts, which is both more accurate (it is computed at the
 * moment of use) and free on every turn the model does not call the tool.
 */
export function buildNudgeMessage(runtime: DcpRuntime): AgentMessage | undefined {
  const readiness = runtime.lastReadiness;
  if (!readiness?.ready) {
    // A nudge is tied to the successful request that published its aliases;
    // never carry it across a failed or invalidated transform.
    runtime.pendingNudge = undefined;
    return undefined;
  }

  const pending = runtime.pendingNudge;
  if (!pending) return undefined;
  runtime.pendingNudge = undefined;
  return nudgeMessage(`${NUDGE_PREFIX} ${stableNudgeText(pending.band as NudgeType, (pending.kind || "context") as NudgeKind)}`);
}

function nudgeMessage(content: string): AgentMessage {
  return {
    role: "custom",
    customType: "pi-dcp.v2.nudge",
    display: false,
    timestamp: 0,
    content,
  } as AgentMessage;
}
