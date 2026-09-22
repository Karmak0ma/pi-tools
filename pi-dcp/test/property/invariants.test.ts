import { describe, expect, it } from "vitest";
import { buildSessionProjection } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { canonicalJson } from "../../src/util/canonical-json.ts";
import { emptyState, reduceEnvelope } from "../../src/state/reducer.ts";
import { createEnvelope } from "../../src/state/operations.ts";
import { transformOutgoingContext } from "../../src/transform/pipeline.ts";
import { defaults } from "../../src/config/defaults.ts";

describe("deterministic invariants", () => {
  it("sorts plain object keys without changing array order", () => { expect(canonicalJson({ b: 2, a: 1, list: [2, 1] })).toBe('{"a":1,"b":2,"list":[2,1]}'); });
  it("keeps replay idempotent", () => { const envelope = createEnvelope({ type: "manual.changed", enabled: true }, "session", "0.1.0", "request-a"); const once = reduceEnvelope(emptyState(), envelope); const twice = reduceEnvelope(once, envelope); expect(twice.operationCount).toBe(once.operationCount); expect(twice.manualMode).toBe(true); });

  it("round-trips every bounded system-message placement through the visible join", () => {
    for (let placement = 0; placement < 8; placement++) {
      const messages = [0, 1, 2].map((index) => ({ role: "user", content: `request-${index}`, timestamp: index + 1 })) as AgentMessage[];
      const entries: any[] = [];
      let parentId: string | null = null;
      for (let index = 0; index < messages.length; index++) {
        if (placement & (1 << index)) {
          const systemId = `system-${placement}-${index}`;
          entries.push({ type: "message", id: systemId, parentId, timestamp: new Date(entries.length + 1).toISOString(), message: { role: "system", content: `prompt-${index}`, timestamp: entries.length + 1 } });
          parentId = systemId;
        }
        const userId = `user-${placement}-${index}`;
        entries.push({ type: "message", id: userId, parentId, timestamp: new Date(entries.length + 1).toISOString(), message: messages[index] });
        parentId = userId;
      }
      const ctx = {
        model: { provider: "test", id: "model", api: "test", contextWindow: 10_000 },
        getContextUsage: () => ({ tokens: null, contextWindow: 10_000 }),
        sessionManager: { buildContextEntries: () => entries, buildSessionProjection: () => buildSessionProjection(entries, parentId), getLeafId: () => parentId },
      } as any;
      const result = transformOutgoingContext(messages, { ctx, sessionId: "s", generation: placement + 1, state: emptyState(), config: structuredClone(defaults) as any });
      expect(result.snapshot).toBeDefined();
      expect(result.messages.map((message) => message.role)).toEqual(["user", "user", "user"]);
      expect(result.index?.units.filter((unit) => unit.role === "system")).toHaveLength((placement.toString(2).match(/1/g) || []).length);
    }
  });
});
