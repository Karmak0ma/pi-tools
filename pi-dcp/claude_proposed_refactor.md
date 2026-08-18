# pi-dcp: Failure Analysis and Proposed Refactor

**Date:** 2026-08-17
**Analyzed session:** `/home/vflores/.pi/agent/sessions/--home-vflores-repos-breakfast_conquer--/2026-08-16T11-47-27-964Z_01a00a65-f05b-75a2-b877-a96f1282ace9.jsonl`
**Reference implementation:** `/home/vflores/repos/opencode-dynamic-context-pruning` (opencode DCP)

---

## Executive summary

Two separate problems, one of which fully explains the other.

1. **Hard bug (P0):** pi-dcp's context transform was **silently disabled for the entire session** because
   the model's API id (`openai-codex-responses`) is not in the adapter allow-list in
   `src/transform/adapters.ts:17-23`. With the transform disabled, no baseline snapshot is ever
   published, so the `compress` tool can only ever answer
   `baseline_unavailable (assistant_provenance_missing)`. This is not a race condition or a
   provenance-binding subtlety — it is a hard-coded list that does not contain the API the user runs.
   The same list also excludes **Anthropic and Gemini**, so pi-dcp is currently non-functional on
   three of the five APIs pi supports.

2. **Design problem (P1):** even when the transform works, range selection is expensive for the model
   because pi-dcp puts the `mNNNN` labels in **separate synthetic messages** rather than attached to
   the content they label, gives the model **no way to discover valid boundaries**, and returns
   **opaque, non-actionable errors** on failure. opencode DCP solves all three, and that is why it
   "just works".

The refactor proposal is: **delete the adapter allow-list, move labels inline into the message
content, and make every failure response teach the model how to retry.** Those three changes remove
most of the machinery that is currently failing.

---

## Part 1 — Why compression failed

### 1.1 Evidence from the session

The session ran a single model for all 309 assistant messages:

```
309 ('openai-codex', 'gpt-5.6-luna', 'openai-codex-responses')
```

Grepping the session file for pi-dcp's own transform markers:

```
pi-dcp.v2.unit    → 0 occurrences
pi-dcp.v2.summary → 0 occurrences
pi-dcp.v2.nudge   → 4 occurrences   (persisted nudges — these come from a different code path)
```

**The transform never ran successfully, not once, in a 679-entry session.** If it had, every outgoing
request would have carried one `pi-dcp.v2.unit` label per protocol unit.

The single compress attempt is at line 676, and its result at line 677:

```
CALL: compress {"topic": "Initial Phase 5 bootstrap and design handoff",
                "content": [{"startId": "m0227", "endId": "m2109", ...}]}
TOOLRESULT: pi-dcp: baseline_unavailable (assistant_provenance_missing)
```

### 1.2 The root cause chain

```
src/transform/adapters.ts:17-23
  certified = { "openai-completions", "openai-responses", "opencode-cli-runner", "test" }
        │
        │  ctx.model.api === "openai-codex-responses"  →  not in map
        ▼
src/transform/pipeline.ts:53-54
  const adapter = adapterForModel({ api: options.ctx.model?.api || "unknown" });
  if (!adapter) return failure(fallback, state, "provider_adapter_unsupported");
        │
        │  failure() returns { snapshot: undefined }
        ▼
src/lifecycle.ts:150-158
  if (result.snapshot) { publishBaseline(...) }
  else { clearBaselines(runtime); }        ← baseline registry emptied on EVERY request
        │
        ▼
src/compression/tool.ts:71-72
  const baseline = producingBaseline(toolCallId, ctx, runtime);
  if (!baseline) return { error: "baseline_unavailable",
                          stage: "assistant_provenance_missing" }
```

Every single request took this path. The compress tool was *registered and visible* to the model
(`setDcpToolActive` runs independently of the transform), the nudges were *delivered*, but the tool
was structurally incapable of succeeding.

### 1.3 Confirming the allow-list is wrong, not the model

The APIs pi/pi-ai actually ship (counted by references in `@earendil-works/pi-ai/dist`):

| API id | references | in pi-dcp allow-list? |
|---|---|---|
| `openai-completions` | 714 | yes |
| `anthropic-messages` | 317 | **no** |
| `openai-responses` | 138 | yes |
| `azure-openai-responses` | 95 | **no** |
| `google-generative-ai` | 42 | **no** |
| `openai-codex-responses` | 18 | **no** ← the user's model |
| `opencode-cli-runner` | 0 (not a pi-ai api id) | yes |

Note the last row: `opencode-cli-runner` is in the allow-list but does not appear anywhere in pi-ai.
The allow-list was written against assumptions that were never validated against the host.

### 1.4 Why the allow-list exists at all, and why it is the wrong abstraction

The stated rationale (`src/transform/adapters.ts:4-7`) is that a provider conversion "can merge
adjacent roles or discard custom-message metadata", so an unvalidated provider would be unsound.

That concern is real **only because of how pi-dcp injects labels**. `src/transform/blocks.ts:57-67`
emits a standalone message per unit:

```ts
output.push({
  role: "custom",
  customType: "pi-dcp.v2.unit",
  content: `[pi-dcp unit ${alias}: ${unit.descriptor}]`,
  ...
});
output.push(...messages.slice(unit.startProjectedIndex, unit.endProjectedIndex + 1));
```

Pi converts every `role: "custom"` message into a **user message** (`dist/core/messages.js:89-96`):

```js
case "custom": {
  const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
  return { role: "user", content, timestamp: m.timestamp };
}
```

So the wire shape becomes `user(label), user(real user msg), user(label), assistant, user(label),
assistant, ...`. That produces consecutive user messages, which is exactly the situation where
Anthropic-style APIs require merging — and merging is exactly what would silently destroy the labels.
**The allow-list is a workaround for a self-inflicted structural problem.** Remove the structural
problem and the allow-list becomes unnecessary.

The three adapters also do nothing meaningful: `annotate` is an identity function, `canonicalWire` is
only used for a validity check that merely asserts "array of objects with a string `role`", and
`validateWire` never rejects anything a real transform would produce. This is ~50 lines of code whose
only observable effect in production is disabling the extension.

### 1.5 Secondary fragility found while tracing

`src/transform/pipeline.ts:61`:

```ts
if (!join.ok || input.length !== projection.messages.length)
  return failure(fallback, state, join.ok ? "join_ambiguous" : join.reason);
```

This requires the `context` event's message array to be **exactly 1:1** with pi's own
`buildContextEntries()` projection. Per pi's docs (`docs/extensions.md:294-309`,
`dist/core/extensions/runner.js:747-765`), the context hook chain is sequential and any other
extension can add, remove, or reorder messages before pi-dcp sees them. This session had at least
`extmgr` and a telegram extension loaded. Any extension that injects a non-persisted message
permanently disables pi-dcp's transform with the same silent `failure()` path.

### 1.6 Failures are invisible

`failure()` in `pipeline.ts:121` returns a reason string that is stored in `runtime.lastTransform`
and surfaced only via `/dcp debug` or `/dcp context`. Nothing is logged, no toast is shown, the
compress tool is not deactivated, and the nudges keep telling the model to use aliases that do not
exist. A user has no signal that the extension is dead. **The extension failed silently for an entire
multi-day session.**

---

## Part 2 — Why range selection required so much work

Reading the model's actual behaviour at session lines 660-676 is instructive. After being asked to
compress, it did this:

| line | action |
|---|---|
| 660 | `bash: env \| grep -Ei 'PI\|DCP'` — looking for aliases in the environment |
| 662 | `read` the session `.jsonl` file, first 20 lines |
| 664 | `bash: wc -l` the session file |
| 666 | `bash: grep -oE '([mb][0-9]{4})'` the session file (with a path typo) |
| 668 | retry the grep with corrected path |
| 670 | `grep ... \| tail -80` |
| 672 | `grep -oE 'm[0-9]{4}'` |
| 674 | `grep -n -B2 -A3` for the ids it found |
| 676 | `compress` with `m0227` → `m2109` |

Seven tool calls of forensic archaeology, and the ids it finally used (`m0227`, `m2109`) were
**random four-digit substrings from hashes inside the session file**, not aliases at all. The model
was told to "use the current local mNNNN labels", could not see any, and had no mechanism to ask what
they were — so it hallucinated plausibly-shaped ones.

This is mostly a downstream symptom of the P0 bug. But three design choices make it worse and would
still hurt after the P0 fix:

### 2.1 The label is not attached to the thing it labels

pi-dcp: a separate message *before* the unit says `[pi-dcp unit m0007: tool exchange]`.
opencode: the id is appended **inside** the content of the message itself:

```xml
<dcp-message-id>m0007</dcp-message-id>
```

and, critically, the same tag is repeated inside **every tool output belonging to that message**, so
a multi-call assistant turn is unambiguously one id no matter which part the model is looking at
(`lib/messages/inject/inject.ts:145-214`). Protected messages render as
`<dcp-message-id>BLOCKED</dcp-message-id>`, so ineligibility is visible *at the point of selection*
instead of being discovered as a rejection after the fact.

Attaching the label to the content is strictly better for attention: the model does not have to
maintain a separate mapping from "the marker I saw N messages ago" to "the content I am reading now".

### 2.2 There is no discovery path

If a model is unsure which ids are valid, opencode gives it:

- ids inline in every message (always visible),
- `BLOCKED` markers on protected messages,
- an explicit live list of active compressed blocks appended to the nudge
  (`lib/prompts/extensions/nudge.ts:buildCompressedBlockGuidance`):
  `- Active compressed blocks in this session: 3 (b1, b2, b5)`,
- a priority list of stale high-cost messages: `- high-priority message IDs before this point: ...`.

pi-dcp gives it: a paragraph of prose telling it that `mNNNN` labels exist. There is no tool, no
listing, no dry-run, and `/dcp context` is a user-facing toast that never reaches the model.

### 2.3 Errors do not teach

Every failure in `src/compression/tool.ts` collapses to one line:

```
pi-dcp: baseline_unavailable (assistant_provenance_missing)
pi-dcp: range_invalid
pi-dcp: content_protected
pi-dcp: block_partial
```

None of these tell the model *what to do next*. `range_invalid` does not say which of the two ids was
bad or what the valid range is. `content_protected` does not say which unit or why. The model's only
possible response is to give up — which is exactly what it did at line 678:

> I attempted the requested compression, but pi-dcp refused it with `baseline_unavailable
> (assistant_provenance_missing)`. No conversation context was compressed.

### 2.4 The prompts are thin compared to the reference

pi-dcp's entire system guidance is one paragraph (`src/prompts/defaults.ts`, ~90 words). opencode
ships a structured system prompt (`lib/prompts/system.ts`) with explicit sections — *THE PHILOSOPHY OF
COMPRESS*, *COMPRESS WHEN* (4 bullets), *DO NOT COMPRESS IF* (3 bullets), and a self-check question —
plus a separate ~700-word tool description (`lib/prompts/compress-range.ts`) covering summary
quality, user-intent fidelity, placeholder rules with a preflight check, flow preservation after
expansion, and boundary-id rules. Its nudges are wrapped in `<dcp-system-reminder>` tags with
distinct soft/iteration/critical variants.

The difference is not verbosity for its own sake. The reference prompt answers the questions a model
actually has at decision time ("is this closed enough?", "what if the range contains a block?"),
which is why it produces consistent behaviour.

### 2.5 Nudges are persisted into history

`src/lifecycle.ts:beforeAgentStart` returns a `pi-dcp.v2.nudge` custom message, which pi persists as
a real session entry. This session accumulated 4 of them permanently. They are re-sent on every
subsequent request forever, cost tokens indefinitely, and — since they are pinned to a
`configGeneration` — go stale but stay visible. opencode injects nudges **transiently** into the
outgoing array each turn and actively removes stale ones (`stripStaleMetadata`), and clears its nudge
anchors as soon as it sees a `compress` call. Transient injection is the correct model for a
reminder.

---

## Part 3 — What opencode does differently (condensed)

| Concern | pi-dcp (current) | opencode DCP |
|---|---|---|
| Label transport | separate `role:"custom"` message per unit | `<dcp-message-id>` tag appended inside existing content |
| Label visibility in tool output | none | repeated in every tool output of the message |
| Protected content | discovered only via rejection | rendered inline as `BLOCKED` |
| Provider compatibility | hard-coded API allow-list; 3 of 5 APIs disabled | none needed — content-only mutation |
| Authorization | baseline snapshot + hash + generation + tool-call provenance binding | none; ids resolved against current messages at execute time |
| Id → message mapping | positional, rebuilt per snapshot | persistent map `byRawId` / `byRef`, allocated once per message |
| Active blocks list | not shown | listed in the nudge (`b1, b2, b5`) |
| Selection hints | none | stale/high-priority message ids listed in the nudge |
| Errors | single opaque token | descriptive validation errors |
| Nudges | persisted session entries | transient injection, stripped when stale |
| Tool description | ~40 words | ~700 words, sectioned |
| System prompt | ~90 words, one paragraph | sectioned, with explicit when/when-not criteria |

The architectural difference worth internalizing: **opencode has no authorization layer at all.**
Because the alias→message mapping is persistent and resolved against the live message list at
execution time, there is no window in which an alias can mean something different from what the model
saw. pi-dcp's entire baseline/snapshot/generation/provenance apparatus
(`src/identity/*`, `runtime.baselines`, `compressionProvenance`, `validateBaselineHistory`) exists to
solve a problem that a persistent id map does not have.

---

## Part 4 — Proposed fixes

### P0 — Make it work at all

**P0.1 — Delete the adapter allow-list.**
Remove `src/transform/adapters.ts` and its call sites (`pipeline.ts:53-54`, `pipeline.ts:87-89`).
Keep `validateProtocol()` (`src/transform/protocol-check.ts`) — that is the check that actually
matters, and it is provider-independent. If some form of gating is genuinely wanted later, invert it
to a **deny-list** so an unknown API defaults to working.

*Justification:* the current default is "unknown API → silently disable everything", which is the
worst possible default for an extension whose failure mode is invisible. With P1.1 (inline labels)
the soundness concern that motivated the allow-list disappears entirely.

**P0.2 — Make transform failure loud.**
When `transformOutgoingContext` returns a `reason`, emit it once per distinct reason via
`runtime.logger.diagnostic` **and** a user-visible toast, and deactivate the `compress` tool
(`setDcpToolActive(pi, false)`). A tool the model cannot possibly use should not be advertised to it,
and a dead extension should say so.

**P0.3 — Relax the 1:1 projection requirement.**
`pipeline.ts:61` should tolerate extra incoming messages that pi-dcp did not originate. The join
already computes `incomingByExpected`; the strict length equality adds nothing except brittleness in
the presence of other extensions. Pass through unmatched messages in place rather than aborting.

### P1 — Make range selection cheap for the model

**P1.1 — Move labels inline (the central change).**
Replace the standalone label message in `src/transform/blocks.ts` with content-level injection,
following opencode:

- **user** messages → append `\n<dcp-unit>m0007</dcp-unit>` to the text part.
- **toolResult** messages → append the same tag to the result content, once per result, so a
  multi-call turn carries its id in every part the model reads.
- **assistant** messages → append to the last text part; if the message has no text part, fall back
  to a synthetic trailing text part.
- **protected / non-compressible** units → emit `<dcp-unit>BLOCKED</dcp-unit>` instead of an id, so
  ineligibility is visible before selection rather than after rejection.

Benefits: no extra messages on the wire, no role-adjacency hazards, no provider-specific merging
risk, label co-located with content, and roughly halves the transform's message-count overhead.

*Known risk to verify:* reasoning models (`openai-codex-responses`, Anthropic extended thinking)
carry signed thinking blocks. Appending to a **text** part must not invalidate a **thinking**
signature — mutating `thinking` content or reordering parts would. Restrict injection to text/result
parts only, and add a fixture test per API that asserts signature-bearing parts are byte-identical
after transform.

**P1.2 — Make every failure actionable.**
Rewrite `failure()` in `src/compression/tool.ts:279` to return a short diagnosis plus the information
needed to retry. Concretely:

```
pi-dcp: range_invalid — "m0227" is not a current unit label.
Valid boundaries right now: m0001-m0184 (m0179-m0184 are protected and cannot be included).
Active summary blocks: b0001 (Phase 5 design), b0002 (test harness).
Re-issue compress with labels from this list.
```

Every rejection reason (`range_invalid`, `range_overlap`, `block_partial`, `content_protected`,
`placeholder_invalid`, `summary_invalid`) should name the offending range index and the offending
id. This single change converts a dead end into a retry loop.

**P1.3 — Put the live inventory in the nudge.**
Extend `stableNudgeText` to append, like opencode's `buildCompressedBlockGuidance`:

- the current compressible label span (`m0001-m0184`),
- the active block aliases (`b0001, b0002`) with topics,
- an explicit reminder that a range containing a block must reference it as `(bNNNN)` exactly once.

Caveat: this content changes every turn, which conflicts with the current "stable nudge text so the
cache prefix does not move" design decision. Since nudges are appended at the **end** of the context,
a changing nudge only invalidates the suffix, not the prefix — but this should be measured before
shipping. If it proves costly, put the inventory in the **tool description** refresh path or in the
error responses only (P1.2 already covers the recovery case).

**P1.4 — Make nudges transient, not persisted.**
Stop returning nudges from `before_agent_start` as persisted `custom_message` entries. Inject them in
the `context` hook instead, and drop them from the array once a `compress` call appears in the last
assistant message (opencode clears its anchors on exactly this signal). This removes permanent
history pollution and lets the nudge text carry live data (P1.3) without accumulating stale copies.

**P1.5 — Expand the prompts.**
Port the structure of `lib/prompts/system.ts` and `lib/prompts/compress-range.ts`:
*philosophy → COMPRESS WHEN (bulleted) → DO NOT COMPRESS IF (bulleted) → self-check question* for the
system prompt; *summary quality → user-intent fidelity → block placeholders with preflight check →
boundary-id rules → batching* for the tool description. Keep pi-dcp's own vocabulary (protocol units,
`mNNNN`/`bNNNN`) — only the structure and coverage need to be borrowed.

### P2 — Simplify the authorization layer

This is the largest and most invasive change, and I recommend doing P0 and P1 first and measuring
before touching it.

**P2.1 — Replace positional aliases with a persistent id map.**
Today aliases are derived from unit position within a freshly-built snapshot
(`src/identity/snapshot.ts:41-47`). Adopt opencode's model: allocate `mNNNN` **once per entry id**,
store the mapping in reduced state, and never reassign. An id then means the same thing for the whole
session regardless of what has been compressed, pruned, or re-projected.

**P2.2 — Once ids are persistent, retire the baseline snapshot machinery.**
`runtime.baselines`, `compressionProvenance`, `bindCompressionProvenance`, `baselineIdentityMatches`,
`validateBaselineHistory`, `computeSnapshotHash`, and the `generation` counter all exist to prove
"the alias the model used meant the same thing when it used it as it does now". With a persistent
map that invariant holds by construction. Resolution becomes: look up each id in the map, verify the
target entries still exist on the current branch and are still compressible, done.

This deletes roughly `src/identity/snapshot.ts` + most of `src/runtime.ts` + ~150 lines of
`src/compression/tool.ts`, and eliminates the *entire class* of `baseline_unavailable` failures — of
which this session's failure was one instance and, given six distinct `stage` values in the code,
almost certainly not the last.

*Counter-argument to weigh:* the snapshot design does buy one real property — it detects that history
was edited/forked between the model reading context and the tool executing. But pi already fires
`session_before_fork` / `session_before_tree` / `session_before_switch`, which pi-dcp already handles
by setting `mutationBlocked`. That is a simpler and more direct mechanism for the same guarantee.

---

## Part 5 — What is worth keeping

Not everything here needs rework. These are genuinely good and should survive the refactor:

- **Protocol-unit grouping** (`src/identity/protocol.ts`). Treating an assistant tool-call message
  plus all its results as one indivisible unit is more correct than opencode's per-message model and
  makes it structurally impossible to orphan a tool result. Keep it, and keep exposing one id per
  unit.
- **`validateProtocol`** (`src/transform/protocol-check.ts`). Provider-independent, cheap, and the
  check that actually protects against malformed output.
- **Nested block expansion with `(bNNNN)` placeholders** (`src/compression/nesting.ts`). The
  exactly-once accounting and cycle detection are more rigorous than the reference.
- **Event-sourced state with idempotent replay** (`src/state/reducer.ts`, `reconstruct.ts`).
  Compression operations as append-only envelopes replayed from the branch is the right architecture
  and makes fork/rewind behave correctly.
- **Path-based tool protection** (`src/compression/protected.ts`). Protecting by resolved file path
  and glob, not just tool name, is a real improvement.

---

## Recommended sequencing

1. **P0.1** — delete the allow-list. One-line-ish change; unblocks the user immediately. Verify with
   a real `openai-codex-responses` session that `pi-dcp.v2.unit` markers appear.
2. **P0.2 / P0.3** — loud failures and projection tolerance. Prevents the next silent death.
3. **P1.2** — actionable errors. Highest usability-per-line-of-code ratio in this document.
4. **P1.1** — inline labels. The structural fix; needs the signature-preservation fixtures.
5. **P1.3 / P1.4 / P1.5** — inventory in nudges, transient nudges, expanded prompts.
6. **P2** — persistent id map and retirement of the baseline layer, only after 1-5 are shipped and
   the real-world failure rate is known.

---

## Appendix — Verification commands

Confirm the API mismatch on any session:

```bash
python3 - "$SESSION" <<'EOF'
import sys,json,collections
c=collections.Counter()
for l in open(sys.argv[1]):
    try: o=json.loads(l)
    except: continue
    m=o.get('message',{})
    if o.get('type')=='message' and m.get('role')=='assistant':
        c[(m.get('provider'),m.get('model'),m.get('api'))]+=1
print(c)
EOF
```

Confirm the transform never ran:

```bash
grep -c "pi-dcp.v2.unit" "$SESSION"    # expect >0 when healthy; was 0 here
```

Confirm the allow-list contents:

```bash
sed -n '17,23p' src/transform/adapters.ts
```
