import assert from "node:assert/strict";
import test from "node:test";
import { parseToolCalls } from "../src/index.ts";

const tools = [
  {
    name: "bash",
    description: "Run a command",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
  },
] as any;

const expectedCall = {
  name: "bash",
  arguments: { command: "pwd" },
};

test("parses the canonical bridge protocol", () => {
  const parsed = parseToolCalls(
    '<pi_tool_call>{"name":"bash","arguments":{"command":"pwd"}}</pi_tool_call>',
    tools,
  );

  // Canonical behavior is the baseline that tolerant recovery must not weaken.
  assert.deepEqual(parsed.calls, [expectedCall]);
  assert.equal(parsed.issue, undefined);
});

test("recovers DeepSeek DSML closing-token variants", () => {
  const closers = ["</｜DSML｜l_tool_call>", "</｜DSML｜_tool_call>"];

  for (const closer of closers) {
    const parsed = parseToolCalls(
      `<pi_tool_call>{"name":"bash","arguments":{"command":"pwd"}}${closer}`,
      tools,
    );

    // A balanced payload after an explicit opener is authoritative; model-specific
    // terminators must not turn an executable call into literal assistant text.
    assert.deepEqual(parsed.calls, [expectedCall]);
    assert.equal(parsed.issue, undefined);
  }
});

test("keeps recovered calls when a sibling marker is invalid", () => {
  const parsed = parseToolCalls(
    [
      '<pi_tool_call>{"name":"bash","arguments":{"command":"pwd"}}</pi_tool_call>',
      '<pi_tool_call>{"name":"missing","arguments":{}}</pi_tool_call>',
    ].join(""),
    tools,
  );

  // One bad sibling should be diagnosed without discarding independently valid work.
  assert.deepEqual(parsed.calls, [expectedCall]);
  assert.match(parsed.issue ?? "", /unknown Pi tool/);
});

test("does not misclassify ordinary JSON answers as tool calls", () => {
  const answers = [
    '{"status":"ok","items":[1,2]}',
    '{"name":"Ada","status":"ok"}',
  ];

  for (const answer of answers) {
    const parsed = parseToolCalls(answer, tools);

    // Markerless recovery requires both tool identity and argument structure so
    // common domain objects with a `name` field remain ordinary assistant text.
    assert.equal(parsed.detected, false);
    assert.deepEqual(parsed.calls, []);
  }
});

test("recovers a markerless JSON object with tool-call keys", () => {
  const parsed = parseToolCalls(
    '{"name":"bash","arguments":{"command":"pwd"}}',
    tools,
  );

  // The narrow fallback preserves compatibility with models that omit both markers.
  assert.equal(parsed.detected, true);
  assert.deepEqual(parsed.calls, [expectedCall]);
});

test("reports a genuinely incomplete payload for bounded repair", () => {
  const parsed = parseToolCalls(
    '<pi_tool_call>{"name":"bash","arguments":{"command":"pwd"}',
    tools,
  );

  // Unbalanced JSON cannot be executed safely and must remain eligible for one repair turn.
  assert.equal(parsed.detected, true);
  assert.deepEqual(parsed.calls, []);
  assert.match(parsed.issue ?? "", /missing its closing tag/);
});
