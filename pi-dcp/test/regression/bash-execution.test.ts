import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { defaults } from "../../src/config/defaults.ts";
import { emptyState } from "../../src/state/reducer.ts";
import { transformOutgoingContext } from "../../src/transform/pipeline.ts";

/**
 * Regression cover for the 2026-08-21 `projection_unsupported` incident.
 *
 * Pi stores interactive shell commands as `bashExecution` messages. They reach
 * extension context handlers before Pi either converts them to provider-facing
 * user text or drops them when `excludeFromContext` is true. DCP must therefore
 * recognize the durable message without taking ownership of either conversion.
 */
function fixture(excludeFromContext: boolean, exitCode: number | null | undefined = 0) {
  const bashExecution = {
    role: "bashExecution",
    command: "pi update --extensions",
    output: "Updated packages\n",
    exitCode,
    cancelled: false,
    truncated: false,
    excludeFromContext,
    timestamp: 1,
  } as unknown as AgentMessage;
  const user = { role: "user", content: "Review the changes", timestamp: 2 } as AgentMessage;
  const messages = [bashExecution, user];
  const entries = messages.map((message, index) => ({
    type: "message",
    id: `entry-${index + 1}`,
    parentId: index ? `entry-${index}` : null,
    timestamp: new Date(index + 1).toISOString(),
    message,
  }));
  const ctx = {
    cwd: "/tmp",
    model: { provider: "test", id: "model", api: "test", contextWindow: 10_000 },
    getContextUsage: () => ({ tokens: null, contextWindow: 10_000 }),
    sessionManager: {
      buildContextEntries: () => entries,
      getLeafId: () => "entry-2",
    },
  } as any;
  return { bashExecution, messages, ctx };
}

describe("bash execution context", () => {
  it.each([false, true])("preserves excludeFromContext=%s without disabling DCP", (excludeFromContext) => {
    const { bashExecution, messages, ctx } = fixture(excludeFromContext);

    const result = transformOutgoingContext(messages, {
      ctx,
      sessionId: "session-1",
      generation: 1,
      state: emptyState(),
      config: structuredClone(defaults) as any,
    });

    // A valid Pi message role must not disable all context transformation.
    expect(result.reason).toBeUndefined();
    expect(result.snapshot).toBeDefined();
    // DCP must leave conversion and exclusion to Pi's later convertToLlm step.
    expect(result.messages.find((message: any) => message.role === "bashExecution")).toEqual(bashExecution);
    // Shell history has no safe label surface yet, so it must not be selectable.
    expect(result.index?.units[0]).toMatchObject({ role: "bashExecution", compressible: false });
  });

  it("accepts the null exit code handled by Pi's runtime converter", () => {
    const { messages, ctx } = fixture(false, null);

    const result = transformOutgoingContext(messages, {
      ctx,
      sessionId: "session-1",
      generation: 1,
      state: emptyState(),
      config: structuredClone(defaults) as any,
    });

    // Pi explicitly treats null as an unfinished execution rather than a
    // malformed message, so DCP must not turn that host-compatible value into
    // a session-wide projection failure.
    expect(result.reason).toBeUndefined();
    expect(result.snapshot).toBeDefined();
  });
});
