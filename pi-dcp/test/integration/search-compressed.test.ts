import { describe, expect, it, vi } from "vitest";
import { registerRetrievalTool } from "../../src/retrieval/tool.ts";
import { createRuntime, type DcpRuntime } from "../../src/runtime.ts";
import { emptyState, reduceEnvelope } from "../../src/state/reducer.ts";
import { createEnvelope, type CreatedBlock } from "../../src/state/operations.ts";
import { buildSyntheticSession, contextEventMessages, createContextHarness } from "../helpers/synthetic-session.ts";
import { currentHostSessionManager, projectCurrentEntries } from "../helpers/current-host.ts";
import { buildProtocolUnits } from "../../src/identity/protocol.ts";

const MODEL = { provider: "anthropic", id: "claude-opus-5", api: "anthropic-messages", contextWindow: 1_000_000 };

/** Capture the registered tool and count every write Pi could receive. */
function fakePi() {
  let tool: any;
  const pi = {
    registerTool: (value: unknown) => { tool = value; },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    setActiveTools: vi.fn(),
    getActiveTools: () => [],
  } as any;
  return { pi, tool: () => tool };
}

function toolContext(entries: unknown[], leafId: string, model = MODEL) {
  return { model, sessionManager: currentHostSessionManager(entries, leafId) } as any;
}

describe("search_compressed tool", () => {
  it("is read-only: it appends no entry and changes neither generation nor reduced state", async () => {
    const session = buildSyntheticSession({ turns: 60, seed: 7 });
    const harness = createContextHarness(currentHostSessionManager(session.entries, session.leafId), contextEventMessages(session.entries, session.leafId));
    await harness.run();
    const runtime = harness.runtime;
    const { pi, tool } = fakePi();
    registerRetrievalTool(pi, runtime);
    const reduced = runtime.reduced;
    const generation = runtime.generation;
    const entryCount = session.entries.length;

    const context = toolContext(session.entries, session.leafId);
    const searched = await tool().execute("call-1", { action: "search", query: "bash3:0" }, undefined, undefined, context);
    const read = await tool().execute("call-2", { action: "read", source: "e:r3-bash" }, undefined, undefined, context);

    expect(searched.content[0].text).toContain("e:r3-bash");
    expect(read.content[0].text).toContain("bash3:0");
    expect(pi.appendEntry).not.toHaveBeenCalled();
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(runtime.generation).toBe(generation);
    expect(runtime.reduced).toBe(reduced);
    expect(session.entries.length).toBe(entryCount);
  });

  it("resolves a visible bNNNN label through the latest context and reads back the original", async () => {
    const session = buildSyntheticSession();
    const harness = createContextHarness(currentHostSessionManager(session.entries, session.leafId), contextEventMessages(session.entries, session.leafId));
    await harness.run();
    const runtime = harness.runtime;
    const aliases = [...runtime.baselines.order.at(-1)!.blockAliases.values()];
    // Turn 17 is covered by block b1, which nested-1 merged. nested-1 is the
    // visible summary; b3 covers later turns only.
    const nested = aliases.find((alias) => alias.blockId === "nested-1")!.alias;
    const later = aliases.find((alias) => alias.blockId === "b3")!.alias;
    const { pi, tool } = fakePi();
    registerRetrievalTool(pi, runtime);
    const context = toolContext(session.entries, session.leafId);

    const inBlock = await tool().execute("call-1", { action: "search", query: "bash17:0", block: nested }, undefined, undefined, context);
    expect(inBlock.isError).toBeUndefined();
    expect(inBlock.content[0].text).toContain("e:r17-bash");
    const elsewhere = await tool().execute("call-2", { action: "search", query: "bash17:0", block: later }, undefined, undefined, context);
    expect(elsewhere.content[0].text).toContain("No matches");

    // The hidden b1 summary is searchable; the visible nested summary is not.
    const hidden = await tool().execute("call-3", { action: "search", query: "summary-b1:0" }, undefined, undefined, context);
    expect(hidden.content[0].text).toContain("s:b1");
    const visible = await tool().execute("call-4", { action: "search", query: "summary-nested-1:0" }, undefined, undefined, context);
    expect(visible.content[0].text).toContain("No matches");

    const unknown = await tool().execute("call-5", { action: "search", query: "bash17:0", block: "b9999" }, undefined, undefined, context);
    expect(unknown).toMatchObject({ isError: true });
  });

  it("is unavailable, with a clear message, for a model where DCP is excluded", async () => {
    const session = buildSyntheticSession({ turns: 30, seed: 3 });
    const harness = createContextHarness(currentHostSessionManager(session.entries, session.leafId), contextEventMessages(session.entries, session.leafId));
    await harness.run();
    const { pi, tool } = fakePi();
    registerRetrievalTool(pi, harness.runtime);
    harness.runtime.config.disabledModels = [`${MODEL.provider}/${MODEL.id}`];

    const result = await tool().execute("call-1", { action: "search", query: "bash3:0" }, undefined, undefined, toolContext(session.entries, session.leafId));
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toContain("unavailable");
  });

  it("rejects mixed or incomplete requests instead of silently ignoring a parameter", async () => {
    const { pi, tool } = fakePi();
    const runtime = createRuntime(pi);
    registerRetrievalTool(pi, runtime);
    const context = toolContext([], "none");
    const cases = [
      { action: "search" },
      { action: "read" },
      { action: "read", source: "e:r1", query: "x" },
      { action: "search", query: "x", source: "e:r1" },
    ];
    for (const params of cases) {
      const result = await tool().execute("call", params, undefined, undefined, context);
      expect(result, JSON.stringify(params)).toMatchObject({ isError: true });
    }
  });

  it("keeps search results ordinary, compressible history: no protected or blocked label", () => {
    const meta = { api: "test", provider: "test", model: "test" };
    const entries = [
      { type: "message", id: "u1", parentId: null, timestamp: new Date(1).toISOString(), message: { role: "user", content: "find it", timestamp: 1 } },
      { type: "message", id: "a1", parentId: "u1", timestamp: new Date(2).toISOString(), message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "search_compressed", arguments: { action: "search", query: "x" } }], stopReason: "toolUse", timestamp: 2, ...meta } },
      { type: "message", id: "r1", parentId: "a1", timestamp: new Date(3).toISOString(), message: { role: "toolResult", toolCallId: "c1", toolName: "search_compressed", content: [{ type: "text", text: "hit" }], isError: false, timestamp: 3 } },
      { type: "message", id: "a2", parentId: "r1", timestamp: new Date(4).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: 4, ...meta } },
      { type: "message", id: "u2", parentId: "a2", timestamp: new Date(5).toISOString(), message: { role: "user", content: "next", timestamp: 5 } },
    ];
    const projection = projectCurrentEntries(entries);
    if (!projection.ok) throw new Error("projection unsupported");
    const index = buildProtocolUnits(projection.messages);
    if (!("units" in index)) throw new Error("protocol invalid");
    expect(index.units.find((unit) => unit.entryIds.includes("r1"))).toMatchObject({ compressible: true, role: "assistant" });
  });

  it("returns refused reads for entries that are not covered by a block", async () => {
    const { pi, tool } = fakePi();
    const runtime = createRuntime(pi);
    const entry = { type: "message", id: "u1", parentId: null, timestamp: new Date(1).toISOString(), message: { role: "user", content: "uncovered secret", timestamp: 1 } };
    const envelope = createEnvelope({ type: "compression.created", runId: "run-1", mode: "range", toolCallId: "call-1", snapshotHash: "s", model: { provider: "p", id: "m", api: "a" }, blocks: [{ blockId: "b-other", ordinal: 0, topic: "t", summary: "other", authoredSummary: "other", estimatedSummaryTokens: 1, coverage: { directEntryIds: ["u-other"], effectiveEntryIds: ["u-other"], directToolCallIds: [], effectiveToolCallIds: [] }, anchor: {}, consumedBlockIds: [], nestedDepth: 0 } as CreatedBlock] }, "session", "0.2.0", "req-1");
    runtime.reduced = reduceEnvelope(emptyState(), envelope);
    registerRetrievalTool(pi, runtime);

    const result = await tool().execute("call", { action: "read", source: "e:u1" }, undefined, undefined, toolContext([entry], "u1"));
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toContain("not in the searchable compressed history");
  });
});
