# DESIGN.md Review — Pi Dynamic Context Pruning (pi-dcp)

Review of `/home/vflores/repos/pi-tools/pi-dcp/DESIGN.md` (1,247 lines, 27 sections).

## Review metadata

- **Date:** 2026-08-13
- **Method:** full read of DESIGN.md; independent verification of every checkable factual claim against the installed Pi artifacts (`docs/*.md` and `dist/` type definitions + implementation) and the installed OpenCode DCP 3.1.9 package, via three parallel explore agents.
- **Scope:** per requester instruction, **licensing/provenance matters are excluded** — §27.4, open decision 1, acceptance criterion 18, and risk-matrix item 20 are noted but not assessed.
- **Status:** review of a proposed design; no production code exists ("Status: proposed implementation design" in the document).

## Executive summary

DESIGN.md is an exceptionally thorough, mature implementation design. It is structurally complete, internally consistent, and factually reliable: independent verification confirmed essentially every checkable claim about both the Pi extension API and the DCP 3.1.9 reference package.

It is not yet "done" in the strict sense. Three concrete corrections/nuances should be folded in (all mechanical, none architectural), and 11 open decisions (excluding license) plus deliberately deferred features (message mode, subagent bridge, checkpoints, aggregate stats, prompt overrides) mean it is best read as a **complete plan with an outstanding-decisions list**, not a frozen spec of the finished product.

**Verdict: approve as the implementation plan once the corrections are applied (low effort) and the pre-Phase-2 open decisions are resolved (medium effort).** None of the findings invalidate the architecture.

## Verified facts

### Pi extension API — all 12 claims CONFIRMED

| # | Claim | Evidence |
|---|---|---|
| 1 | `context` event receives a deep copy of `AgentMessage[]`; extension may return replacement messages | `docs/extensions.md:650-658` ("deep copy, safe to modify"); `dist/core/extensions/types.d.ts:499-503`, `774-776` |
| 2 | `pi.appendEntry()` returns `void`; no durability ack, transaction, or batch API | `types.d.ts:936` (`appendEntry<T = unknown>(customType: string, data?: T): void`); no batch/transaction method in `types.d.ts:901-950` |
| 3 | `sendMessage()` vs `sendUserMessage()`; `deliverAs: "followUp"` for streaming | `docs/extensions.md:1389-1415`, `1421-1428`; `types.d.ts:924-934` |
| 4 | Dynamic `registerTool()` / `setActiveTools()` / `getAllTools()` without reload | `docs/extensions.md:1338-1343`, `1648-1650`; `types.d.ts:901`, `948-950` |
| 5 | Custom entries (`type:"custom"` + `customType`) are context-invisible; `custom_message` entries are visible | `docs/session-format.md:170-191`; `docs/extensions.md:1389-1392`, `1587-1604` |
| 6 | All 13 lifecycle events in §7.2 exist with the described payloads | `types.d.ts:415-471` (session start/switch/fork/compact/shutdown), `484-496` (tree), `524-560` (agent/turn/settled), `602-608` (model_select), `648-656` (tool_call) |
| 7 | Custom tools support `executionMode: "sequential"`; parallel by default | `types.d.ts:341-369`; `docs/extensions.md:1892` |
| 8 | `ctx.hasUI` and `ctx.ui.confirm()` | `types.d.ts:209-214`, `64-67`; `docs/extensions.md:943-950` |
| 9 | `ctx.isProjectTrusted()` and exported `CONFIG_DIR_NAME` | `types.d.ts:234`; `dist/index.d.ts:2`; `docs/extensions.md:967-973` |
| 10 | `ctx.reload()` = shutdown → reload → `session_start(reason:"reload")`; old frame continues | `types.d.ts:290`; `docs/extensions.md:1276-1298` |
| 11 | `ctx.getContextUsage()` | `types.d.ts:244`; `docs/extensions.md:1039-1044` |
| 12 | Sequential custom-tool requests supported; parallel default | same as #7 |

Nuance on #6: these are not the only extension events (there are also `agent_start`/`agent_end`, tool execution/result events, input, and provider events). The design only needs the ones it lists, so this is informational, not a defect.

### Pi session structure and compaction — CONFIRMED with two nuances

1. `ReadonlySessionManager` exposes `getLeafId()`, `getBranch()`, `buildContextEntries()`, `getEntries()`; `getEntries()` includes abandoned branches, `getBranch()` walks only selected leaf → root (`session-manager.d.ts:140,239-281`; `session-manager.js:939-979`). Returned arrays are shallow copies.
2. Stable string IDs over an append-only JSONL tree; ordinary `custom` entries share the branch and project to zero model messages (`session-format.md:3,179-183,267-271`).
3. Projection rules: `message` → 1, `custom_message` → 1, nonempty `branch_summary` → 1, `compaction` → 1, `custom`/model-change/label/other → 0 (`session-manager.js:162-236`). **Nuance: the current compiled implementation projects a compaction to one summary message and does NOT emit a separate `retainedTail` message**, contrary to what the compaction docs describe.
4. Compaction reasons exactly `manual|threshold|overflow`; `willRetry` on overflow; `Preparation` carries `messagesToSummarize`, `turnPrefixMessages`, `firstKeptEntryId` (the "retained boundary"); `reserveTokens` defaults to 16384 (`docs/compaction.md:275-294,387-400`; `agent-session.js:1363-1620`; `dist/core/compaction/compaction.js:505-560`).
5. Threshold is computed from persisted `agent.state.messages`, preferring assistant usage-derived tokens (`agent-session.js:1562-1588`; `compaction.js:160-164`).
6. An outgoing `context` replacement does not rewrite that persisted state — so DCP pruning alone cannot reliably prevent native threshold compaction. **The design's §16.1 caution is correct** (`agent-session.js:1562-1588`).
7. `/tree` stays in the same file and may append a branch summary; clone-style branching copies only the active root-to-leaf path (`session-manager.js:1072-1148,1234-1288`). **Nuance: static `SessionManager.forkFrom()` copies ALL non-header entries, including abandoned branches** — fork behavior is operation-dependent.
8. In-memory sessions create no disk state and lose everything at shutdown (`session-manager.js:1218-1221`); the "ephemeral" labeling is correct.

### DCP 3.1.9 — all claims CONFIRMED

- `package.json`: version `3.1.9`, license `AGPL-3.0-or-later`, dependencies `@opencode-ai/sdk`, `@anthropic-ai/tokenizer`, `jsonc-parser`, `zod`; published files `dist/`, `README.md`, `LICENSE`.
- Inventory: exactly **64** `dist/*.js` files, **6,981** lines total (`find ... -name '*.js' | wc -l` + `wc -l`).
- Defaults table, always-protected tools (`task, skill, todowrite, todoread, compress, batch, plan_enter, plan_exit, write, edit`) vs compression-summary defaults (`task, skill, todowrite, todoread`), and the six prompts — confirmed at `README.md:50-148,177-194,205-210`.
- Every `dist/` file cited in §27.1 exists and contains the described logic (spot-checked `hooks.js`, `message-ids.js`, `compress/state.js`, `compress/protected-content.js`, `messages/prune.js`, `strategies/deduplication.js`/`purge-errors.js`, `commands/decompress|recompress|sweep|context.js`).
- The architectural note that OpenCode plugin hooks mutate `{info, parts}`-shaped records (including `output.parts`) is accurate.

## Corrections to fold into DESIGN.md

These are the only findings that change the document's text. Two are factual nuances, one is wording.

1. **Fork semantics are operation-dependent (§7.2, §24, acceptance criterion 4).** `SessionManager.forkFrom()` (the static fork API) copies **all non-header source entries, including abandoned branches**, while `/tree` and clone-style branching copy only the active root-to-leaf path. The claim "Fork starts from entries actually copied by Pi" is true but needs scoping, and a forked file may contain branches on which pi-dcp operations were never copied. Replay from `getBranch()` is still correct (leaf→root is authoritative), so acceptance criterion 4's "never leaks an abandoned branch" remains achievable — but the doc should state this explicitly and the integration matrix should add a `forkFrom(...)`-then-replay scenario.
2. **Projection adapter must record the retained-tail implementation gap (§8.2, §16).** The compiled `buildContextEntries()` does not project a `retainedTail` message; entries from `firstKeptEntryId` onward are included directly after the compaction summary. §16's cancellation check naming `includesRetainedTailAndTurnPrefix` must be defined against `firstKeptEntryId` retention inside `buildContextEntries()`, not against a projected retained-tail message. §8.2's isolated, version-tested adapter is the right home for this; add an explicit assertion and a golden fixture for a compacted context.
3. **§3.1 wording.** "Compiled-only … not TypeScript source" is accurate but a literal `find *.ts` finds 64 generated `.d.ts` declarations (which are declarations over compiled JS, not authoring sources). Suggest: "no authoring TypeScript sources (`*.ts`); generated declarations (`*.d.ts`) are present."

## Section-by-section assessment

Legend: **✔** strong / **◐** minor revision / **○** resolves to an open decision or out of scope.

| § | Section | Verdict | Notes |
|---|---|---|---|
| 1 | Conventions | ✔ | Observed-vs-proposed and normative-word discipline are exactly right for an implementer who has never used DCP. Vocabulary (persisted vs outgoing context, block, snapshot) is precise and used consistently. |
| 2 | Problem, vocabulary, non-goals | ✔ | "A lens, not a history editor" is the correct mental model. The DCP-vs-Pi-compaction table is accurate; non-goals are honest, especially the threshold and native-compaction caveats. |
| 3 | Observed reference behavior | ◐ | Accurate, including the effective-union warning about protection lists. Needs Correction 3 (wording). |
| 4 | Architecture comparison | ✔ | The row-by-row OpenCode/Pi mapping is the strongest part of the document; it correctly refuses to translate record mutations literally and names identity projection as the central problem. |
| 5 | Normative requirements | ✔ | 16 precise requirements. R1 (history safety), R5 (heuristic boundary + fail closed), R6 (no half tool exchange), R9 (snapshot validation), R14 (best-effort durability honesty) are load-bearing and correctly stated. R3 should absorb Correction 1's nuance. |
| 6 | Package layout | ✔ | Clean 1:1 mapping to sections; peers at `*` with runtime capability checks (§24) is the right stance for Pi's fast-moving API; `jsonc-parser` as the only runtime dependency is minimal and defensible. |
| 7 | Runtime architecture | ✔ | Lifecycle table verified event-by-event against `types.d.ts`. "Register once, adjust active set" matches Pi's dynamic registration; the reload-continues-old-frame note and the "never rely solely on `agent_end`" rule are subtle and correct. |
| 8 | Canonical identity and snapshots | ◐ | The heart of the design, and it is sound: deterministic projection + tiered join (tool-ID evidence / fingerprint+occurrence / monotonic position) with fail-closed on ambiguity is the right answer to ID-less `ContextEvent.messages`. Ephemeral-never-persisted aliases are enforced consistently. Add Correction 2 (retained-tail nuance). |
| 9 | Canonical state and reducer | ✔ | Custom entries as the canonical journal are the only defensible storage given `appendEntry(): void`. The crash-consistency discussion is exemplary — it explicitly refuses to claim exactly-once/atomic durability, encodes one mutation per self-contained envelope, and uses `opId`/request keys for idempotency. Checkpoints-after-equivalence-tests is appropriately conservative. |
| 10 | Context pipeline and protocol invariants | ✔ | The 12-step pipeline is concrete with a no-op fallback. The ephemeral `CustomMessage` summary (returned only from `context`, never persisted) is a neat solution verified against Pi's custom-message semantics. Tool-protocol rules are provider-neutral and correct. |
| 11 | Compression algorithm | ✔ | Exhaustive validation order; contiguity/overlap rejection after protocol expansion is the right check; nested `(bN)` placeholder contracts replicate DCP semantics with explicit bounds and cycle rejection. Message mode correctly deferred. |
| 12 | Automatic pruning | ✔ | Signature definition and keep-newest policy are clear; protections compose correctly with the baseline unions. |
| 13 | Prompting and nudges | ✔ | `/dcp compress` via a real user message + single-use nonce is the correct mechanism for model-authored summaries without forging calls; `deliverAs: "followUp"` during streaming verified against the API. |
| 14 | Configuration and permissions | ✔ | Trust layering, layer-failure fallback (never partially apply malformed security settings), no Pi-settings mutation, `CONFIG_DIR_NAME`/`isProjectTrusted` usage — all verified and sound. Name-collision → disable is good defensive behavior. |
| 15 | Commands and UI | ✔ | Single `dcp` command with strict subcommand parsing avoids name squatting; `hasUI`-aware behavior for TUI/RPC/JSON/print matches the verified capability surface. |
| 16 | Native compaction interaction | ◐ | Host facts all verified, including the crucial one (outgoing context replacement does not reset threshold state). Never-cancel for manual/overflow and advisory threshold-only cancellation with fresh high-confidence estimate + safety margin + anti-loop is appropriately conservative. Absorb Correction 2's retained-tail definition. |
| 17 | Subagents | ✔ | "No universal relationship; independent by default; no heuristic lineage inference" is the only defensible MVP position; the future signed opt-in protocol is well bounded. |
| 18 | Tokens, stats, observability | ✔ | Confidence-tiered estimation with a verified reporting anchor (`getContextUsage`) is pragmatic; privacy rules (no raw content in logs/stats/caches) are strict and testable. |
| 19 | Threat model | ✔ | Comprehensive threats with controls mapped to concrete mechanisms. The honest caveat that no automatic proof of summary fidelity exists, with decompression and raw-retention as the recovery mechanisms, is the right framing. |
| 20 | Risk matrix | ✔ | 28 rows, each with a decision/mitigation; most tensions (identity, extension ordering, cache churn, crash timing) are real and addressed. Item 20 (license) excluded per scope. |
| 21 | Delivery phases | ✔ | Phase gating is sensible: no model compression before the fail-closed foundation; nested blocks and compaction interaction only in P3; message mode/subagents last. Concrete exit criteria. |
| 22 | Test matrix | ✔ | Exceptional depth: unit + property/fuzz + golden (provider-specific serialization) + integration + crash tests. The crash-test framing exactly matches the verified no-durability-ack reality — it asserts documented best-effort outcomes and does not assert exactly-once persistence. Add the `forkFrom` scenario from Correction 1. |
| 23 | Performance goals | ✔ | Measurable targets on a concrete fixture; "no synchronous I/O in the `context` path" and "don't hold the transform mutex across UI waiting" are important and correctly stated. |
| 24 | Migrations, rollback, compatibility | ✔ | Unknown-newer-schema handling (stop replay, fail open to raw context, instruct upgrade) is correct; startup capability checks are cheap insurance against Pi version drift under peer `*`. |
| 25 | Open decisions | ○ | See dedicated review below (license item excluded). |
| 26 | Acceptance criteria | ✔ | Concrete and map 1:1 to the test matrix. AC18 (license) excluded per scope; the other 17 remain assessable. |
| 27 | Source references | ◐ | Full file:line provenance is excellent for auditability; "moving checkout" caveats are honest. Needs Correction 3 (generated declarations clarification). |

## Open decisions (non-license)

The document lists 12; excluding the license route (item 1), the remaining 11 and reviewer notes:

- **2. Package scope/name; ship TS vs compiled —** cosmetic; resolve early, no design impact.
- **3. Minimum Pi version / peer `*` vs capability range —** substantially answered by §24's capability checks + tested-version matrix. Recommend pinning the matrix in Phase 0. This is the item where the review's verification is most useful: every §7.2/§14 API used exists in the installed types.
- **4. Sparse alias metadata vs cache cost —** genuine trade-off; §10.6's "place late and sparse; report changed-prefix position" is a good interim answer. Resolve with measurement in Phase 2, not more design.
- **5. Threshold cancellation default (opt-in vs default-on) —** the conservative recommendation (opt-in) is correct; resolution needs §16 metrics, not further design.
- **6. Tokenizer vs heuristic-only —** both paths are defined; decide in Phase 0/2 on measurement.
- **7. Aggregate cross-session stats —** MVP-off is clearly right; the privacy cost is real.
- **8. Multi-range batch schema —** §9.3's single-envelope design already covers multi-range calls in one operation; the open question is only the schema shape. Recommend resolving before Phase 2 to avoid a migration.
- **9. Question-tool identification —** genuinely hard; "recognized schemas only, unknown → skip" is the correct conservative default.
- **10. `protectUserMessages` includes images —** design says yes; keep it — it matches the preserve-verbatim intent and is easy to relax later.
- **11. Prompt overrides in first release —** off-by-default is right; defer.
- **12. Pi core feature request (entry IDs on `context` / projection API) —** worthwhile regardless of this design's outcome; it removes the single largest risk (identity).

None of these block Phase 0/1 work; the document already provides a recommended position for most of them.

## Recommendations

1. Apply the three corrections (fork nuance §7.2/§8 + forkFrom integration test; retained-tail projection note §8.2/§16 + golden fixture; §3.1 wording).
2. Resolve open decisions 2, 3, 8 before Phase 2 (batch schema in particular, to avoid a migration).
3. Decision pass on items 4–7, 10–12 before Phase 3.
4. File the Pi core feature request (open decision 12) now.
5. Proceed to Phase 0; the design supports starting work immediately after the above.

## Completeness verdict

- **As a factual design: complete and reliable.** After folding in the three corrections, no further fact-checking is needed before implementation starts.
- **As a spec of the final product: intentionally incomplete by design.** Message mode, subagent bridge, checkpoints, aggregate stats, and prompt overrides are phase-deferred; the open-decision list must be worked before each gating phase.
- The document is ready for a decision round, not more review volume — it did its job of surfacing the remaining choices explicitly.
