import { describe, expect, it } from "vitest";
import { emptyState, markAvailability, type ReducedBlock } from "../../src/state/reducer.ts";

function block(anchor: ReducedBlock["anchor"]): ReducedBlock {
  return {
    blockId: "block-1",
    ordinal: 0,
    topic: "completed work",
    summary: "The work is complete.",
    authoredSummary: "The work is complete.",
    estimatedSummaryTokens: 4,
    estimatedSourceTokens: 12,
    estimatedSavingsTokens: 8,
    coverage: {
      directEntryIds: ["entry-2", "entry-3"],
      effectiveEntryIds: ["entry-2", "entry-3"],
      directToolCallIds: [],
      effectiveToolCallIds: [],
    },
    anchor,
    consumedBlockIds: [],
    nestedDepth: 0,
    runId: "run-1",
    createdByOpId: "operation-1",
    active: true,
    available: true,
    userDecompressed: false,
    parentBlockIds: [],
  };
}

describe("compression block availability", () => {
  it("keeps a tail block available when new history is appended", () => {
    const state = emptyState();
    state.blocks.set("block-1", block({ beforeEntryId: "entry-1" }));

    const next = markAvailability(
      state,
      new Set(["entry-1", "entry-2", "entry-3", "entry-4"]),
      new Map([["block-1", { beforeEntryId: "entry-1", afterEntryId: "entry-4" }]]),
    );

    expect(next.blocks.get("block-1")).toMatchObject({ active: true, available: true });
  });

  it("keeps a head block available when history is prepended", () => {
    const state = emptyState();
    state.blocks.set("block-1", block({ afterEntryId: "entry-4" }));

    const next = markAvailability(
      state,
      new Set(["entry-0", "entry-2", "entry-3", "entry-4"]),
      new Map([["block-1", { beforeEntryId: "entry-0", afterEntryId: "entry-4" }]]),
    );

    expect(next.blocks.get("block-1")).toMatchObject({ active: true, available: true });
  });

  it("does not treat a changed recorded anchor as valid", () => {
    const state = emptyState();
    state.blocks.set("block-1", block({ beforeEntryId: "entry-1", afterEntryId: "entry-4" }));

    const next = markAvailability(
      state,
      new Set(["entry-1", "entry-2", "entry-3", "entry-5"]),
      new Map([["block-1", { beforeEntryId: "entry-1", afterEntryId: "entry-5" }]]),
    );

    expect(next.blocks.get("block-1")).toMatchObject({ active: false, available: false });
  });
});
