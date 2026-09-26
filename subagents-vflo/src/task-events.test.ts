/**
 * Status rules of applyChildEvent that protect the task contract: turn-level
 * events never finish a task (only the backend's terminal result does), and
 * observers get the right notification urgency.
 */
import { describe, expect, it } from "vitest";
import { applyChildEvent } from "./task-events.js";
import { createInstance } from "./tracker.js";

const newInstance = () => createInstance({ id: "t", agent: "explore", source: "builtin", task: "x", cwd: "/" });

describe("applyChildEvent", () => {
  it("never marks a task finished from turn-level events", () => {
    const instance = newInstance();
    applyChildEvent(instance, { type: "agent_start" });
    applyChildEvent(instance, {
      type: "message_end",
      message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "answer" }] },
    });
    applyChildEvent(instance, { type: "agent_settled" });

    expect(instance.status).toBe("running");
    expect(instance.summary.lifecycle).toBe("completed");
    expect(instance.summary.latestOutput).toBe("answer");
  });

  it("keeps an interrupted Herdr turn live", () => {
    const instance = newInstance();
    applyChildEvent(instance, { type: "agent_start" });
    expect(applyChildEvent(instance, { type: "subagent_turn_aborted" })).toBe("immediate");
    expect(instance.status).toBe("running");
    expect(instance.summary.lifecycle).toBe("interrupted");
  });

  it("throttles text deltas and accumulates them", () => {
    const instance = newInstance();
    const delta = (d: string) => ({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: d } });
    expect(applyChildEvent(instance, delta("he"))).toBe("throttled");
    applyChildEvent(instance, delta("llo"));
    expect(instance.summary.latestOutput).toBe("hello");
  });
});
