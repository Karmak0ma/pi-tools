# Combined Pi 0.86–0.87 roadmap for pi-dcp

**Date:** 2026-09-21
**Current host:** Pi `0.87.0`
**Current lockfile:** Pi packages pinned to `0.87.0`
**Peer version:** exact `0.87.0`; the lockfile is the certification artifact
**Support policy:** internal current-host certification only; no previous-version matrix

This document combines the opportunities and compatibility decisions from:

- `PI_0_86_ADOPTION_PLAN.md` — structured prompt state, public projection, cache warming, native-compaction hooks, and optional extension-owned model calls;
- `PI_0_87_ANALYSIS.md` — context edits, system-free context handlers, actionable lifecycle boundaries, cache warming, and changes that should remain outside DCP.

The roadmap is deliberately separate from the frozen product contract in `IMPLEMENTATION_PLAN.md`. A roadmap item is not authorization to change DCP behavior. Each item below has its own invariants and validation gate.

## Current status

The following work is complete:

1. **Pi 0.86 structured system guidance.** DCP writes deterministic configuration-derived guidance to the owned `systemPromptOptions.sections` key `pi_dcp_context_compression`. Live nudges remain request-local context. DCP never returns a complete replacement `systemPrompt`.
2. **Pi 0.87 canonical projection compatibility.** DCP requires `SessionManager.buildSessionProjection()` and uses a strict wrapper that preserves `sourceEntry.id`, projection ordinals, provider-dropped assistant identities, and fail-closed validation. Pi-applied `context_edit` entries are understood as host state, not as DCP messages. Older hosts are unsupported and fail closed.
3. **Pi 0.87 system-free context compatibility.** DCP keeps the complete projection for protocol units, system barriers, block coverage, snapshots, and authorization. The `context` join uses only the provider-visible, non-system projection and maps the result back to the complete index. DCP does not manufacture hidden system messages. Any system messages supplied by the host remain untouched extras.
4. **Pi 0.87 development validation.** The package and lockfile use Pi `0.87.0`. The full deterministic suite passes against that host version, including direct tests for context-edit omission/replacement and system-free/system-present context input.

The following is **not** complete:

- cache-warming coordination has not been implemented;
- the new lifecycle boundary events have not been adopted for DCP writes;
- native-compaction behavior remains outside the frozen product contract;
- the next Pi update process has not yet been exercised against a newer host.

## Prioritized improvement list

| Priority | Improvement | Source | Status | Decision |
|---:|---|---|---|---|
| 1 | Conservative `cache_warming_decision` coordination | 0.86, retained in 0.87 | Future | Adopt after compatibility repair. Stop warming only when DCP has positive evidence that its next transformed prefix cannot reuse the previous provider cache. |
| 2 | `turn_end` and `agent_before_settle` lifecycle review | 0.87 | Future | Measure first. Use the new boundaries to improve observation and operation ordering only if tests prove the timing is safer than the current `agent_settled` path. |
| 3 | Current-host projection hardening | 0.86 + 0.87 | Partially implemented | Add more Pi 0.87 differential fixtures and malformed-output checks. Do not create a previous-version matrix or reintroduce an older-host fallback. |
| 4 | Optional extension-owned model calls via `streamSimple()` | 0.86 | Future / optional | Use only for bounded auxiliary work. Do not replace the current model-authored `compress` workflow or silently invoke a second model. |
| 5 | Rich native-compaction hooks | 0.86 + 0.87 | Prototype only | Requires measurement and an explicit product decision because it conflicts with the frozen native-compaction contract. |
| — | Pi `ContextEditEntry` as DCP compression | 0.87 | Rejected | Use Pi edits as host projection input only. They are durable single-entry edits, not reversible range operations. |
| — | `context_with_system` as the default request hook | 0.87 | Rejected for now | The system-agnostic join avoids a second transform path. Reconsider only if differential tests prove it necessary. |
| — | Pi image-resize policy duplication | 0.87 | Rejected | Pi owns model-specific image normalization. DCP should validate and estimate the resulting messages, not rewrite image bytes. |

## 0. Current-host certification and update process

The internal extension certifies and requires the exact Pi `0.87.0` lockfile host. It is not a promise to support older Pi releases or an untested future version.

When Pi updates:

1. update all four Pi development and peer dependency pins together;
2. run `rm -rf node_modules && npm ci` in `pi-dcp`;
3. run `npm run check`, the projection/lifecycle fixtures, and the Ripwire quality and contract checks;
4. review the new Pi changelog and declarations for context, projection, and lifecycle changes;
5. update this roadmap and the compatibility statement to the new exact lockfile version.

No previous-version compatibility matrix is maintained. A host without the current required projection API fails closed at startup through `checkContextCapabilities`; it does not select a divergent local projection path.

## 1. Conservative cache-warming coordination

### Opportunity

Pi 0.86 introduced provider cache warming and Pi 0.87 retains the `cache_warming_decision` event. Pi owns cache lifetime, provider pricing, and continuation probability. DCP knows when its outgoing prefix changed for reasons that may not be visible in the persisted session tree.

DCP can identify likely stale-prefix cases such as:

- a new active compression block;
- decompression or recompression;
- persisted tool-output redaction;
- a generation invalidation;
- a pending transient nudge;
- projection fallback or mutation blocking;
- a system-section configuration change.

### Proposed behavior

- If Pi chooses `stop`, never force it back to `warm`.
- Change `warm` to `stop` only with positive evidence that the next DCP-transformed prefix cannot reuse the previous transformed prefix.
- Keep the decision metadata-only. Do not log prompts, summaries, paths, arguments, or credentials.
- Treat a pending transient nudge as a request-tail change, not automatically as a reason to discard the stable prefix; measure the provider-specific cache boundary before deciding.
- Invalidate the DCP cache-warming decision when the branch, model, system section, or DCP generation changes.

### Validation gate

Add deterministic tests for every stale-prefix reason, the no-op case, and the rule that Pi's `stop` decision is never overridden. Add provider payload/cache-breakpoint fixtures and an opt-in live check only outside `npm run check`.

## 2. `turn_end` and `agent_before_settle`

### What Pi 0.87 adds

`turn_end` now exposes the assistant message entry ID, tool-result entry IDs, outcome, proposed structural entries, and a rebuilt context preview. `agent_before_settle` runs after retries, automatic compaction, and recovery work and can propose ordered structural drafts plus one continuation. `agent_settled` is now a final/notification-oriented boundary.

### Possible DCP benefits

- Count user-turn and assistant/tool boundaries from canonical persisted IDs instead of only observing `turn_start`.
- Evaluate nudge eligibility against the repaired post-retry projection.
- Observe proposed entries from other extensions before deriving DCP state.
- Prepare DCP operation drafts in the same boundary ordering as other structural entries.
- Reduce branch re-reads and race assumptions around retries and compaction.
- Confirm the host has persisted the assistant tool-call entry before provenance binding.

### Constraints

Do not move writes from `agent_settled` merely because the new events exist. DCP must preserve:

- append-only operation envelopes;
- exactly-once reducer application;
- request-local, non-persisted nudge delivery;
- no automatic continuation solely to deliver a nudge;
- notification flushing at a safe post-turn point;
- fail-closed behavior if the boundary preview is incomplete or malformed.

### Validation gate

Build boundary harnesses for successful turns, tool loops, errors, retries, overflow compaction, native compaction, queued follow-ups, and extension-proposed context edits. Compare the current and candidate operation order. Do not adopt a new write boundary until the comparison proves no duplicate, lost, or reordered DCP operation.

## 3. Current-host projection hardening

The immediate adapter is intentionally narrow. Future work should make its compatibility contract explicit and release-testable.

### Required hardening

- Differentially compare DCP's wrapper with the installed Pi 0.87.0 public projection helper.
- Compare source entry IDs, projection ordinals, message fingerprints, system checkpoints, and context-edit target identity.
- Test latest-edit-wins behavior, branch navigation, edits targeting omitted or compacted entries, and malformed host output.
- Test provider-dropped assistant entries separately from host-applied context omissions. A source ID omitted by Pi's provider projection remains known to DCP for block availability and anchors.
- Test repeated equal messages with system messages interleaved and with injected non-system extras.
- Keep the mapping from provider-visible indexes to complete canonical indexes in one named helper. Do not reproduce index arithmetic at call sites.
- Keep `context_with_system` out of the default path unless the differential suite proves the provider-visible join cannot preserve identity.

### Possible simplification later

The local legacy projector was removed when the current-host policy was selected. Keep future projection changes behind Pi's current public helper; do not restore an older-host compatibility path.

## 4. Optional extension-owned model calls

Pi 0.86 exposes public extension model-call plumbing through `ctx.modelRegistry.streamSimple()` and related APIs. This can support bounded DCP-owned auxiliary tasks, for example:

- estimating whether a proposed compression summary preserves required facts;
- checking a summary against a structured fidelity judgment;
- generating a non-authoritative recovery hint when the primary model cannot complete a request.

This is optional and must not replace the current model-authored `compress` tool because the current workflow provides explicit range selection, operation provenance, reversibility, and user/model control.

Any adoption must define:

- the model and provider selection policy;
- credential and privacy boundaries;
- timeout, cancellation, and retry behavior;
- whether the call is allowed in headless mode;
- token/cost accounting and user-visible notification;
- a fail-closed result when the auxiliary call is unavailable;
- tests proving no summary or credential leaks into logs or persistent metadata.

Do not add a second model call until a concrete product need earns its complexity.

## 5. Rich native-compaction hooks

Pi 0.86 added richer native-compaction hooks and Pi 0.87 adds a more actionable pre-settle boundary. These could allow DCP to influence native compaction timing or provide custom compaction data, but this conflicts with the frozen DCP contract:

- native Pi compaction remains Pi-owned;
- DCP does not cancel native compaction;
- DCP operations remain append-only and reversible while source entries remain active;
- a native compaction summary is not interchangeable with a DCP range block.

### Required product decision before implementation

Decide whether DCP should ever:

1. delay or cancel a native compaction;
2. contribute a native compaction summary;
3. create a DCP operation before native compaction;
4. coordinate DCP block availability across the resulting checkpoint.

Until that decision is explicit, prototype only in a disposable harness. Measure context size, provider cost, recovery behavior, and rollback semantics. Do not change production native-compaction behavior.

## Explicit non-goals and rejected ideas

### Do not use Pi context edits as DCP compression

A `ContextEditEntry` targets one source entry and changes durable model context. DCP needs complete protocol-unit ranges, nested block placeholders, model-authored summaries, append-only operation history, decompression, and recompression. Pi edits are an input that DCP must project correctly, not a replacement for the DCP domain model.

### Do not make `context_with_system` the general DCP transform hook

Pi 0.87's full-transcript hook makes an extension responsible for retaining the leading system message and active tool declarations. It creates a second transformation path and can duplicate or reorder DCP behavior. The current system-agnostic join is simpler and preserves host ownership.

### Do not persist nudges as system patches or ordinary messages

Nudges depend on live usage, turn boundaries, pending state, and recent compression. They remain one-request context-tail messages. Stable DCP rules belong in the named system section; live nudges do not.

### Do not record estimated DCP savings as Pi usage

Pi usage entries represent model-attributed work. DCP savings are estimates. Keep DCP statistics in the append-only DCP ledger.

### Do not duplicate Pi image resizing

Pi 0.87 owns cache-safe model-specific image preprocessing. DCP should preserve, estimate, and protect the resulting messages but should not reproduce provider-specific resizing logic.

### No action for removed `shouldStopAfterTurn`

DCP does not use this inherited agent option. No compatibility shim is needed.

## Combined release gates

Before calling the combined 0.86–0.87 work release-ready:

1. The exact current Pi lockfile host passes without rewriting the repository lockfile.
2. Pi 0.87 context-edit and system-free-context fixtures pass through the complete DCP transform.
3. The current host's required projection capability is checked at startup and missing APIs fail closed.
4. Stable structured system guidance remains deterministic; transient nudges remain request-local.
5. System messages remain non-compressible and are never manufactured into system-free provider input.
6. Context edits cannot silently authorize a stale compression snapshot after omission or replacement.
7. Cache-warming decisions never override a host `stop` decision.
8. Lifecycle-boundary experiments prove operation ordering before any production write moves.
9. Native-compaction behavior remains unchanged unless the separate product decision is recorded.
10. Full deterministic tests, compatibility fixtures, `git diff --check`, Ripwire quality delta, and lifecycle contract checks pass.

## Related documents

- `PI_0_86_ADOPTION_PLAN.md` — detailed Pi 0.86 investigation and phase rationale.
- `PI_0_87_ANALYSIS.md` — Pi 0.87 primary-source analysis and compatibility findings.
- `IMPLEMENTATION_PLAN.md` — frozen DCP behavior contract and current compatibility wording.
- `README.md` — user-facing installation and compatibility statement.
