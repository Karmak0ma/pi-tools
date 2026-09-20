// ============================================================================
// claude-tool-repair
//
// PROBLEM (observed repeatedly in real sessions, not hypothetical):
// Claude models (Anthropic `anthropic-messages` API, seen on claude-opus-5,
// both OAuth and API-key auth) sometimes emit an assistant message whose
// `stopReason`/`rawStopReason` say "toolUse"/"tool_use" -- Anthropic's own
// API reports that a tool call happened -- but the actual `content` array
// contains only a `text` block holding Claude Code's own pseudo-XML tool
// syntax as literal text, e.g.:
//
//   <invoke name="Bash">
//   <parameter name="command">rm -rf build/</parameter>
//   </invoke>
//
// instead of a real structured `toolCall` content block. Confirmed via
// `~/.pi/agent/sessions/**/*.jsonl` grep for `<invoke name=` on assistant
// (not toolResult) messages with `stopReason: "toolUse"` and zero `toolCall`
// blocks.
//
// WHAT PI DOES TODAY (verified by reading source, not assumption):
// `@earendil-works/pi-agent-core`'s `agent-loop.js` computes
//   const toolCalls = message.content.filter(c => c.type === "toolCall");
// and if that list is empty while `stopReason === "toolUse"`, pi/agent-core's
// `drive/response.js` raises a hard failure:
//   "Provider reported tool use without any tool calls"
// Pi does NOT auto-retry this. The turn just ends. In every real occurrence
// we found, a human had to type something like "you failed running bash,
// retry" to unstick the agent. That is the "stall" this extension fixes.
//
// WHY A `message_end` HANDLER CAN FIX THIS (verified, not assumed):
// `agent-loop.js` does, in order:
//   1. `await emit({ type: "message_end", message })`
//   2. `const toolCalls = message.content.filter(c => c.type === "toolCall")`
// Step 1 flows through `pi-agent-core`'s `Agent.processEvents` (agent.js),
// which notifies subscribed listeners WITHOUT cloning the message, then
// through `pi-coding-agent`'s `AgentSession._emitExtensionEvent`, which
// applies a `message_end` handler's returned `{ message }` via
// `_replaceMessageInPlace(event.message, normalized)` -- an IN-PLACE field
// replacement (delete all own keys, `Object.assign` the new ones) on the
// SAME object reference `agent-loop.js` already holds. So by the time step 2
// runs, it sees whatever content we set here. This is the same mechanism the
// sibling extension `@benvargas/pi-claude-code-use` relies on for its own
// `message_end`-based tool-call rewriting.
// (Note: pi-agent-core also ships a separate, unrelated "harness/Lane"
// execution engine whose event bus DOES structuredClone -- that is not the
// engine `pi-coding-agent`'s `sdk.js` uses for normal interactive/RPC/print
// sessions, which construct `pi-agent-core`'s plain `Agent` class instead.)
//
// STRATEGY:
// When (and only when) all of these hold for a finalized assistant message:
//   - role is "assistant"
//   - the model is a Claude model (provider "anthropic", or a model id
//     containing "claude" for proxied/openrouter-style access)
//   - stopReason is "toolUse" (Anthropic's own signal that it meant to call
//     a tool -- this is the exact same predicate pi's own error path uses,
//     so we only ever act on messages that were already guaranteed to fail)
//   - content has zero real `toolCall` blocks
//   - a text block contains at least one well-formed `<invoke name="...">
//     ...</invoke>` region outside of fenced code (```...```)
// ...parse the leaked pseudo-XML, resolve each `invoke name` to a live
// registered tool (case-insensitive), best-effort type-coerce each
// `<parameter>` value, and replace the message's content with real
// `toolCall` blocks in place of the leaked text.
//
// SAFETY NETS THIS DESIGN LEANS ON (also verified by reading source):
//   - If a repaired call's arguments don't match the tool's schema, pi's own
//     `validateToolArguments()` (agent-loop.js, called before `execute()`)
//     rejects it with a normal, LLM-visible tool-error -- the model can
//     retry in the same turn instead of a human having to intervene. We do
//     NOT need our own coercion to be perfect; we only need it to work for
//     the common, well-formed case and fail *safely* (a clean tool-error,
//     not a wrong action) for the rest.
//   - Repaired calls still flow through `beforeToolCall`/the `tool_call`
//     extension hook exactly like real calls, so any existing permission
//     gates (e.g. a `guardrails.json`-driven extension) still see them. This
//     extension does not bypass any other safety layer.
//   - We only ever ADD structure to a message that pi was already going to
//     hard-fail on. We never touch a message that would otherwise succeed.
//
// WHAT WE DELIBERATELY DO NOT DO (conservative-by-design choices):
//   - No HTML-unescaping of parameter values. The raw captured text in real
//     samples contains literal `2>&1`, `&&`, etc. with no HTML entities;
//     blindly unescaping would corrupt real shell syntax for no evidenced
//     benefit.
//   - No schema introspection for coercion (TypeBox schemas are fragile to
//     introspect generically across optionals/unions). We use simple,
//     type-agnostic heuristics (looks like true/false/a number/JSON) and let
//     pi's own validator be the final authority.
//   - If ANY invoke block in the message can't be resolved to a live tool
//     name, we abort the WHOLE repair (leave the message untouched) rather
//     than guessing or dropping calls -- partial repairs risk executing a
//     subset of a multi-step plan out of context.
//   - We do not repair when the message already contains a real toolCall
//     (even if leaked invoke text is ALSO present) -- we only log that case,
//     since injecting an extra synthesized call next to a genuine one could
//     duplicate side effects.
//
// KNOWN LIMITATIONS:
//   - Non-core custom tools registered under an MCP-style alias name (only
//     relevant when `@benvargas/pi-claude-code-use`'s Anthropic-OAuth
//     aliasing is active) could, in rare extension-load-order cases, resolve
//     to that extension's schema-only alias stub instead of the real tool.
//     The stub throws a clear, LLM-visible error in that case (not a wrong
//     action, not a silent stall), so this is a degraded-but-still-self-
//     healing outcome, not a regression from today's behavior.
//   - Subagents spawned via `createAgentSession` (e.g. `@tintinweb/pi-subagents`)
//     load global extensions like this one, so the fix generally propagates
//     into subagent runs too, subject to that subagent framework's own
//     `extensions:` allow/deny configuration.
//
// The package is now named `claude-tool-repair`; the PI_CLAUDE_TOOL_CALL_REPAIR_*
// environment-variable names intentionally retain "TOOL_CALL" for compatibility
// with existing user settings and forensic scripts.
//
// Disable entirely with PI_CLAUDE_TOOL_CALL_REPAIR_DISABLE=1 (e.g. while
// investigating whether this extension itself is implicated in an issue).
//
// VERSION PINNING NOTE: the ordering claim above was verified by reading the
// compiled JS of `@earendil-works/pi-coding-agent@0.85.1` and its bundled
// `@earendil-works/pi-agent-core@0.85.1` (specifically `agent-loop.js`,
// `agent.js`, and `core/agent-session.js`'s `_replaceMessageInPlace`). If a
// future pi-agent-core version introduces cloning on the message_end path
// (e.g. adopts the separate structuredClone-based Lane/Harness event bus for
// this path too), this extension silently becomes a no-op again -- the
// failure mode is "back to today's stall", never a wrong action. If repairs
// stop showing up in logs after a pi upgrade, re-verify against the new
// version before assuming Claude simply stopped leaking pseudo-XML.
// ============================================================================

import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ----------------------------------------------------------------------------
// Types mirroring the subset of pi-ai's AssistantMessage content we touch.
// Extensions don't get these exported directly with useful narrowing for
// this event, so we work with the plain shapes documented in extensions.md.
// ----------------------------------------------------------------------------

interface TextBlock {
	type: "text";
	text: string;
	textSignature?: string;
}

interface ToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

type ContentBlock = TextBlock | ToolCallBlock | { type: string; [key: string]: unknown };

interface ParsedInvoke {
	/** Exact original substring, e.g. `<invoke name="Bash">...</invoke>`, used to strip it out of the source text. */
	raw: string;
	/** Start/end offsets of `raw` within the text block it came from. */
	start: number;
	end: number;
	/** The `name="..."` attribute value on `<invoke>`, unresolved. */
	invokeName: string;
	/** Raw captured `<parameter name="X">value</parameter>` pairs, in order. Last occurrence wins on a duplicate name. */
	params: Record<string, string>;
}

// ----------------------------------------------------------------------------
// Fenced-code masking
//
// Replaces the contents of ``` ... ``` fences with same-length runs of a
// placeholder character that cannot appear in real chat text, so invoke
// regions purely INSIDE a fenced code sample (e.g. an assistant explaining
// Claude Code's syntax, or quoting a subagent transcript) are never mistaken
// for a genuine leaked tool call. Because the placeholder run has the exact
// same length as what it replaces, match indices computed against the masked
// text line up 1:1 with the original text, so callers can always slice the
// ORIGINAL text for exact, unaltered values.
// ----------------------------------------------------------------------------
function maskFencedCode(text: string): string {
	return text.replace(/```[\s\S]*?```/g, (match) => "\0".repeat(match.length));
}

// ----------------------------------------------------------------------------
// Parse every well-formed `<invoke name="...">...</invoke>` block in `text`
// that falls outside a fenced code sample. Malformed/unterminated invoke
// tags simply don't match and are left alone (we never guess at truncated
// input -- see file header).
// ----------------------------------------------------------------------------
function parseInvokeBlocks(text: string): ParsedInvoke[] {
	const masked = maskFencedCode(text);
	const invokeRe = /<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/g;
	const paramRe = /<parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/parameter>/g;
	const results: ParsedInvoke[] = [];

	for (const match of masked.matchAll(invokeRe)) {
		const start = match.index ?? 0;
		const end = start + match[0].length;
		// Re-slice the ORIGINAL (unmasked) text for this range: since this match
		// only exists because it was NOT inside a fenced region, the masked and
		// original text are byte-identical here, but slicing the original keeps
		// the invariant explicit and future-proof against changes to masking.
		const raw = text.slice(start, end);
		const invokeName = match[1] ?? "";

		const params: Record<string, string> = {};
		for (const pmatch of raw.matchAll(paramRe)) {
			const name = pmatch[1];
			const value = pmatch[2];
			if (name !== undefined && value !== undefined) params[name] = value;
		}

		results.push({ raw, start, end, invokeName, params });
	}

	return results;
}

// ----------------------------------------------------------------------------
// Best-effort, schema-agnostic type coercion for a captured parameter value.
//
// We deliberately do NOT introspect the target tool's TypeBox parameter
// schema here (optionals/unions/anyOf make that fragile to do generically).
// Instead we recognize a few unambiguous literal shapes and otherwise pass
// the raw string through unchanged. Anything that ends up wrong-shaped for
// its tool is caught by pi's own `validateToolArguments()` before `execute()`
// runs (see file header "SAFETY NETS"), producing a normal, recoverable
// tool-error instead of a wrong action.
// ----------------------------------------------------------------------------
function coerceParamValue(raw: string): unknown {
	const trimmed = raw.trim();

	if (trimmed === "true") return true;
	if (trimmed === "false") return false;

	if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
		const asNumber = Number(trimmed);
		if (Number.isFinite(asNumber)) return asNumber;
	}

	const looksLikeJsonArray = trimmed.startsWith("[") && trimmed.endsWith("]");
	const looksLikeJsonObject = trimmed.startsWith("{") && trimmed.endsWith("}");
	if (looksLikeJsonArray || looksLikeJsonObject) {
		try {
			return JSON.parse(trimmed);
		} catch {
			// Not actually valid JSON (this happens -- see the malformed real
			// sample referenced in the header comment where a model tried to
			// inline a JSON array of edits and mangled the XML/JSON boundary).
			// Fall through to the raw-string case; pi's schema validator will
			// surface a clean error for the mismatched shape.
		}
	}

	// Plain string parameter (the common case: file paths, shell commands,
	// file content). Return the UNTRIMMED original value -- leading/trailing
	// whitespace can be meaningful for content/command parameters, and
	// Claude Code's own XML format does not pad values with extra whitespace.
	return raw;
}

// ----------------------------------------------------------------------------
// Strip orphan `<parameter name="...">...</parameter>` fragments that sit
// OUTSIDE any `<invoke>...</invoke>` block. These show up in real captured
// transcripts as trailing duplicated/truncated garbage from the same
// streaming glitch that produces the leaked invoke text in the first place
// (observed: a well-formed `<invoke>...</invoke>` immediately followed by a
// stray repeated `<parameter name="command">...</parameter>` with no
// wrapping `<invoke>`).
//
// This returns the ORIGINAL text UNCHANGED unless it consists of NOTHING but
// orphan `<parameter>` fragments and whitespace. Callers only pass this the
// text immediately ADJACENT to a parsed invoke block (the gap between one
// invoke's end and the next invoke's start, or the message boundary) -- see
// call site. If that gap contains anything else, we leave the whole gap
// untouched rather than guessing which parts are noise and which are real
// prose the model wrote; a message that happens to quote this tag shape in
// genuine prose must never have content silently deleted from it.
// ----------------------------------------------------------------------------
function stripIfPureOrphanNoise(gapText: string): string {
	const masked = maskFencedCode(gapText);
	const paramRe = /<parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/parameter>/g;
	let withoutOrphans = "";
	let cursor = 0;
	for (const match of masked.matchAll(paramRe)) {
		const start = match.index ?? 0;
		const end = start + match[0].length;
		withoutOrphans += gapText.slice(cursor, start);
		cursor = end;
	}
	withoutOrphans += gapText.slice(cursor);
	return withoutOrphans.trim().length === 0 ? "" : gapText;
}

// ----------------------------------------------------------------------------
// Structural sanity gate for a parsed invoke's parameter values.
//
// The non-greedy `<parameter name="X">...</parameter>` match can, on a
// sufficiently mangled input, swallow content up to a LATER `</parameter>`
// than the one that actually closes that parameter -- observed on a real
// captured transcript where a model tried to inline a JSON array of edits
// and mangled the XML/JSON boundary, producing a parameter value that
// contained literal leftover `<parameter name="newText">` / `</oldText>`
// tag text. That is a hard signal the parse is structurally unreliable for
// THIS invoke, not just imperfectly typed.
//
// A garbled value for a tool whose schema rejects it (e.g. a string where an
// array is required) fails safely via pi's own validator (see file header).
// But a single-string parameter accepts anything and would EXECUTE with
// truncated/garbled content -- e.g. a truncated `bash` command or partial
// `write`/`edit` content -- which is not safely recoverable the way a
// validation error is. So we refuse to synthesize a call from ANY invoke
// whose parameter values still contain tag-shaped residue, regardless of
// which tool it targets: better a stall (today's existing, recoverable
// behavior) than a wrong action.
// ----------------------------------------------------------------------------
const PARAM_RESIDUE_RE = /<\/?(?:parameter|invoke)\b/i;
function hasStructuralResidue(invoke: ParsedInvoke): boolean {
	return Object.values(invoke.params).some((value) => PARAM_RESIDUE_RE.test(value));
}

// ----------------------------------------------------------------------------
// Missing-required-parameter gate -- catches the OTHER common truncation
// shape that `hasStructuralResidue` cannot: streaming cut off mid-stream
// BEFORE a required parameter's closing `</parameter>` tag ever arrived.
// Because `parseInvokeBlocks`'s parameter regex requires a closing tag to
// capture a value at all (see its doc comment -- we never guess at
// truncated input), a parameter cut off mid-value is simply ABSENT from
// `invoke.params`, not present-but-garbled. That's invisible to the residue
// check but is exactly the missing-piece signature of truncation.
//
// This intentionally reads ONLY the schema's top-level `required` array (a
// plain string array on any TypeBox `Type.Object(...)` schema at runtime),
// not the full type shape -- deep type validation was already ruled out as
// fragile across optionals/unions/anyOf (see coerceParamValue's doc comment)
// and is redundant besides: pi's own `validateToolArguments()` already
// catches type mismatches with a clean, recoverable tool-error (see file
// header "SAFETY NETS"). A MISSING required parameter is different: it is
// truncation evidence we can only catch here, before ever emitting a
// synthesized call.
//
// VERIFIED against real pi output (not an assumed shape): a throwaway probe
// extension dumping `JSON.stringify(pi.getAllTools().find(...).parameters)`
// during a real session confirmed pi's builtin tools return exactly this
// shape, e.g. `bash.parameters = {"type":"object","required":["command"],...}`.
// Scope limit: this was only verified for BUILTIN tools. A custom/extension
// or MCP tool could expose a different `parameters` shape (no top-level
// `required` array, a nested/wrapped schema, etc.) -- `missingRequiredParams`
// simply returns `[]` in that case (no crash, no false abort), but also
// provides no truncation-by-absence protection FOR THAT TOOL. This is a
// silent capability gap for non-builtin tools, not a correctness bug.
//
// Residual, deliberately accepted risk: if truncation happens to land
// exactly on a valid closing tag with a syntactically complete but
// semantically incomplete value (e.g. a shell command truncated right after
// a complete-looking clause), neither this check nor the residue check can
// detect it. That risk is irreducible for ANY text-reconstruction approach
// (a human re-reading the same truncated-but-well-formed text has the exact
// same blind spot) and is not unique to this extension.
//
// FALSE-POSITIVE COST (this is fail-SAFE, not "no risk"): if Claude ever
// emits a differently-named-but-equivalent parameter (e.g. Claude Code's own
// `file_path` where pi's tool expects `path`), this gate reads that as a
// missing required param and aborts the WHOLE repair. That is a real,
// accepted regression for that one case -- you lose the repair and are back
// to today's original stall -- but it never fabricates or executes a wrong
// call. Worth watching for in the first live occurrences of this warning.
// ----------------------------------------------------------------------------
function missingRequiredParams(pi: ExtensionAPI, toolName: string, invoke: ParsedInvoke): string[] {
	const tool = pi.getAllTools().find((t) => t.name === toolName);
	const required = (tool?.parameters as { required?: unknown } | undefined)?.required;
	if (!Array.isArray(required)) return [];
	return required.filter((name): name is string => typeof name === "string" && !(name in invoke.params));
}

// ----------------------------------------------------------------------------
// Bounded console summary + optional full-detail forensic file logging.
//
// Leaked parameter values can contain file contents, diffs, or (rarely)
// secrets a command happened to reference. Printing the FULL raw leaked text
// to console.warn on every repair would push that into stderr/scrollback/any
// log capture unconditionally, which is a real exposure for something that
// fires automatically with no user action. So:
//   - console.warn always gets a BOUNDED summary (truncated raw text).
//   - The full, untruncated raw text + outcome is only ever written to disk
//     when the user opts in via PI_CLAUDE_TOOL_CALL_REPAIR_LOG=<path> --
//     same opt-in-file-logging shape as the sibling `pi-claude-code-use`
//     extension's PI_CLAUDE_CODE_USE_DEBUG_LOG, for exactly the same reason
//     (forensic detail on tap without it being unconditionally noisy/exposed).
// ----------------------------------------------------------------------------
const MAX_LOGGED_RAW_CHARS = 2000;
function truncateForConsole(text: string): string {
	if (text.length <= MAX_LOGGED_RAW_CHARS) return text;
	return (
		`${text.slice(0, MAX_LOGGED_RAW_CHARS)}\n... [truncated ${text.length - MAX_LOGGED_RAW_CHARS} more chars; set ` +
		"PI_CLAUDE_TOOL_CALL_REPAIR_LOG=<path> for full untruncated forensic logs]"
	);
}

function writeForensicLog(entry: string): void {
	const path = process.env.PI_CLAUDE_TOOL_CALL_REPAIR_LOG;
	if (!path) return;
	try {
		appendFileSync(path, `${new Date().toISOString()}\n${entry}\n---\n`, "utf-8");
	} catch {
		// Forensic logging must never break the actual repair/abort decision.
	}
}

// ----------------------------------------------------------------------------
// Remove every matched invoke region from `text`, left to right, applying the
// adjacent-only orphan-noise cleanup (`stripIfPureOrphanNoise`) to each gap
// between/around them. `invokes` must already be in source order (as
// produced by `parseInvokeBlocks`, which scans left to right), so a single
// forward cursor pass is sufficient -- no need to re-scan after each removal.
// ----------------------------------------------------------------------------
function spliceOutInvokes(text: string, invokes: ParsedInvoke[]): string {
	let result = "";
	let cursor = 0;
	for (const invoke of invokes) {
		result += stripIfPureOrphanNoise(text.slice(cursor, invoke.start));
		cursor = invoke.end;
	}
	result += stripIfPureOrphanNoise(text.slice(cursor));
	return result.trim();
}

// ----------------------------------------------------------------------------
// Case-insensitive lookup of a live registered tool by its exact name.
// Claude Code's own core tool names ("Bash", "Read", "Edit", ...) are
// capitalized; pi's builtin tools are lowercase. Any other extension tool is
// matched by whatever exact name it's registered under.
// ----------------------------------------------------------------------------
function resolveToolName(pi: ExtensionAPI, invokeName: string): string | undefined {
	const target = invokeName.trim().toLowerCase();
	if (!target) return undefined;
	for (const tool of pi.getAllTools()) {
		if (tool.name.toLowerCase() === target) return tool.name;
	}
	return undefined;
}

function isClaudeMessage(message: { provider?: string; model?: string }): boolean {
	if (message.provider === "anthropic") return true;
	// Covers proxied/openrouter-style access where provider isn't literally
	// "anthropic" but the underlying model still is a Claude model and can
	// still leak this same Claude-Code-flavored pseudo-XML.
	return typeof message.model === "string" && /claude/i.test(message.model);
}

const LOG_PREFIX = "[claude-tool-repair]";

export default function claudeToolRepair(pi: ExtensionAPI): void {
	pi.on("message_end", async (event, _ctx) => {
		if (process.env.PI_CLAUDE_TOOL_CALL_REPAIR_DISABLE === "1") return undefined;

		const message = event.message as {
			role: string;
			provider?: string;
			model?: string;
			stopReason?: string;
			content?: ContentBlock[];
		};

		if (message.role !== "assistant") return undefined;
		if (!isClaudeMessage(message)) return undefined;

		const content = Array.isArray(message.content) ? message.content : [];
		const hasRealToolCall = content.some((block) => block.type === "toolCall");

		// A genuine toolCall is already present, so pi will not hard-fail this
		// turn -- we never SYNTHESIZE an extra call next to a real one (risk of
		// duplicating side effects). But if leaked invoke text is ALSO present,
		// still strip that dead text out of the transcript: left in place, it
		// gets replayed back to the model as its own prior output on the next
		// turn, reinforcing the exact failure pattern we're trying to fix. This
		// is a plain text-deletion, not a repair, so none of the tool-resolution
		// or structural-residue gates below apply to it.
		if (hasRealToolCall) {
			const perBlockLeaks = content.map((block) =>
				block.type === "text" ? parseInvokeBlocks((block as TextBlock).text) : [],
			);
			const anyLeaks = perBlockLeaks.some((invokes) => invokes.length > 0);
			if (!anyLeaks) return undefined;

			console.warn(
				`${LOG_PREFIX} Assistant message has a real toolCall AND leaked <invoke> text; stripping the dead leaked ` +
					"text so it isn't replayed to the model, without synthesizing an extra call next to the real one.",
			);
			const newContent = content.map((block, index) => {
				const invokes = perBlockLeaks[index];
				if (!invokes || invokes.length === 0 || block.type !== "text") return block;
				const stripped = spliceOutInvokes((block as TextBlock).text, invokes);
				return stripped.length > 0 ? ({ type: "text", text: stripped } satisfies TextBlock) : undefined;
			});
			return {
				message: {
					...event.message,
					content: newContent.filter((block): block is ContentBlock => block !== undefined),
				} as typeof event.message,
			};
		}

		// This is the exact predicate pi/agent-core's own error path uses
		// ("Provider reported tool use without any tool calls" -- see header).
		// We only ever act on messages that were already guaranteed to hard-fail.
		if (message.stopReason !== "toolUse") {
			// Informational-only: invoke-shaped text with a normal "stop" is most
			// likely the model quoting/discussing the syntax, not an attempted
			// call. Anthropic did not report stopReason "toolUse" for it, so pi
			// won't error on it either. Nothing to repair.
			return undefined;
		}

		// Gather every parsed invoke block across every text content block, in
		// message order, tracking which content-array index and text-block each
		// came from so we can splice the replacement back into the right spot.
		const perBlockInvokes = content.map((block) =>
			block.type === "text" ? parseInvokeBlocks((block as TextBlock).text) : [],
		);
		const totalInvokes = perBlockInvokes.reduce((sum, invokes) => sum + invokes.length, 0);
		if (totalInvokes === 0) {
			// Nothing recognizable to repair; leave pi's normal error path as-is.
			return undefined;
		}

		// Abort the ENTIRE repair (leave the message unchanged -- same stall as
		// before this extension existed) if ANY invoke either:
		//   (a) doesn't resolve to a live registered tool name,
		//   (b) has structurally-residue-tainted parameter values (see
		//       hasStructuralResidue), or
		//   (c) is missing a parameter its resolved tool's schema requires (see
		//       missingRequiredParams).
		// (b) and (c) together are the two distinct truncation signatures we can
		// detect: garbage-in-a-value, and a-value-never-arrived-at-all.
		// See file header for why we don't do partial repairs. This abort check
		// runs BEFORE any mutation is built below -- an abort here performs
		// zero content changes, full stop.
		const allInvokes = perBlockInvokes.flat();
		const resolvedNames: (string | undefined)[] = allInvokes.map((invoke) => resolveToolName(pi, invoke.invokeName));
		const residueTainted = allInvokes.filter(hasStructuralResidue);
		const missingRequired = allInvokes
			.map((invoke, i) => {
				const toolName = resolvedNames[i];
				if (!toolName) return { invoke, missing: [] as string[] };
				return { invoke, missing: missingRequiredParams(pi, toolName, invoke) };
			})
			.filter((entry) => entry.missing.length > 0);

		if (resolvedNames.some((name) => name === undefined) || residueTainted.length > 0 || missingRequired.length > 0) {
			const unresolvedInvokeNames = new Set(
				allInvokes.filter((_invoke, i) => resolvedNames[i] === undefined).map((invoke) => invoke.invokeName),
			);
			const unresolved = [...unresolvedInvokeNames];
			const reasons = [
				...(unresolved.length > 0 ? [`unresolved tool name(s) [${unresolved.join(", ")}]`] : []),
				...(residueTainted.length > 0
					? [`${residueTainted.length} invoke(s) with tag-shaped residue left in a parameter value (parse looked structurally unreliable)`]
					: []),
				...(missingRequired.length > 0
					? [
							`${missingRequired.length} invoke(s) missing a required parameter (likely truncated mid-stream): ` +
								missingRequired.map((e) => `${e.invoke.invokeName}[${e.missing.join(", ")}]`).join(", "),
						]
					: []),
			];
			const rawText = allInvokes.map((i) => i.raw).join("\n---\n");
			console.warn(
				`${LOG_PREFIX} Assistant message has stopReason "toolUse" with zero real toolCall blocks and leaked <invoke> ` +
					`text, but aborted the repair: ${reasons.join("; ")}. Leaving the message unchanged (same stall as ` +
					`before this extension existed). Raw text:\n${truncateForConsole(rawText)}`,
			);
			writeForensicLog(`ABORTED repair. Reasons: ${reasons.join("; ")}\nRaw text:\n${rawText}`);
			return undefined;
		}

		// Build the replacement content array, splicing stripped-text + toolCall
		// blocks in place of each text block that contained invoke markup.
		let resolvedCursor = 0;
		const newContent: ContentBlock[] = [];
		const appliedSummaries: string[] = [];

		content.forEach((block, index) => {
			const invokes = perBlockInvokes[index];
			if (!invokes || invokes.length === 0 || block.type !== "text") {
				newContent.push(block);
				return;
			}

			const stripped = spliceOutInvokes((block as TextBlock).text, invokes);
			if (stripped.length > 0) {
				newContent.push({ type: "text", text: stripped } satisfies TextBlock);
			}

			for (const invoke of invokes) {
				const toolName = resolvedNames[resolvedCursor];
				resolvedCursor += 1;
				if (!toolName) continue; // unreachable: we already verified all resolved above.

				const args: Record<string, unknown> = {};
				for (const [paramName, paramValue] of Object.entries(invoke.params)) {
					args[paramName] = coerceParamValue(paramValue);
				}

				newContent.push({
					type: "toolCall",
					id: `repaired_${randomUUID()}`,
					name: toolName,
					arguments: args,
				} satisfies ToolCallBlock);

				appliedSummaries.push(`${invoke.invokeName} -> ${toolName}(${Object.keys(invoke.params).join(", ")})`);
			}
		});

		const repairedRawText = allInvokes.map((i) => i.raw).join("\n---\n");
		console.warn(
			`${LOG_PREFIX} Repaired ${appliedSummaries.length} leaked pseudo-tool-call(s) that would otherwise have ` +
				`stalled the turn: ${appliedSummaries.join("; ")}. Original leaked text (truncated; set ` +
				`PI_CLAUDE_TOOL_CALL_REPAIR_LOG=<path> for the full untruncated forensic record):\n${truncateForConsole(repairedRawText)}`,
		);
		writeForensicLog(`REPAIRED. Summary: ${appliedSummaries.join("; ")}\nRaw text:\n${repairedRawText}`);

		return { message: { ...event.message, content: newContent } as typeof event.message };
	});
}

// ============================================================================
// Test exports -- not used by pi at runtime, kept so the pure parsing/coercion
// logic above can be exercised directly from a standalone Node script against
// real captured transcripts without spinning up a full pi session.
// ============================================================================
export const _test = {
	coerceParamValue,
	maskFencedCode,
	parseInvokeBlocks,
	resolveToolName,
	isClaudeMessage,
	hasStructuralResidue,
	missingRequiredParams,
	spliceOutInvokes,
	stripIfPureOrphanNoise,
	truncateForConsole,
};
