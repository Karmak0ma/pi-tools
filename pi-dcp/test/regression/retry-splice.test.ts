import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { defaults } from "../../src/config/defaults.ts";
import { emptyState, markAvailability, type ReducedBlock } from "../../src/state/reducer.ts";
import { projectContextEntries } from "../../src/identity/project.ts";
import { transformOutgoingContext } from "../../src/transform/pipeline.ts";

/**
 * Regression cover for incomplete-turn join incidents: the empty failed turn
 * in session 01a014a0 (2026-08-18), and the contentful aborted turn in session
 * 01a02e94 (2026-08-24).
 *
 * Pi persists incomplete assistant turns in the session file, but removes
 * them from the context sent to a provider. This applies to every assistant
 * turn whose stop reason is `error` or `aborted`, including turns that retain
 * partial text, reasoning, or tool calls. pi-dcp built its expected list from
 * the session file, so a retained partial turn made the lists diverge, the
 * join failed with `join_ambiguous`, and every later request in that process
 * was sent completely uncompressed.
 */

function entriesFor(messages: AgentMessage[]) {
  return messages.map((message, index) => ({
    type: "message",
    id: `entry-${index + 1}`,
    parentId: index ? `entry-${index}` : null,
    timestamp: new Date(index + 1).toISOString(),
    message,
  }));
}

function ctxFor(entries: unknown[]) {
  return {
    cwd: "/tmp",
    model: { provider: "test", id: "model", api: "test", contextWindow: 10_000 },
    getContextUsage: () => ({ tokens: null, contextWindow: 10_000 }),
    sessionManager: { buildContextEntries: () => entries, getLeafId: () => `entry-${entries.length}` },
  } as any;
}

const failedRequest = { role: "assistant", content: [], provider: "test", model: "model", api: "test", stopReason: "error", errorMessage: "429 rate limit", timestamp: 2 } as unknown as AgentMessage;

const history: AgentMessage[] = [
  { role: "user", content: "first", timestamp: 1 },
  failedRequest,
  { role: "assistant", content: [{ type: "text", text: "retried and answered" }], provider: "test", model: "model", api: "test", stopReason: "stop", timestamp: 3 } as any,
  { role: "user", content: "latest", timestamp: 4 },
];

describe("assistant messages left behind by an incomplete request", () => {
  it("does not project an empty failed turn, so a retry-spliced incoming list still joins", () => {
    const entries = entriesFor(history);
    const projection = projectContextEntries(entries as any);
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    expect(projection.messages).toHaveLength(3);
    expect(projection.unprojectedEntryIds).toEqual(new Set(["entry-2"]));

    // Exactly what Pi sends after `_prepareRetry`: the error message is gone.
    const spliced = [history[0], history[2], history[3]];
    const result = transformOutgoingContext(spliced, { ctx: ctxFor(entries), sessionId: "s", generation: 1, state: emptyState(), config: structuredClone(defaults) as any });
    expect(result.reason).toBeUndefined();
    expect(result.snapshot).toBeDefined();
  });

  it("is passed through untouched when Pi does keep it in the incoming list", () => {
    const entries = entriesFor(history);
    const result = transformOutgoingContext(history, { ctx: ctxFor(entries), sessionId: "s", generation: 1, state: emptyState(), config: structuredClone(defaults) as any });
    expect(result.snapshot).toBeDefined();
    expect(result.messages).toContainEqual(failedRequest);
  });

  it.each([
    {
      name: "aborted tool call",
      message: {
        role: "assistant", stopReason: "aborted", timestamp: 2,
        content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "sleep 10" } }],
      } as unknown as AgentMessage,
    },
    {
      name: "errored partial text",
      message: {
        role: "assistant", stopReason: "error", errorMessage: "connection lost", timestamp: 2,
        content: [{ type: "text", text: "partial answer" }],
      } as unknown as AgentMessage,
    },
  ])("does not project a contentful $name that Pi removes before dispatch", ({ message }) => {
    const persisted: AgentMessage[] = [history[0], message, history[2], history[3]];
    const entries = entriesFor(persisted);
    const projection = projectContextEntries(entries as any);
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    expect(projection.messages).toHaveLength(3);
    expect(projection.unprojectedEntryIds).toEqual(new Set(["entry-2"]));

    // pi-ai transformMessages removes the incomplete turn based on stopReason,
    // regardless of retained content. DCP must expect the same input shape.
    const providerInput = [persisted[0], persisted[2], persisted[3]];
    const result = transformOutgoingContext(providerInput, { ctx: ctxFor(entries), sessionId: "s", generation: 1, state: emptyState(), config: structuredClone(defaults) as any });
    expect(result.reason).toBeUndefined();
    expect(result.snapshot).toBeDefined();
  });

  // Blocks created before this rule existed can cover a failed request, or sit
  // directly next to one. Their coverage and anchors must not be read as "the
  // entry disappeared", or the block would deactivate and the whole context
  // would expand again - the exact outcome this change is meant to prevent.
  const legacyBlock = (coverage: string[], anchor: ReducedBlock["anchor"]): ReducedBlock => ({
    blockId: "block-1", ordinal: 0, topic: "old work", summary: "s", authoredSummary: "s",
    estimatedSummaryTokens: 1, estimatedSourceTokens: 10, estimatedSavingsTokens: 9,
    coverage: { directEntryIds: [...coverage], effectiveEntryIds: [...coverage], directToolCallIds: [], effectiveToolCallIds: [] },
    anchor,
    consumedBlockIds: [], nestedDepth: 0, runId: "run-1", createdByOpId: "op-1",
    active: true, available: true, userDecompressed: false, parentBlockIds: [],
  });

  it("keeps a block that covers the entry that is no longer projected", () => {
    const state = emptyState();
    state.blocks.set("block-1", legacyBlock(["entry-2", "entry-3"], { beforeEntryId: "entry-1", afterEntryId: "entry-4" }));

    const next = markAvailability(
      state,
      new Set(["entry-1", "entry-3", "entry-4"]),
      new Map([["block-1", { beforeEntryId: "entry-1", afterEntryId: "entry-4" }]]),
      new Set(["entry-2"]),
    );

    expect(next.blocks.get("block-1")).toMatchObject({ active: true, available: true });
  });

  it("keeps a block whose recorded anchor names the entry that is no longer projected", () => {
    const state = emptyState();
    state.blocks.set("block-1", legacyBlock(["entry-3"], { beforeEntryId: "entry-2", afterEntryId: "entry-4" }));

    const next = markAvailability(
      state,
      new Set(["entry-1", "entry-3", "entry-4"]),
      // entry-2 left the index, so the neighbour recomputed today is entry-1.
      // The recorded anchor can never match again and must be read as open.
      new Map([["block-1", { beforeEntryId: "entry-1", afterEntryId: "entry-4" }]]),
      new Set(["entry-2"]),
    );

    expect(next.blocks.get("block-1")).toMatchObject({ active: true, available: true });
  });
});
