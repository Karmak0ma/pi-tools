// ============================================================================
// Regression tests for claude-tool-repair/index.ts.
//
// Run with: node --test repair.test.ts
// (this Node version strips TypeScript types for `node --test` without any
// extra flags; re-check with `node --version` if that ever stops working)
//
// Exercises both the pure helper functions (via the `_test` export) and the
// full `message_end` handler against a minimal mocked `ExtensionAPI`, using
// the real captured failure transcripts in claude-tool-repair/fixtures.ts
// plus synthetic cases for every no-op/abort branch.
// ============================================================================

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import claudeToolRepair, { _test } from "./index.ts";
import { sample1_bash, sample2_edit_garbled, sample3_read } from "./fixtures.ts";

// ----------------------------------------------------------------------------
// Minimal mocked ExtensionAPI: just enough surface for `pi.on()` to capture
// the message_end handler and `pi.getAllTools()` to serve a live registry.
// ----------------------------------------------------------------------------
// `tools` may be plain names (no declared required params -- matches most of
// the tests, which only care about name resolution) or `[name, requiredParams]`
// pairs, to exercise `missingRequiredParams` against a realistic TypeBox-shaped
// `{ required: [...] }` schema.
type ToolSpec = string | [name: string, required: string[]];
function createFakePi(tools: ToolSpec[]): { pi: ExtensionAPI; getHandler: () => Function } {
	let handler: Function | undefined;
	const pi = {
		on(name: string, fn: Function) {
			if (name === "message_end") handler = fn;
		},
		getAllTools() {
			return tools.map((spec) => {
				const [name, required] = Array.isArray(spec) ? spec : [spec, []];
				return { name, description: "", parameters: { type: "object", properties: {}, required } };
			});
		},
	} as unknown as ExtensionAPI;
	return {
		pi,
		getHandler: () => {
			assert.ok(handler, "message_end handler was never registered");
			return handler as Function;
		},
	};
}

function assistantMessage(overrides: Record<string, unknown> = {}) {
	return {
		role: "assistant",
		provider: "anthropic",
		model: "claude-opus-5",
		stopReason: "toolUse",
		content: [],
		...overrides,
	};
}

// ----------------------------------------------------------------------------
// Pure helper unit tests
// ----------------------------------------------------------------------------

test("coerceParamValue: recognizes booleans, integers, and JSON, passes through plain strings untouched", () => {
	assert.equal(_test.coerceParamValue("true"), true);
	assert.equal(_test.coerceParamValue("false"), false);
	assert.equal(_test.coerceParamValue("60"), 60);
	assert.equal(_test.coerceParamValue("-3.5"), -3.5);
	assert.deepEqual(_test.coerceParamValue('["a", "b"]'), ["a", "b"]);
	assert.deepEqual(_test.coerceParamValue('{"x": 1}'), { x: 1 });
	// Not valid JSON despite looking array-shaped -- falls back to raw string,
	// exactly the sample2_edit_garbled real-world shape.
	assert.equal(_test.coerceParamValue('[{"oldText">bad'), '[{"oldText">bad');
	// Real shell syntax must survive completely unaltered (no HTML-unescaping).
	const cmd = 'echo hi 2>&1 && echo "done"';
	assert.equal(_test.coerceParamValue(cmd), cmd);
	// Untrimmed passthrough: leading/trailing whitespace in string params must survive.
	assert.equal(_test.coerceParamValue("  spaced  "), "  spaced  ");
});

test("parseInvokeBlocks: ignores invoke-shaped text inside fenced code blocks", () => {
	const text = 'See:\n```\n<invoke name="Bash"><parameter name="command">ls</parameter></invoke>\n```\n';
	assert.deepEqual(_test.parseInvokeBlocks(text), []);
});

test("parseInvokeBlocks: unterminated invoke is never matched (no guessing at truncated input)", () => {
	const text = '<invoke name="Bash"><parameter name="command">ls';
	assert.deepEqual(_test.parseInvokeBlocks(text), []);
});

test("hasStructuralResidue: flags a parameter value containing leftover tag text, passes clean values", () => {
	const [clean] = _test.parseInvokeBlocks(sample1_bash.text);
	assert.ok(clean);
	assert.equal(_test.hasStructuralResidue(clean), false);

	const [garbled] = _test.parseInvokeBlocks(sample2_edit_garbled.text);
	assert.ok(garbled);
	assert.equal(_test.hasStructuralResidue(garbled), true);
});

test("isClaudeMessage: matches anthropic provider and proxied claude-* model ids, rejects everything else", () => {
	assert.equal(_test.isClaudeMessage({ provider: "anthropic", model: "claude-opus-5" }), true);
	assert.equal(_test.isClaudeMessage({ provider: "openrouter", model: "anthropic/claude-sonnet-4-5" }), true);
	assert.equal(_test.isClaudeMessage({ provider: "openrouter", model: "z-ai/glm-5.3-flash" }), false);
	assert.equal(_test.isClaudeMessage({}), false);
	// Substring match, not exact-string: must survive dated snapshots and
	// vendor-prefixed ids without needing a per-release update to this file.
	assert.equal(_test.isClaudeMessage({ provider: "anthropic", model: "claude-opus-5-20250219" }), true);
	assert.equal(_test.isClaudeMessage({ provider: "some-proxy", model: "vendor/Claude-3-Haiku" }), true);
});

test("missingRequiredParams: flags a required parameter absent from a truncated invoke, ignores optional-only gaps", () => {
	const { pi } = createFakePi([["bash", ["command"]], ["read", ["path"]]]);
	const [truncatedBash] = _test.parseInvokeBlocks('<invoke name="Bash"></invoke>');
	assert.ok(truncatedBash);
	assert.deepEqual(_test.missingRequiredParams(pi, "bash", truncatedBash), ["command"]);

	const [completeRead] = _test.parseInvokeBlocks(
		'<invoke name="Read"><parameter name="path">x.txt</parameter></invoke>',
	);
	assert.ok(completeRead);
	assert.deepEqual(_test.missingRequiredParams(pi, "read", completeRead), []);
});

test("truncateForConsole: passes short text through untouched, bounds long text with a length suffix", () => {
	assert.equal(_test.truncateForConsole("short"), "short");
	const long = "x".repeat(5000);
	const truncated = _test.truncateForConsole(long);
	assert.ok(truncated.length < long.length);
	assert.match(truncated, /truncated 3000 more chars/);
});

// ----------------------------------------------------------------------------
// Full message_end handler, against real captured transcripts
// ----------------------------------------------------------------------------

async function captureConsoleWarnings<T>(run: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
	const previousWarn = console.warn;
	const warnings: string[] = [];
	console.warn = (...args: Parameters<typeof console.warn>) => {
		warnings.push(args.map(String).join(" "));
	};
	try {
		return { result: await run(), warnings };
	} finally {
		console.warn = previousWarn;
	}
}

test("handler: repairs a clean single-call leak (sample1_bash) into a real bash toolCall, dropping orphan trailing garbage", async () => {
	const { pi, getHandler } = createFakePi(["bash", "edit", "read"]);
	claudeToolRepair(pi);
	const message = assistantMessage({
		provider: sample1_bash.provider,
		model: sample1_bash.model,
		stopReason: sample1_bash.stopReason,
		content: [{ type: "text", text: sample1_bash.text }],
	});
	const { result, warnings } = await captureConsoleWarnings(() => getHandler()({ message }, {}));
	assert.deepEqual(warnings, [], "a successful repair must not write to the console");
	assert.ok(result, "expected a repair, got a no-op");
	const content = (result as { message: { content: unknown[] } }).message.content;
	// The orphan trailing <parameter> fragment must be fully gone, leaving
	// exactly one toolCall block and no leftover text noise.
	assert.equal(content.length, 1);
	const call = content[0] as { type: string; name: string; arguments: Record<string, unknown> };
	assert.equal(call.type, "toolCall");
	assert.equal(call.name, "bash");
	assert.match(call.arguments.command as string, /npx vitest run test\/_bench_tmp\.test\.ts/);
	// Real shell syntax preserved exactly, no HTML-unescaping corruption.
	assert.match(call.arguments.command as string, /2>&1/);
});

test("handler: aborts on the genuinely garbled leak (sample2_edit_garbled) instead of synthesizing a bad edit call", async () => {
	const { pi, getHandler } = createFakePi(["bash", "edit", "read"]);
	claudeToolRepair(pi);
	const message = assistantMessage({
		provider: sample2_edit_garbled.provider,
		model: sample2_edit_garbled.model,
		stopReason: sample2_edit_garbled.stopReason,
		content: [{ type: "text", text: sample2_edit_garbled.text }],
	});
	const result = await getHandler()({ message }, {});
	assert.equal(result, undefined, "structurally residue-tainted invoke must abort the whole repair, not synthesize edit()");
});

test("handler: repairs sample3_read, preserving genuine prose prefix and coercing offset/limit to numbers", async () => {
	const { pi, getHandler } = createFakePi(["bash", "edit", "read"]);
	claudeToolRepair(pi);
	const message = assistantMessage({
		provider: sample3_read.provider,
		model: sample3_read.model,
		stopReason: sample3_read.stopReason,
		content: [{ type: "text", text: sample3_read.text }],
	});
	const result = await getHandler()({ message }, {});
	assert.ok(result);
	const content = (result.message as { content: unknown[] }).content;
	assert.equal(content.length, 2);
	const [prose, call] = content as [{ type: string; text: string }, { type: string; name: string; arguments: Record<string, unknown> }];
	assert.equal(prose.type, "text");
	assert.match(prose.text, /That negative result is worth recording so nobody repeats it\.$/);
	assert.equal(call.type, "toolCall");
	assert.equal(call.name, "read");
	assert.equal(call.arguments.offset, 60);
	assert.equal(call.arguments.limit, 30);
	assert.equal(typeof call.arguments.offset, "number");
});

// ----------------------------------------------------------------------------
// No-op / abort branch coverage
// ----------------------------------------------------------------------------

test("handler: a truncated invoke missing a required parameter aborts the repair (not just tag-residue garbling)", async () => {
	const { pi, getHandler } = createFakePi([["bash", ["command"]]]);
	claudeToolRepair(pi);
	// Streaming cut off before <parameter name="command"> ever arrived -- the
	// invoke itself is well-formed (has a matching </invoke>), but is missing
	// its one required parameter entirely. hasStructuralResidue alone would
	// NOT catch this (there's no garbled tag text in any captured value --
	// there simply are no captured values at all).
	const message = assistantMessage({ content: [{ type: "text", text: '<invoke name="Bash"></invoke>' }] });
	const result = await getHandler()({ message }, {});
	assert.equal(result, undefined);
});

test("handler: repairing a message is idempotent -- re-running on the already-repaired message is a no-op", async () => {
	const { pi, getHandler } = createFakePi(["bash", "edit", "read"]);
	claudeToolRepair(pi);
	const handler = getHandler();
	const message = assistantMessage({
		provider: sample1_bash.provider,
		model: sample1_bash.model,
		stopReason: sample1_bash.stopReason,
		content: [{ type: "text", text: sample1_bash.text }],
	});
	const firstResult = await handler({ message }, {});
	assert.ok(firstResult, "expected the first run to repair the message");
	// Pin the mutation contract: a repair always returns a NEW message object
	// (built via `{ ...event.message, content: newContent }`), never mutates
	// the input in place. This matters for `message_end`'s in-place-replace
	// mechanics (see index.ts file header) -- pi applies our RETURNED object's
	// fields onto its own reference, so returning a fresh object here is the
	// correct contract, not an incidental implementation detail.
	assert.notStrictEqual(firstResult.message, message);

	// Second run over the ALREADY-REPAIRED message (now has a real toolCall
	// and no leaked text left, since spliceOutInvokes consumed it) must be a
	// pure no-op -- guards against double-firing on session replay/resume
	// scenarios where a handler might see the same message content twice.
	const secondResult = await handler({ message: firstResult.message }, {});
	assert.equal(secondResult, undefined);
});

// `writeForensicLog` has two call sites in index.ts (the successful-repair
// branch and the aborted-repair branch). A logging misconfiguration must
// never surface as a turn-breaking throw out of the message_end handler --
// that would be strictly worse than the stall this extension exists to fix
// -- so both call sites need their own coverage; testing only one would
// leave the other's try/catch unexercised.
async function withUnwritableLogPath<T>(run: () => Promise<T>): Promise<T> {
	const previous = process.env.PI_CLAUDE_TOOL_CALL_REPAIR_LOG;
	process.env.PI_CLAUDE_TOOL_CALL_REPAIR_LOG = "/nonexistent/directory/that/cannot/be/written/x.log";
	// `async`/`await`/`try`/`finally` here (rather than `run().finally(...)`)
	// so the env var is restored even if `run()` throws SYNCHRONOUSLY before
	// ever returning a promise -- `.finally()` on a value that was never
	// produced would never attach, leaking the unwritable path into every
	// later test in this file.
	try {
		return await run();
	} finally {
		if (previous === undefined) delete process.env.PI_CLAUDE_TOOL_CALL_REPAIR_LOG;
		else process.env.PI_CLAUDE_TOOL_CALL_REPAIR_LOG = previous;
	}
}

test("handler: an unwritable PI_CLAUDE_TOOL_CALL_REPAIR_LOG path never breaks a SUCCESSFUL repair", async () => {
	const { pi, getHandler } = createFakePi(["bash", "edit", "read"]);
	claudeToolRepair(pi);
	const message = assistantMessage({
		provider: sample1_bash.provider,
		model: sample1_bash.model,
		stopReason: sample1_bash.stopReason,
		content: [{ type: "text", text: sample1_bash.text }],
	});
	const result = await withUnwritableLogPath(() => getHandler()({ message }, {}));
	assert.ok(result, "the repair itself must still succeed despite the log write failing");
});

test("handler: an unwritable PI_CLAUDE_TOOL_CALL_REPAIR_LOG path never breaks an ABORTED repair", async () => {
	const { pi, getHandler } = createFakePi(["bash"]);
	claudeToolRepair(pi);
	const message = assistantMessage({
		content: [{ type: "text", text: '<invoke name="NotARealTool"><parameter name="x">1</parameter></invoke>' }],
	});
	const result = await withUnwritableLogPath(() => getHandler()({ message }, {}));
	// Aborted repairs return undefined on success (message left unchanged); the
	// assertion here is that this resolves normally at all, i.e. does NOT throw.
	assert.equal(result, undefined);
});

test("handler: unresolved tool name aborts the whole repair and leaves the message untouched", async () => {
	const { pi, getHandler } = createFakePi(["bash"]);
	claudeToolRepair(pi);
	const message = assistantMessage({
		content: [{ type: "text", text: '<invoke name="NotARealTool"><parameter name="x">1</parameter></invoke>' }],
	});
	const result = await getHandler()({ message }, {});
	assert.equal(result, undefined);
});

test("handler: a real toolCall already present strips leaked invoke text but does not synthesize an extra call", async () => {
	const { pi, getHandler } = createFakePi(["bash"]);
	claudeToolRepair(pi);
	const message = assistantMessage({
		content: [
			{ type: "toolCall", id: "toolu_1", name: "bash", arguments: { command: "echo hi" } },
			{ type: "text", text: '<invoke name="Bash"><parameter name="command">echo bye</parameter></invoke>' },
		],
	});
	const { result, warnings } = await captureConsoleWarnings(() => getHandler()({ message }, {}));
	assert.deepEqual(warnings, [], "successful leaked-text cleanup must not write to the console");
	assert.ok(result, "expected the leaked text to be stripped");
	const content = (result as { message: { content: unknown[] } }).message.content;
	// Real toolCall preserved, leaked text block gone entirely (no leftover empty block).
	assert.equal(content.length, 1);
	assert.equal((content[0] as { type: string }).type, "toolCall");
});

test("handler: a real toolCall present with no leaked text is a pure no-op", async () => {
	const { pi, getHandler } = createFakePi(["bash"]);
	claudeToolRepair(pi);
	const message = assistantMessage({
		content: [{ type: "toolCall", id: "toolu_1", name: "bash", arguments: { command: "echo hi" } }],
	});
	const result = await getHandler()({ message }, {});
	assert.equal(result, undefined);
});

test("handler: non-Claude provider/model is a no-op even with a leaked invoke", async () => {
	const { pi, getHandler } = createFakePi(["bash"]);
	claudeToolRepair(pi);
	const message = assistantMessage({
		provider: "openrouter",
		model: "z-ai/glm-5.3-flash",
		content: [{ type: "text", text: sample1_bash.text }],
	});
	const result = await getHandler()({ message }, {});
	assert.equal(result, undefined);
});

test("handler: invoke-shaped text with stopReason 'stop' (not 'toolUse') is a no-op", async () => {
	const { pi, getHandler } = createFakePi(["bash"]);
	claudeToolRepair(pi);
	const message = assistantMessage({
		stopReason: "stop",
		content: [{ type: "text", text: '<invoke name="Bash"><parameter name="command">ls</parameter></invoke>' }],
	});
	const result = await getHandler()({ message }, {});
	assert.equal(result, undefined);
});

test("handler: plain prose with no invoke markup is a no-op", async () => {
	const { pi, getHandler } = createFakePi(["bash"]);
	claudeToolRepair(pi);
	const message = assistantMessage({
		content: [{ type: "text", text: "Just a normal reply, nothing to see here." }],
	});
	const result = await getHandler()({ message }, {});
	assert.equal(result, undefined);
});

test("handler: user-role messages are never touched", async () => {
	const { pi, getHandler } = createFakePi(["bash"]);
	claudeToolRepair(pi);
	const message = { role: "user", content: [{ type: "text", text: sample1_bash.text }] };
	const result = await getHandler()({ message }, {});
	assert.equal(result, undefined);
});

test("handler: PI_CLAUDE_TOOL_CALL_REPAIR_DISABLE=1 forces a no-op even on an otherwise-repairable message", async () => {
	const { pi, getHandler } = createFakePi(["bash"]);
	claudeToolRepair(pi);
	const message = assistantMessage({ content: [{ type: "text", text: sample1_bash.text }] });
	process.env.PI_CLAUDE_TOOL_CALL_REPAIR_DISABLE = "1";
	try {
		const result = await getHandler()({ message }, {});
		assert.equal(result, undefined);
	} finally {
		delete process.env.PI_CLAUDE_TOOL_CALL_REPAIR_DISABLE;
	}
});
