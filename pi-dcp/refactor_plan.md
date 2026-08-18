# pi-dcp Refactor Plan

**Status:** Approved for execution
**Date:** 2026-08-17
**Derived from:** `claude_proposed_refactor.md` (diagnosis and fixes), `gpt_proposed_refactor.md` (testing and readiness discipline)
**Scope:** `/home/vflores/repos/pi-tools/pi-dcp` (pi-dcp v0.2.0) only. No changes to the pi host, opencode, or any other repo.
**Executability:** This document specifies every change at file/function level with exact strings, test files, and acceptance criteria. No design decisions remain open.

---

## 1. Problem summary

The captured session (`2026-08-16T11-47-27-964Z_01a00a65...jsonl`, provider `openai-codex`, model `gpt-5.6-luna`, api `openai-codex-responses`) ran pi-dcp for a full session with the transform **never succeeding once**:

```
adapter allow-list (src/transform/adapters.ts:17-23) lacks "openai-codex-responses"
  → pipeline.ts:53-54 failure("provider_adapter_unsupported")
  → lifecycle.ts clearBaselines() empties the registry on every request
  → tool.ts returns "baseline_unavailable (assistant_provenance_missing)"
```

The allow-list is provably wrong: it contains `opencode-cli-runner` (not a pi-ai API id) while excluding `anthropic-messages`, `azure-openai-responses`, and `google-generative-ai`. It exists only because pi converts `role: "custom"` messages to user messages (`dist/core/messages.js`), making separate label messages create consecutive-user runs that some providers merge. It is a workaround for a self-inflicted structural problem.

The model was nudged to compress, could not see any labels, then spent 8 tool calls grepping the raw session JSONL for `mNNNN`-shaped substrings, invented `m0227..m2109`, and got an opaque one-line rejection. Three design flaws amplified the failure:

1. **Labels are not attached to the content they label** (separate synthetic messages).
2. **No discovery path** — no live inventory is visible to the model.
3. **Errors do not teach** — every rejection is a one-line code with no retry information.

Secondary fragility: the strict 1:1 join (`pipeline.ts:61`) fails silently whenever any other extension (e.g. `extmgr`, telegram) injects, removes, or reorders messages — the session had both loaded.

---

## 2. Locked design decisions (user-approved)

| # | Decision | Choice |
|---|---|---|
| D1 | Adapter allow-list | **Delete it.** `adapterForModel` returns a generic adapter for every API. `validateProtocol` + `validateWire` remain the safety net. A diagnostics-only "known adapters" list remains for `/dcp debug`. |
| D2 | Tool activation on failure | **Keep `compress` registered** whenever `runtime.valid`; calling while unready returns an actionable error naming the cause and retry path. Nudges and the manual command are gated separately. No `setActiveTools` churn. |
| D3 | Nudges | **Transient + live inventory.** No persisted nudge messages. A single per-request status message is appended post-transform at the end of the outgoing array: band text (when a nudge is pending) + current label span + active blocks + protected hints. Suffix-only → cache-safe by construction (see §4.6). |
| D4 | Projection tolerance | **Tolerate unambiguous extras.** Unmatched incoming messages pass through untouched, unlabeled. Genuinely ambiguous mappings (≠1 solution) still fail closed (`join_ambiguous`). |
| D5 | P2 (persistent id map, baseline retirement) | **Defer.** Documented as target architecture only (§5). Not executed in this refactor. |

---

## 3. Target architecture (after this refactor)

```
pi request
  │
  ▼
transformContext (lifecycle.ts)
  ├─ early return if !valid || mutationBlocked   → readiness=unavailable(state_invalidated)
  └─ transformOutgoingContext (pipeline.ts)
       ├─ buildContextEntries → projectContextEntries → buildProtocolUnits
       ├─ joinProjectedMessages (tolerant: extras pass through; ambiguity fails)
       ├─ replaceBlocks (block summary messages only — NO separate unit label messages)
       ├─ injectInlineLabels (new: tags appended to content, BLOCKED markers)
       ├─ validateProtocol, canonicalWire+validateWire (safety net, generic adapter)
       ├─ createBaselineSnapshot (unchanged), reconcileAvailability (unchanged)
       ├─ success → lastReadiness = { ready: true, adapterId, generation }
       └─ failure → lastReadiness = { ready: false, reason, generation } + loud diagnostics
  │
  ├─ append status message (post-transform, end of array) ← transient nudge + live inventory
  ▼
outgoing context (labels inline in content; status line last)
  │
compress tool call (tool.ts)
  ├─ recover producing baseline (unchanged machinery)
  ├─ baseline unavailable → report readiness reason first (compression_unavailable)
  ├─ range errors → name offending id + valid span + active blocks + retry instruction
  └─ success path unchanged (envelope, append, reduce, generation++, clearBaselines)
```

Invariants preserved: append-only history, non-destructive outgoing transform, event-sourced state with idempotent replay, complete tool-call/result protocol units, model-authored summaries, fail-closed on ambiguity, privacy-safe logging, branch isolation.

---

## 4. Work items (execution order)

Each work item is complete (implementation + tests + acceptance) before the next starts. Items W1–W4 do not depend on each other's code, but run in this order to keep the tree green at every step.

### W0 — Lock the failure (tests first, red)

**Goal:** Regression fixtures that fail on today's code and pass only after the fix. Written before W1 so the fix is driven by a red test.

**Files created:**

- `test/fixtures/captured-session-2026-08-16.json` — derived from the captured session, **redacted** (no reasoning payloads, credentials, raw tool outputs, or paths inside sensitive content). Shape:
  ```json
  {
    "provider": "openai-codex",
    "model": "gpt-5.6-luna",
    "api": "openai-codex-responses",
    "entries": [ { "type": "message", "id": "entry-1", "parentId": null, "timestamp": "…", "message": { "role": "user", "content": "…" } }, "…" ]
  }
  ```
  Trimmed to representative units: several user/assistant exchanges, one assistant tool-call with results, one `compress` assistant call (`startId: "m0227"`, `endId: "m2109"`) followed by its tool result. Keep the original entry ids and the exact compress parameters so the test reproduces the historical failure.
- `test/regression/captured-session.test.ts` — asserts, against the fixture:
  1. `transformOutgoingContext` with `ctx.model.api = "openai-codex-responses"` **succeeds**: snapshot defined, `lastReadiness.ready === true` (W1), inline labels present (W5).
  2. A `compress` call with `m0227`/`m2109` returns a **range error whose text names the invalid ids and the valid label span** (W4). Today it returns `baseline_unavailable (assistant_provenance_missing)`.
  3. Before any transform, readiness is `{ready:false}` with a non-`baseline_unavailable` reason.
- `test/unit/transform-any-api.test.ts` — for each api id `["openai-completions", "openai-responses", "anthropic-messages", "azure-openai-responses", "google-generative-ai", "openai-codex-responses", "opencode-cli-runner", "test"]`, a mixed conversation (user, assistant text, assistant toolCall, toolResult, custom block summary) transforms successfully and produces a snapshot. **Red on today's code** for the four missing apis.

**Acceptance:** both files fail (red) before W1; the fixture assertions become green as W1/W4/W5 land.

---

### W0.5 — GBNF-safe compress schema (llama.cpp compatibility)

**Goal:** the `compress` tool schema must not break hosts that convert JSON Schema to GBNF grammars (llama.cpp). It cannot convert the `\d` escape.

**Problem:** `src/compression/schema.ts:7-8` defines `startId`/`endId` with `pattern: "^(m\\d{4}|b\\d{4})$"`. When pi serves this schema to a llama.cpp backend, schema-to-GBNF conversion fails and the model session is unusable. These are the only two `\d` occurrences in `src/` (verified by grep).

**W0.5.1 `schema.ts`:** replace both patterns with a GBNF-safe equivalent — plain character class and repetition, no escapes:
```ts
pattern: "^(m|b)[0-9]{4}$"
```
- `[0-9]` is an ordinary character class and `{4}` is a repetition — both convert cleanly to GBNF.
- Semantics preserved: labels are exactly 5 chars, `m`/`b` + 4 digits; the 4-digit requirement matches `unitAliases` (`m${padStart(4)}`) and the `(bNNNN)` placeholder rule in `validateSummary`.
- No other change: alias resolution in `range.ts` and execution-time validation in `tool.ts` remain the enforcement layer (mis-shaped ids already fail with actionable `range_invalid` text per W4).

**Tests:**
- `test/unit/schema-gbnf.test.ts` (new):
  1. `CompressionParametersV2` schema serialized with `JSON.stringify` contains no `\\d` (and no other backslash escapes outside `[0-9]`).
  2. The pattern matches `m0001`, `b0001`, `m9999` and rejects `m1`, `b1`, `m00001`, `m000x`, `m-001`, empty string.
  3. A red pre-fix assertion variant: the current `^(m\\d{4}|b\\d{4})$` fails the "no `\\d`" check — write the test before the fix.

**Sequencing note:** independent of W1–W8; can land immediately (it is the user's live blocker). No dependencies either way. Optionally, GBNF conversion itself can be smoke-tested locally with `llama.cpp`'s converter if available; the string-level test is the CI gate.

**Acceptance:** the compress tool schema converts cleanly on llama.cpp; no `\d` remains in any pi-dcp schema.

---

**Files:** `src/transform/adapters.ts`, `src/transform/pipeline.ts`, `src/runtime.ts`, `src/lifecycle.ts`, `src/observability/logger.ts`.

**W1.1 `adapters.ts`:**
- Delete `certified` map, `isCertifiedAdapter`, `certifiedAdapterIds`.
- `adapterForModel(model: Pick<ModelKey, "api">): AliasTransportAdapter` — **never returns undefined**; returns `makeAdapter(model.api || "unknown")`.
- Keep `makeAdapter`, `canonicalWire`, `validateWire` unchanged.
- Add `knownAdapterIds(): string[]` returning `["openai-completions", "openai-responses", "anthropic-messages", "azure-openai-responses", "google-generative-ai", "openai-codex-responses"]` — diagnostics only, used by `/dcp debug` (W6). It gates nothing.

**W1.2 `pipeline.ts`:**
- Remove the `if (!adapter) return failure(fallback, state, "provider_adapter_unsupported")` branch at lines 53-54.
- Keep the `canonicalWire` + `validateWire` check; on failure keep reason `provider_adapter_unsupported` (should never fire for a real transform output; it is the safety net).
- Unchanged: catch-block mapping (`alias_overflow` / `projection_unsupported`), `failure()` semantics, `TransformResult`.

**W1.3 `runtime.ts` — readiness:**
- Add fields to `DcpRuntime`:
  ```ts
  lastReadiness?: {
    ready: boolean;
    reason?: string;      // one of the ReasonCode reasons when !ready
    adapterId?: string;   // ctx.model.api as seen by the last transform
    generation: number;
  };
  lastModel?: ModelKey;   // for /dcp debug
  ```
- `createRuntime()` initializes `lastReadiness = { ready: false, reason: "extension_disabled", generation: 0 }`.
- `disableRuntime(reason)`: set `lastReadiness = { ready: false, reason, generation }`.
- `invalidateSnapshot(runtime)`: set `lastReadiness = { ready: false, reason: "state_invalidated", generation }` **in addition to** existing clearBaselines+generation++.

**W1.4 `lifecycle.ts` — set readiness in `transformContext` (lines 137-169):**
- On the early-return path (`!valid || mutationBlocked`): if `valid` and `mutationBlocked` → `lastReadiness = { ready:false, reason:"state_invalidated", generation }`; if `!valid` → leave as set by `disableRuntime`.
- On `result.snapshot` success: `lastReadiness = { ready:true, adapterId: ctx.model?.api || "unknown", generation }`; also store `lastModel = modelKey(ctx.model, ctx.getContextUsage()?.contextWindow || 0)`.
- On failure: `lastReadiness = { ready:false, reason: result.reason || "unknown", generation }`.
- Store `lastReadiness` on `runtime` in all paths before returning.

**W1.5 `logger.ts`:** add ReasonCodes `"compression_unavailable"` and `"state_invalidated"`.

**Tests:**
- `test/regression/captured-session.test.ts` #3 (above).
- `test/unit/transform-any-api.test.ts` (above).
- `test/integration/lifecycle.test.ts`: add a case — transform with a supported api succeeds → `runtime.lastReadiness.ready === true`; simulate a failure path (`projection_unsupported` via an unknown entry type) → `lastReadiness.ready === false` with the reason.

**Acceptance:** every pi-ai API id transforms; readiness reflects per-request truth; `npm run typecheck` green; W0 tests 1 and 3 green.

---

### W2 — P0: Projection tolerance (extras pass through, ambiguity fails closed)

**Files:** `src/identity/join.ts`, `src/transform/pipeline.ts`.

**W2.1 `join.ts` — new contract:**
`joinProjectedMessages(expected, incoming)` returns `JoinResult`:
- `{ ok: true, incomingByExpected: number[] }` where `incomingByExpected[i]` is the strictly-increasing incoming index matched to expected `i` (same search algorithm, cap 2 solutions, duplicate toolCall ids → `protocol_invalid`, `solutions.length !== 1` → `join_ambiguous`).
- Unmatched incoming messages are **not** an error. The caller derives them from `incomingByExpected`.

**W2.2 `pipeline.ts`:**
- Remove the `input.length !== projection.messages.length` condition (line 61). Keep `!join.ok` → `failure(fallback, state, join.ok ? "join_ambiguous" : join.reason)`.
- Replace the canonical-message extraction and the merge:
  1. `canonicalMessages = projection.messages.map((_item, i) => input[join.incomingByExpected[i]])` (unchanged).
  2. After `transformed = applyPersistedRedactions(replaceBlocks(canonicalMessages, units, snapshot, availableState), availableState)` (which is in expected order), **re-merge with extras**: build a `Set` of incoming positions consumed by `incomingByExpected`; walk `input` in order — consumed position → emit next transformed message; unconsumed position → emit the **raw incoming message untouched** (no labels, no replacement, no redaction).
  3. `validateProtocol`, `canonicalWire`, `validateWire`, token estimates run on the merged array.
- `changedPrefix` (`firstChangedMessage(input, transformed)`): keep the existing element-wise comparison as a heuristic; it may report an earlier position than the true first change — acceptable (confidence is heuristic). Document with a comment.

**Tests:**
- `test/unit/join-tolerance.test.ts`:
  1. Extra injected message (e.g. a custom entry another extension produced, not projected) at position 0, mid-array, and at the end → transform succeeds; extra appears in output unlabeled and byte-identical; every expected message still carries the correct inline label (after W5).
  2. Two identical-fingerprint messages in `expected`, matched 1:1 by an unambiguous (single strictly-increasing) positional solution → transform succeeds (equal fingerprints mean equal content, so any valid pairing is correct). A duplicate-fingerprint *extra* that creates a second valid pairing (`solutions.length !== 1`) still fails closed with `join_ambiguous`. **Revision 2026-08-18:** the initial implementation added a blanket rejection on any duplicate fingerprint in `expected`; this made `join_ambiguous` permanent for the rest of any session containing two byte-identical messages (common — repeated "yes"/"ok", a prompt re-run verbatim), even though "retry on the next request" (see error-copy table) can never fix it. Removed; the pre-existing `solutions.length !== 1` check already fails closed on genuine ambiguity.
  3. Existing projection tests (`test/golden/projection.test.ts`) stay green.

**Acceptance:** extensions can no longer silently kill the transform; genuine ambiguity still fails closed; existing suites green.

---

### W3 — P0: Loud failures

**Goal:** a failed transform is visible to the user and recorded, once per reason.

**Files:** `src/lifecycle.ts`, `src/runtime.ts` (no new fields needed; `warnedReasonCodes` exists).

**W3.1 `transformContext` failure branch (after W1.4):**
- `runtime.logger.diagnostic({ reason: result.reason || "unknown", confidence: result.confidence })`.
- If `result.reason` is not in `runtime.warnedReasonCodes`: `ctx.ui?.notify?.(`pi-dcp: context transform disabled: ${result.reason}`)` and add the reason to `warnedReasonCodes`. `ui` may be absent — guard with `?.`. Toast text must not contain message content.

**W3.2 `disableRuntime`:** also emit `logger.diagnostic({ reason })` (it already records `warnedReasonCodes`).

**Tests:**
- `test/integration/lifecycle.test.ts`: failing transform → `logger.diagnostic` called once with the reason; second identical failure → no second notify (warned set), but diagnostic still emitted.

**Acceptance:** no silent deaths; per-reason dedup; privacy-safe (reasons only, no content).

---

### W4 — P1.2: Actionable errors

**Goal:** every compress rejection names the offending input and tells the model how to retry.

**Files:** `src/compression/tool.ts`, `src/compression/range.ts`, `src/compression/service.ts`, `src/compression/protected.ts`, new `src/compression/errors.ts`.

**W4.1 `range.ts`:** `resolveCompressionRanges` failure return becomes
```ts
{ ok: false, reason: "range_invalid" | "range_overlap" | "block_partial",
  rangeIndex: number,          // index into the ranges array
  id?: string }                // the offending startId/endId for range_invalid
```
`aliasBoundary` reports which id failed to resolve. Existing consumers keep working (`ok` still false).

**W4.2 `protected.ts`:** `protectUnit` returns `{ protected: boolean; byTool?: string; byPattern?: string }` — name the tool name or file pattern that matched. `service.ts` threads the detail through its `content_protected` failure.

**W4.3 `service.ts`:** every `content_protected` failure includes `{ rangeIndex, byTool?, byPattern? }`; `summary_invalid` includes `{ rangeIndex, hint }` (e.g. "missing (bNNNN) placeholder" / "exceeds maxChars" from `expandNestedSummary` / `validateSummary`).

**W4.4 new `src/compression/errors.ts`** — `buildErrorText(runtime, reason, extra)` returns:
```
pi-dcp: <reason> (<stage>) — <diagnosis>
<guidance lines>
```
Per-reason spec:

| reason | diagnosis | guidance |
|---|---|---|
| `compression_unavailable` | readiness reason + "No aliases were published for the current request." | Retry advice per readiness reason: `provider_adapter_unsupported` → (defensive, generic adapter makes this near-impossible) "reload pi-dcp"; `projection_unsupported` / `join_ambiguous` / `protocol_invalid` → "another extension modified the context; retry on the next request"; `alias_overflow` → "session exceeded 9999 units". |
| `baseline_unavailable` | "No baseline could be recovered for this tool call." | "Re-issue compress on the next turn, after the context transform publishes labels again." |
| `range_invalid` | `"${id}" is not a current label.` | `Valid labels right now: m0001-m0184. Active blocks: b0001 (topic), b0002 (topic). Re-issue compress with labels from this list.` (from producing baseline + reduced state) |
| `range_overlap` | "Range ${rangeIndex} overlaps an earlier range." | Same label list. |
| `block_partial` | "Range ${rangeIndex} intersects block ${id} partially." | "Select the whole block or none of it." |
| `content_protected` | `"Unit at range ${rangeIndex} is protected${byTool ? ` by tool ${byTool}` : ""}${byPattern ? ` (pattern ${byPattern})` : ""}."` | "Choose a range excluding protected units; protected units are marked BLOCKED inline." |
| `placeholder_invalid` / `summary_invalid` | per W4.3 | "Fix the summary and retry; see the tool description for placeholder rules." |
| `permission_denied` / `permission_unavailable` | as today | "Compression permission is ${config.compress.permission}; ask your operator to change it." |

When a baseline exists, `buildErrorText` renders the label inventory from `baseline.unitAliases` + `baseline.blockAliases` + `runtime.reduced` (active+available blocks). When no baseline exists, inventory lines are omitted and the readiness reason is reported instead.

**W4.5 `tool.ts` — wire it in:**
- Replace the `failure()` one-liner calls in `executeCompression` with `buildErrorText` (keep `failure()` for the internal return shape; `error` field keeps the same reason string, and the `text` shown to the model becomes the full text). `failure()` gains `text` = `buildErrorText(...)`.
- New branch: in the `producingBaseline` miss path, if `runtime.lastReadiness && !runtime.lastReadiness.ready` → return `{ error: "compression_unavailable", stage: runtime.lastReadiness.reason, text: buildErrorText(...) }` (readiness reason first, per GPT's error-classification hierarchy). Otherwise keep `baseline_unavailable (assistant_provenance_missing)`.
- Success text unchanged: `pi-dcp compressed N range(s). Refresh context aliases.`

**Tests:**
- `test/unit/errors.test.ts`: for each reason in the table, assert the text contains the diagnosis and the retry elements (offending id / valid span / block list).
- `test/regression/captured-session.test.ts` #2 asserts `m0227` is named and the valid span appears.

**Acceptance:** every failure becomes a retry loop; no opaque one-liners remain.

---

### W5 — P1.1: Inline labels

**Goal:** labels attached to the content they identify; separate unit label messages deleted; protected units marked BLOCKED at point of selection.

**Files:** new `src/transform/labels.ts`, `src/transform/blocks.ts`, `src/transform/pipeline.ts`, `src/identity/snapshot.ts`.

**W5.1 tag format** (new `labels.ts`):
```
const LABEL_TAG_NAME = "pi-dcp-message-id";
formatLabelTag(ref) → `\n<pi-dcp-message-id>${ref}</pi-dcp-message-id>`   // ref = "m0042" | "b0001" | "BLOCKED"
```

**W5.2 `blocks.ts`:** in `replaceBlocks`, **delete** the separate `pi-dcp.v2.unit` custom label message push (lines ~60-67). Block replacement messages (`pi-dcp.v2.summary`) remain, emitted at the unit-start position exactly as today.

**W5.3 `labels.ts` — `injectInlineLabels(messages, units, snapshot, protection): messages`:**
Walks the output array in order with a cursor over `units` (block replacements sit at their unit's start position and belong to the block):

| message | tag | rule |
|---|---|---|
| block replacement (`pi-dcp.v2.summary`) | `bNNNN` of the block | append `formatLabelTag(alias)` to the string content. |
| compressible unit (first message of the unit) | `mNNNN` | see per-role rules below. |
| non-compressible unit (unsettled tool exchange), `custom`/`compactionSummary`/`branchSummary` | `BLOCKED` | appended per-role below. |
| unit protected at transform time (tool/path protection only — static per config; NOT `protectUserMessages`/`turnProtection`, which are dynamic and re-checked by `service.ts`) | `BLOCKED` | same as compressible otherwise. |

Per-role append rules (only the **first message of each unit** is tagged; never mutating later messages of the same unit):
- **user** (content string or text/image parts): string → `content + formatLabelTag(tag)`; parts array → append `{ type: "text", text: formatLabelTag(tag) }` to the parts array; image-only (no text part) → append the text part (same rule covers it).
- **assistant**: append to the **last text part**; if the message has no text part → append a synthetic trailing `{ type: "text", text: formatLabelTag(tag) }` part. **Never touch `thinking` parts (signature-bearing) and never touch `toolCall` parts (JSON arguments).** If the message consists only of thinking/toolCall parts and a synthetic part cannot be appended without reordering parts, append it **after** all parts (trailing).
- **toolResult** (content is a parts array): append `{ type: "text", text: formatLabelTag(tag) }` to the content array.
- **custom / compactionSummary / branchSummary**: append to the string content (same as user-string rule).

Determinism: tags derive solely from snapshot aliases → deterministic per projection; two equivalent transforms stay byte-identical.

**W5.4 `pipeline.ts`:** after `replaceBlocks`/`applyPersistedRedactions` and **before** `validateProtocol`/wire checks, run `injectInlineLabels(merged, units, snapshot, protectionFromConfig)`. `protectionFromConfig = { cwd, protectedTools: config.compress.protectedTools, protectedFilePatterns: config.protectedFilePatterns }`.

**W5.5 `snapshot.ts`:** bump `dcpTransformHash.aliasTransport` from `"local-unit-v2"` to `"local-unit-inline-v1"` (one-time snapshot-hash change; old persisted baselines stop matching, which is intended).

**Tests:**
- `test/unit/inline-labels.test.ts`:
  1. user/assistant text/toolResult/custom block messages get the correct tags per the table.
  2. assistant message with thinking parts + toolCall: thinking parts **byte-identical** after transform; tag in the trailing/last text part only.
  3. protected unit (config `protectedTools: ["edit"]`, unit contains an `edit` toolResult) → `BLOCKED`.
  4. unsettled tool exchange unit → `BLOCKED`; compressible → `mNNNN`.
  5. determinism: transform twice → byte-identical arrays.
  6. no `pi-dcp.v2.unit` custom message remains in output.
- `test/unit/cache-snapshot-v2.test.ts`: existing tests updated — equivalent transforms still byte-identical (now including tags); wire-prefix test still asserts canonicalWire prefix equality with `adapterForModel({ api: "test" })` (still returns the generic adapter).
- `test/unit/join-tolerance.test.ts` #1 asserts tags on expected messages with an extra injected message present.
- Signature fixtures: per api id in `test/unit/transform-any-api.test.ts`, a conversation with a `thinking` part asserts thinking content byte-identical post-transform.

**Acceptance:** labels co-located with content; no synthetic label messages; BLOCKED visible before selection; deterministic; thinking parts never mutated.

---

### W6 — P1.5: Prompts, manual command, diagnostics

**Files:** `src/prompts/defaults.ts`, `src/compression/tool.ts` (tool description), `src/commands/index.ts`, `src/commands/debug.ts`, `src/commands/context.ts`, `src/runtime.ts` (no change — W1 fields suffice).

**W6.1 `SYSTEM_GUIDANCE`** (full replacement text):
```
pi-dcp context management guidance.

Compression is model-authored through the compress tool. Compress older, closed work to keep this session focused; treat summaries as authoritative records, not deletions.

COMPRESS WHEN
- Research concluded and findings are clear.
- Implementation finished and verified.
- Exploration exhausted and patterns understood.
- Dead-end noise can be discarded without waiting for a whole chapter to close.

DO NOT COMPRESS IF
- Raw context is still relevant and needed for edits or precise references.
- The target content is still actively in progress.
- You may need exact code, error messages, or file contents in the immediate next steps.

Labels: every message in this conversation carries a local label attached to its content: <pi-dcp-message-id>mNNNN</pi-dcp-message-id> for a compressible protocol unit, <pi-dcp-message-id>bNNNN</pi-dcp-message-id> for an active compressed block, or <pi-dcp-message-id>BLOCKED</pi-dcp-message-id> for a unit that cannot be included. A protocol unit is one user turn, or one assistant tool-call message together with ALL of its tool results; always select whole units.

Copy labels from the visible context only. Never invent labels, never inspect the session file on disk, and do not call compress if no labels are visible. If a status line lists labels, they are real and usable.

Before compressing, ask yourself: is this section closed enough to become summary-only right now?
```

**W6.2 compress tool description** (full replacement text):
```
Create faithful, contiguous, model-authored summaries for older resolved context.

Selection
- Choose complete protocol units (a user turn, or an assistant tool-call message together with ALL of its tool results) whose work is finished.
- The range is inclusive: every unit between startId and endId is included.
- startId must precede endId; ranges must not overlap.
- Use only labels visible in the current context: <pi-dcp-message-id>mNNNN</pi-dcp-message-id> for units, <pi-dcp-message-id>bNNNN</pi-dcp-message-id> for active blocks. Units marked BLOCKED cannot be included.
- Never invent labels; if no labels are visible, do not call this tool.
- Do not include: active work, unresolved questions, pending tool exchanges, details still needed for immediate edits, or protected content (protected tools and file patterns).

Summary quality
- Write an exhaustive technical summary: decisions, constraints, exact paths, findings, verification evidence.
- Preserve user intent; quote short user messages verbatim when they carry the intent.
- Keep the summary lean: no preamble, no restating the obvious.

Nested blocks
- If your range includes a block (bNNNN), you MUST reference it in the summary as (bNNNN) exactly once per block.
- (bNNNN) are reserved tokens; do not invent them and do not repeat one.
- Preflight check before calling: every block inside your range appears exactly once in your summary.

Batching
- You may pass up to 16 ranges in one call; each range gets its own summary.

Validation
- The call is authorized from the assistant response that produced the tool call; ranges are validated against the current baseline. Failures return the reason and the currently valid labels so you can retry.
```
(Keep `promptGuidelines` entries in sync with this text.)

**W6.3 manual command (`commands/index.ts`)** — `handleDcp` `"compress"` branch:
- Gate: if `runtime.lastReadiness && !runtime.lastReadiness.ready` → `ctx.ui?.notify?.(`pi-dcp: compression unavailable: ${runtime.lastReadiness.reason}. No aliases were published.`); return` without sending a user message.
- Else send, as today (pendingManual set/cleared identically), with text:
```
Perform exactly one pi-dcp compression pass now.

Choose one or more older, resolved ranges from the visible conversation only. Use only current visible mNNNN or bNNNN labels; do not inspect the session file and do not invent IDs. Keep the latest user intent, active work, unresolved questions, pending tool exchanges, and protected content out of the selected range. Write an exhaustive technical summary preserving decisions, constraints, paths, findings, and verification evidence. If no safe visible labels are available, do not call compress and report that compression is unavailable.
```
Followed by ` Focus: ${rest}` when a focus string was supplied.

**W6.4 `/dcp debug` (`debug.ts`)** — append lines:
```
runtime version:       0.2.0 (from lifecycle.ts VERSION)
active model:          <runtime.lastModel?.provider>/<runtime.lastModel?.id>
active API:            <runtime.lastModel?.api>        (or "none yet")
adapter:               generic (known apis: openai-completions, openai-responses, anthropic-messages, azure-openai-responses, google-generative-ai, openai-codex-responses)
compression readiness: ready | unavailable (<lastReadiness.reason>)
```
Keep existing lines (baselines count, last transform, nudge inputs).

**W6.5 `/dcp context` (`context.ts`):** append one line `compression: ready | unavailable (<reason>)`.

**Tests:**
- `test/unit/prompts.test.ts` (new): SYSTEM_GUIDANCE and tool description are stable fixtures; assert presence of required elements: "closed", "exhaustive", "user intent", "Never invent", "do not call this tool" (tool desc) / "do not call compress" (guidance), "inspect the session file" prohibition, "BLOCKED", complete protocol units, `(bNNNN)` exactly once, preflight.
- `test/integration/command-registration.test.ts`: manual compress with readiness false → no `sendUserMessage` call + notify called; readiness true → message sent with the new text.
- `test/unit/commands.test.ts` (new or extended): debug output contains the new lines.

**Acceptance:** prompts encode the full selection protocol; manual command is gated; diagnostics expose version/model/api/readiness.

---

### W7 — P1.3+P1.4: Transient nudges + live inventory

**Goal:** nudges no longer persist; every request carries one fresh, deterministic status message teaching the model the current compressible inventory.

**Files:** `src/lifecycle.ts`, `src/runtime.ts`, `src/prompts/nudge.ts` (keep `stableNudgeText` and `evaluateNudge`), `src/transform/metadata.ts` (delete deprecated v1 remnants `nudgeMessage`/`metadataMessage`/`insertMetadata`), `src/state/operations.ts` (no change — `nudge.requested` ops remain the record).

**W7.1 `runtime.ts`:** add `pendingNudge?: { band: "soft" | "imperative" | "critical"; nudgeKey: string }`. Remove `nudgeInFlightKey` (superseded).

**W7.2 `lifecycle.ts`:**
- `beforeAgentStart`: **delete** the persisted `message` delivery (the `custom_message` return) and the `alreadyPersisted` branch-scan. Still append `SYSTEM_GUIDANCE` to the system prompt.
- `onSettled` (lines 196-261): unchanged nudge evaluation, but the nudge decision only produces `runtime.pendingNudge = { band, nudgeKey }` **if** `runtime.lastReadiness?.ready` and the `nudge.requested` envelope is appended (keep envelope + `lastNudgeTurn` bookkeeping). If not ready → skip (record nothing).
- `turn_start`: clear `pendingNudge` if the **last assistant message contains a `compress` tool call** (opencode's anchor-clearing signal); otherwise keep. Keep the existing `nudgeInFlightKey = undefined` line removed with the field.
- `transformContext` — **status injection (post-transform, always when `runtime.valid`)**:
  ```ts
  const status = buildStatusMessage(runtime, band);   // new helper, see below
  if (status && event.messages) event.messages = [...event.messages, status];
  ```
  Appended **after** the transform result is assigned (both success and fallback paths, i.e. after the early returns when valid). It never participates in join/canonicalWire/validateProtocol. `buildStatusMessage` lives in `src/prompts/status.ts` (new):
  - Ready (`lastReadiness.ready`): `[pi-dcp status] Compression ready. Current labels: <min>-<max> of snapshot unitAliases (e.g. "m0001-m0184"). Active blocks: <aliases with topics from reduced state, active+available>. Protected units are marked BLOCKED inline.` + (if `pendingNudge`) ` ` + `stableNudgeText(pendingNudge.band)`. Then `runtime.pendingNudge = undefined`.
  - Not ready: `[pi-dcp status] Compression unavailable for this request: <lastReadiness.reason>. No aliases were published. Do not call compress; retry on a later request.`
  - Message shape: `{ role: "custom", customType: "pi-dcp.v2.status", display: false, timestamp: 0, content }`.
  - **Cache-safety rules (hard):** content carries only deterministic alias data + static band text — never token counts, never timestamps, never usage numbers (this honors the existing `metadata.ts:21-23` comment: changing measurements stay out of the prompt). The message is always the last element → suffix-only cache impact.
- If `!runtime.valid` → no status message (transformContext already returned early).

**W7.3 `metadata.ts`:** delete deprecated `nudgeMessage`/`metadataMessage`/`insertMetadata`.

**Tests:**
- `test/unit/status-message.test.ts`:
  1. ready → message contains label span + block aliases + topics; pendingNudge band text present when set, cleared after injection.
  2. not ready → contains reason, no aliases.
  3. determinism: same state → byte-identical content (and a pending nudge does not change other turns' messages).
  4. no `\d{4}-\d{2}-\d{2}` / `T\d{2}:\d{2}` / token-count patterns in content.
- `test/unit/cache-snapshot-v2.test.ts` — new test "keeps the old wire prefix when a status message is injected": transform output + status appended on turn N; on turn N+1 (new user message appended), `messages.slice(0, statusIndex)` equals the turn-N prefix bytes.
- `test/integration/lifecycle.test.ts`: readiness false → no `nudge.requested` envelope from `onSettled`; readiness true → envelope + `pendingNudge` set; compress call in last assistant message → `pendingNudge` cleared at next `turn_start`.

**Acceptance:** zero persisted nudge messages; one fresh status line per request; nudges suppressed when unready; cache prefix untouched by the status line.

---

### W8 — Full verification and soak measurement

**Goal:** entire suite green + measured evidence for the cache-safety claims.

**W8.1** Fix any existing tests that asserted the old behavior:
- `test/integration/lifecycle.test.ts`: failure-text assertions updated for W4 format if any assert exact strings.
- `test/unit/cache-snapshot-v2.test.ts`: adapter assertions still valid (generic adapter); add the W7 status test.
- `test/golden/providers.test.ts`: unchanged (fixtures still pass — they don't exercise adapters).

**W8.2** New `test/performance/soak.test.ts` (replaces/augments `scaling.test.ts`): synthetic N-turn session (N ≥ 50) with status injection and periodic compression:
- assert byte-equality of the cacheable prefix across turns (first changed message index stays at the newest appended region);
- measure transform latency (report, no hard threshold; document in SAVINGS_STATS_STATUS-style output only);
- assert a scripted compress loop (valid range → success; invalid id → actionable error text) reaches 100% success on valid ranges.

**W8.3** Manual soak per GPT Phase 7: run one real session on `openai-codex-responses` (`npm run test:live:opencode` pattern) and record: first changed message/token, cache read/write usage, transform latency, compress success rate, retries caused by invalid ranges. Report into the plan's acceptance log (not a code change).

**Verification commands (each phase end):**
```bash
npm run typecheck
npx vitest run test/regression test/unit/transform-any-api.test.ts        # after W0/W1
npm run test:unit && npm run test:integration && npm run test:golden       # per phase
npm run check                                                               # final gate
```

---

## 5. P2 — Target architecture (future work, NOT executed)

For the record, so W0–W8 do not paint the code into a corner:

- **Persistent id map:** allocate `mNNNN` once per entry id in reduced state (`state.reducer`), never reassign; aliases then mean the same thing all session regardless of compression/pruning. This replaces positional ordinals in `snapshot.ts:41-47`.
- **Retire the baseline machinery:** with persistent ids, `runtime.baselines`, `compressionProvenance`, `bindCompressionProvenance`, `baselineIdentityMatches`, `validateBaselineHistory`, `computeSnapshotHash`, and the `generation` counter become unnecessary (roughly `snapshot.ts` + most of `runtime.ts` + ~150 lines of `tool.ts` deleted). Resolution = id lookup + compressibility check. Fork/edit detection is already covered by pi's `session_before_fork/tree/switch` → `mutationBlocked`.
- **Constraints:** never persist `mNNNN`/`bNNNN` as canonical references; durable identities stay entry ids, tool-call ids, block ids. Re-verify `session_before_fork` coverage with real branch-switch tests before deleting the hash machinery.
- **Trigger to revisit:** after this refactor ships, if `baseline_unavailable` / `baseline_identity_mismatch` / `history_changed` appear in real sessions at non-trivial rates, P2 moves up.

---

## 6. Test matrix (GPT §7 mapped to files)

| GPT requirement | File |
|---|---|
| Captured-session regression (adapter, readiness, m0227/m2109, nudge suppression) | `test/regression/captured-session.test.ts` |
| Adapter wire tests per api (roles, tool pairing, determinism, thinking immutability, inline labels) | `test/unit/transform-any-api.test.ts`, `test/unit/inline-labels.test.ts` |
| Provenance: existing suite (early binding, execute-time recovery, missing, duplicate) | `test/integration/lifecycle.test.ts` (unchanged cases) |
| Readiness: gating nudges/manual/tool, debug output, failed transform clearing readiness | lifecycle + command + status tests above |
| Alias usability: adjacent labels, consistency, no aliases when unready, no JSONL sourcing | `test/unit/inline-labels.test.ts`, `test/unit/status-message.test.ts` |
| Prompt fixtures | `test/unit/prompts.test.ts` |
| Projection tolerance | `test/unit/join-tolerance.test.ts` |
| GBNF-safe schema (no `\d`) | `test/unit/schema-gbnf.test.ts` |
| Cache-prefix invariance | `test/unit/cache-snapshot-v2.test.ts` (extended) |
| Soak | `test/performance/soak.test.ts` + manual soak |

---

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Inline tags change token counts and could shift model attention | Tags are one short line per unit; opencode ships the same mechanism in production. Soak measures token overhead. |
| Consecutive-user runs at the status line (custom→user on the wire) | Pre-existing behavior (nudges did the same); status is the last message; providers merge deterministically. Verified in soak on the real API. |
| Thinking-part signature invalidation | Tags touch only text parts; fixture tests assert thinking parts byte-identical per API (W5). |
| Tolerant join mis-maps duplicates | Fingerprint search unchanged; ambiguity still fails closed (`solutions !== 1`). |
| Readiness flaps per request | Readiness is per-request by design; nudges/manual gate on it; the tool explains itself. No persistent state is invalidated. |
| `changedPrefix` heuristic shifts with pass-through extras | Confidence-only; documented in code (W2.2). |
| Cache regression from status line | Suffix-only by construction + prefix-equivalence test + soak measurement; fallback = static text without inventory (documented in W7). |

---

## 8. Acceptance criteria

1. `openai-codex-responses` (and every other pi-ai API id) transforms successfully without code changes per API.
2. The captured session's failure is reported as `compression_unavailable` with the readiness reason, never a bare `baseline_unavailable`.
3. Compression is not advertised when readiness is false: no nudge band, no manual-compress message, status line says unavailable.
4. A valid request publishes inline labels adjacent to content; no separate `pi-dcp.v2.unit` messages remain.
5. Protected/unsettled units show BLOCKED inline.
6. Every compress rejection names the offending id/range and lists the valid span + active blocks.
7. Prompts forbid invented ids and JSONL inspection.
8. Nudges are transient; exactly one status message per request; prefix byte-identical across turns (tested).
9. Other extensions' injected messages no longer disable the transform; genuine ambiguity still fails closed.
10. The compress tool schema contains no `\d` escapes and converts to GBNF cleanly (llama.cpp compatible).
11. `npm run check` green; soak measured and reported.