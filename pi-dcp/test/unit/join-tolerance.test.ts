import { describe, expect, it } from "vitest";
import { buildSessionProjection } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { defaults } from "../../src/config/defaults.ts";
import { emptyState } from "../../src/state/reducer.ts";
import { joinProjectedMessages } from "../../src/identity/join.ts";
import { currentHostSessionManager, projectCurrentEntries } from "../helpers/current-host.ts";
import { transformOutgoingContext } from "../../src/transform/pipeline.ts";

function setup(messages: AgentMessage[]) {
  const entries = messages.map((message, index) => ({ type: "message", id: `entry-${index + 1}`, parentId: index ? `entry-${index}` : null, timestamp: new Date(index + 1).toISOString(), message }));
  return { entries, ctx: { cwd: "/tmp", model: { provider: "test", id: "model", api: "test", contextWindow: 10_000 }, getContextUsage: () => ({ tokens: null, contextWindow: 10_000 }), sessionManager: currentHostSessionManager(entries, `entry-${entries.length}`) } as any };
}

describe("tolerant projected-message joins", () => {
  it("passes injected extras through unchanged and labels expected messages", () => {
    const canonical: AgentMessage[] = [
      { role: "user", content: "first", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "done" }], provider: "test", model: "model", api: "test", stopReason: "stop", timestamp: 2 } as any,
      { role: "user", content: "latest", timestamp: 3 },
    ];
    const { ctx } = setup(canonical);
    const extra = { role: "custom", customType: "other-extension", content: "untouched", display: false, timestamp: 0 } as AgentMessage;
    const result = transformOutgoingContext([extra, canonical[0], canonical[1], canonical[2]], { ctx, sessionId: "s", generation: 1, state: emptyState(), config: structuredClone(defaults) as any });
    expect(result.snapshot).toBeDefined();
    expect(result.messages[0]).toEqual(extra);
    expect(result.messages.slice(1).every((message) => JSON.stringify(message).includes("pi-dcp-message-id"))).toBe(true);
  });

  it("joins duplicate-content messages unambiguously by position (identical content, so any pairing is equivalent)", () => {
    // Real sessions routinely contain byte-identical messages (repeated "yes",
    // an identical prompt run twice, ...). Duplicate fingerprints do not by
    // themselves make the join ambiguous: the strictly-increasing search
    // below still finds exactly one order-preserving solution, and since the
    // messages are content-identical, that solution is correct regardless of
    // which physical twin is paired with which.
    const messages: AgentMessage[] = [
      { role: "user", content: "same", timestamp: 1 },
      { role: "user", content: "same", timestamp: 1 },
    ];
    const projection = projectCurrentEntries(setup(messages).entries as any);
    expect(projection.ok).toBe(true);
    if (projection.ok) expect(joinProjectedMessages(projection.messages, messages)).toEqual({ ok: true, incomingByExpected: [0, 1] });
  });

  it("still fails closed when a duplicate-fingerprint extra creates genuine ambiguity", () => {
    // Two expected duplicates but three matching incoming candidates: more
    // than one strictly-increasing pairing exists, so this is genuinely
    // ambiguous and must still fail closed.
    const canonical: AgentMessage[] = [
      { role: "user", content: "same", timestamp: 1 },
      { role: "user", content: "same", timestamp: 1 },
    ];
    const projection = projectCurrentEntries(setup(canonical).entries as any);
    expect(projection.ok).toBe(true);
    const extraDuplicate = { role: "user", content: "same", timestamp: 1 } as AgentMessage;
    const incoming = [canonical[0], extraDuplicate, canonical[1]];
    if (projection.ok) expect(joinProjectedMessages(projection.messages, incoming)).toEqual({ ok: false, reason: "join_ambiguous" });
  });

  it("fails closed when the host projection throws", () => {
    const canonical: AgentMessage[] = [{ role: "user", content: "first", timestamp: 1 }];
    const { entries, ctx } = setup(canonical);
    const throwingContext = { ...ctx, sessionManager: { ...ctx.sessionManager, buildSessionProjection: () => { throw new Error("host projection failed"); } } } as any;
    const result = transformOutgoingContext(canonical, { ctx: throwingContext, sessionId: "s", generation: 1, state: emptyState(), config: structuredClone(defaults) as any });

    expect(result.snapshot).toBeUndefined();
    expect(result.reason).toBe("projection_unsupported");
    expect(result.messages).toEqual(canonical);
    expect(entries).toHaveLength(1);
  });

  it("uses Pi 0.87 host projection and joins system-free context", () => {
    const system = { role: "system", content: "host prompt", sections: { host: "guidance" }, timestamp: 1 } as any;
    const user = { role: "user", content: "question", timestamp: 2 } as AgentMessage;
    const entries = [
      { type: "message", id: "system-1", parentId: null, timestamp: new Date(1).toISOString(), message: system },
      { type: "message", id: "user-1", parentId: "system-1", timestamp: new Date(2).toISOString(), message: user },
    ] as any;
    let hostProjectionCalls = 0;
    const ctx = {
      cwd: "/tmp",
      model: { provider: "test", id: "model", api: "test", contextWindow: 10_000 },
      getContextUsage: () => ({ tokens: null, contextWindow: 10_000 }),
      sessionManager: {
        buildContextEntries: () => entries,
        buildSessionProjection: () => { hostProjectionCalls++; return buildSessionProjection(entries, "user-1"); },
        getLeafId: () => "user-1",
      },
    } as any;

    const result = transformOutgoingContext([user], { ctx, sessionId: "s", generation: 1, state: emptyState(), config: structuredClone(defaults) as any });

    expect(hostProjectionCalls).toBe(1);
    expect(result.snapshot).toBeDefined();
    expect(result.messages.every((message) => message.role !== "system")).toBe(true);
    expect(result.index?.units[0]).toMatchObject({ role: "system", compressible: false });
    expect(result.messages.some((message) => JSON.stringify(message).includes("pi-dcp-message-id"))).toBe(true);

    const systemPresent = transformOutgoingContext([system, user], { ctx, sessionId: "s", generation: 1, state: emptyState(), config: structuredClone(defaults) as any });
    expect(systemPresent.snapshot).toBeDefined();
    expect(systemPresent.messages[0]).toEqual(system);
  });

  it("transforms a Pi 0.87 branch with a host-applied context edit", () => {
    const user = { role: "user", content: "question", timestamp: 1 } as AgentMessage;
    const assistant = { role: "assistant", content: [{ type: "text", text: "edited" }], api: "test", provider: "test", model: "model", stopReason: "stop", timestamp: 2 } as any;
    const entries = [
      { type: "message", id: "user-1", parentId: null, timestamp: new Date(1).toISOString(), message: user },
      { type: "message", id: "assistant-1", parentId: "user-1", timestamp: new Date(2).toISOString(), message: { ...assistant, content: [{ type: "text", text: "original" }] } },
      { type: "context_edit", id: "edit-1", parentId: "assistant-1", timestamp: new Date(3).toISOString(), targetId: "assistant-1", replacement: { content: assistant.content } },
    ] as any;
    const ctx = {
      cwd: "/tmp",
      model: { provider: "test", id: "model", api: "test", contextWindow: 10_000 },
      getContextUsage: () => ({ tokens: null, contextWindow: 10_000 }),
      sessionManager: { buildContextEntries: () => entries, buildSessionProjection: () => buildSessionProjection(entries, "edit-1"), getLeafId: () => "edit-1" },
    } as any;

    const result = transformOutgoingContext([user, assistant], { ctx, sessionId: "s", generation: 1, state: emptyState(), config: structuredClone(defaults) as any });

    expect(result.snapshot).toBeDefined();
    expect(result.reason).toBeUndefined();
    expect(result.messages.some((message) => message.role === "assistant" && JSON.stringify(message).includes("edited"))).toBe(true);
  });

  it("excludes a host-omitted target from DCP baseline accounting", () => {
    const oldUser = { role: "user", content: "old work", timestamp: 1 } as AgentMessage;
    const oldAssistant = { role: "assistant", content: [{ type: "text", text: "old answer" }], api: "test", provider: "test", model: "model", stopReason: "stop", timestamp: 2 } as any;
    const currentUser = { role: "user", content: "current request", timestamp: 4 } as AgentMessage;
    const entries = [
      { type: "message", id: "user-1", parentId: null, timestamp: new Date(1).toISOString(), message: oldUser },
      { type: "message", id: "assistant-1", parentId: "user-1", timestamp: new Date(2).toISOString(), message: oldAssistant },
      { type: "context_edit", id: "edit-1", parentId: "assistant-1", timestamp: new Date(3).toISOString(), targetId: "assistant-1", replacement: null },
      { type: "message", id: "user-2", parentId: "edit-1", timestamp: new Date(4).toISOString(), message: currentUser },
    ] as any;
    const ctx = {
      cwd: "/tmp",
      model: { provider: "test", id: "model", api: "test", contextWindow: 10_000 },
      getContextUsage: () => ({ tokens: null, contextWindow: 10_000 }),
      sessionManager: { buildContextEntries: () => entries, buildSessionProjection: () => buildSessionProjection(entries, "user-2"), getLeafId: () => "user-2" },
    } as any;

    const result = transformOutgoingContext([oldUser, currentUser], { ctx, sessionId: "s", generation: 1, state: emptyState(), config: structuredClone(defaults) as any });

    expect(result.snapshot).toBeDefined();
    expect(result.index?.entries.map((item) => item.key.entryId)).toEqual(["user-1", "user-2"]);
    expect(result.index?.units.some((unit) => unit.entryIds.includes("assistant-1"))).toBe(false);
  });
});
