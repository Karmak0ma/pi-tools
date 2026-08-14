import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/util/canonical-json.ts";
import { emptyState, reduceEnvelope } from "../../src/state/reducer.ts";
import { createEnvelope } from "../../src/state/operations.ts";

describe("deterministic invariants", () => {
  it("sorts plain object keys without changing array order", () => { expect(canonicalJson({ b: 2, a: 1, list: [2, 1] })).toBe('{"a":1,"b":2,"list":[2,1]}'); });
  it("keeps replay idempotent", () => { const envelope = createEnvelope({ type: "manual.changed", enabled: true }, "session", "0.1.0", "request-a"); const once = reduceEnvelope(emptyState(), envelope); const twice = reduceEnvelope(once, envelope); expect(twice.operationCount).toBe(once.operationCount); expect(twice.manualMode).toBe(true); });
});
