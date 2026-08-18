import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { latestBaseline, type DcpRuntime } from "../runtime.ts";
import { stableNudgeText, type NudgeType } from "../transform/metadata.ts";
import { buildEligibility, compressibleSegments } from "../compression/eligibility.ts";

/** Marker every transient status message starts with; also identifies the block
 * carrying the request's tail cache breakpoint (see transform/cache-breakpoint.ts). */
export const STATUS_PREFIX = "[pi-dcp status]";

/**
 * Every provider wire adapter renders pi-dcp's "custom" role as a plain
 * "user" message (see transform/adapters.ts canonicalWire) because no
 * provider API has a real "custom" role. That means this status ping is
 * indistinguishable, on the wire, from a message the human actually typed -
 * it lands as the newest turn, which is exactly the turn a model is most
 * likely to feel compelled to respond to. This label is the only defense
 * against that: it must say, up front, that the line is inert telemetry and
 * not a request. Keep it short (it is re-sent every single turn) but never
 * remove this framing.
 */
const NOT_A_REQUEST = "background telemetry, not a request from the user - do not reply to, quote, or otherwise react to this line.";

/** Build the deterministic, suffix-only model-visible request status. */
export function buildStatusMessage(runtime: DcpRuntime): AgentMessage | undefined {
  const readiness = runtime.lastReadiness;
  if (!readiness?.ready) {
    // A nudge is tied to the successful request that published its aliases;
    // never carry it across a failed or invalidated transform.
    runtime.pendingNudge = undefined;
    return statusMessage(`${STATUS_PREFIX} ${NOT_A_REQUEST} Compression unavailable for this request: ${readiness?.reason || "state_invalidated"}. No aliases were published. Do not call compress; retry on a later request.`);
  }

  const baseline = latestBaseline(runtime);
  // Report compressible mNNNN segments, not a first-last span: a span can
  // straddle a BLOCKED unit and advertise a range the model cannot actually
  // select in one compress call.
  const span = baseline
    ? (() => {
        const eligibility = buildEligibility(baseline.units, { turnProtection: runtime.config.turnProtection, protectUserMessages: runtime.config.compress.protectUserMessages });
        const segments = compressibleSegments(baseline.units, eligibility);
        return segments.length ? segments.join(", ") : "none";
      })()
    : "none";
  const activeBlocks = baseline
    ? [...baseline.blockAliases.values()]
      .filter((block) => {
        const state = runtime.reduced.blocks.get(block.blockId);
        return state?.active && state.available;
      })
      .map((block) => `${block.alias} (${block.topic})`)
    : [];
  let content = `${STATUS_PREFIX} ${NOT_A_REQUEST} Compression ready. Compressible labels: ${span}. Active blocks: ${activeBlocks.length ? activeBlocks.join(", ") : "none"}. Units outside these segments are marked BLOCKED inline.`;
  const pending = runtime.pendingNudge;
  if (pending) {
    content += ` ${stableNudgeText(pending.band as NudgeType)}`;
    runtime.pendingNudge = undefined;
  }
  return statusMessage(content);
}

function statusMessage(content: string): AgentMessage {
  return {
    role: "custom",
    customType: "pi-dcp.v2.status",
    display: false,
    timestamp: 0,
    content,
  } as AgentMessage;
}
