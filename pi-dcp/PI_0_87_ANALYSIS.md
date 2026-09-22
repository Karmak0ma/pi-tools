# Pi 0.87.0 adoption analysis for pi-dcp

**Date:** 2026-09-21
**Pi host inspected:** `@earendil-works/pi-coding-agent` 0.87.0
**pi-dcp development dependency:** 0.87.0
**Purpose:** Determine which Pi 0.87 changes pi-dcp should adopt, which changes require compatibility work, and which changes should remain outside the extension.

## Implementation status

The Pi 0.87 compatibility repair is implemented. DCP requires Pi's provenance-preserving `buildSessionProjection()`, validates its output, and joins Pi 0.87's system-free `context` input against a mapped provider-visible projection while preserving system messages as canonical non-compressible barriers. The complete suite passes against the 0.87.0 lockfile. This internal extension certifies the current Pi 0.87.x host family only; no previous-version matrix is maintained.

## Executive recommendation

The two urgent compatibility changes are implemented; the remaining recommendations below are future work. Pi 0.87 introduces two host-contract changes that intersect DCP's authorization boundary:

1. `context_edit` is now a public `SessionEntry` type and is used by Pi for branch-local model-context omissions and replacements.
2. `context` handlers now receive only non-system messages. Pi restores the prompt and tool state after those handlers. DCP's current transform joins the incoming event against a local projection that still contains system messages.

These are more urgent than optional feature adoption. The recommended order is:

| Priority | Work | Recommendation | Why |
|---:|---|---|---|
| 0 | Pi 0.87 compatibility gate | **Implemented** | The host projector accepts host-applied `context_edit` results, and the join handles Pi's system-free `context` input without weakening DCP's canonical identity model. |
| 1 | Canonical host projection | **Implemented for current host** | Pi's provenance-preserving `buildSessionProjection()` is required and sits behind a DCP-owned validator; older host APIs are unsupported and fail closed. |
| 2 | System-agnostic context join | **Implemented** | DCP retains complete system barriers for indexing but joins only provider-visible messages and maps the result back to the full projection. |
| 3 | `context_with_system` | **Fallback only, after proof** | Use the full-transcript hook only if tests show that a system-agnostic join cannot preserve deterministic identity. It gives DCP ownership of prompt/tool declarations and creates a second lifecycle path. |
| 4 | `agent_before_settle` / `turn_end` | **Investigate after projection migration** | These can make DCP's operation persistence and turn accounting more deterministic, but moving writes changes lifecycle semantics and needs boundary tests. |
| 5 | `cache_warming_decision` | **Keep as the next optimization** | DCP can identify stale transformed prefixes, while Pi owns provider cache economics. The existing Phase 3 plan remains sound. |
| — | `ContextEditEntry` as DCP's normal compression mechanism | **Do not adopt now** | It edits one source contribution at a time and changes durable model context. It does not replace DCP's range-based, reversible, operation-backed outgoing lens. |
| — | Per-model image resize limits | **No direct DCP work** | Pi normalizes image inputs at the host/provider boundary. DCP should not duplicate that policy. |

## Primary sources

All Pi claims below come from the installed Pi 0.87.0 package, not a secondary summary:

- `.../@earendil-works/pi-coding-agent/CHANGELOG.md`, section `[0.87.0]`, lines 3–39.
- `.../@earendil-works/pi-coding-agent/docs/extensions.md`, sections `agent_before_settle`, `turn_end`, `context`, `context_with_system`, and `cache_warming_decision`.
- `.../@earendil-works/pi-coding-agent/docs/session-format.md`, sections `ContextEditEntry` and `Context Building`.
- `.../@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts`, declarations for `ContextEditEntry`, `ProjectedSessionEntry`, `SessionProjection`, `buildSessionProjection()`, and `appendContextEdit()`.
- `.../@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`, declarations for `ContextWithSystemEvent`, `AgentBeforeSettleEvent`, `TurnEndEvent`, and the corresponding `ExtensionAPI.on()` overloads.
- `.../@earendil-works/pi-coding-agent/dist/core/extensions/runner.js`, `emitContext()` implementation.
- `.../@earendil-works/pi-coding-agent/dist/core/agent-session.js`, canonical provider projection and actionable boundary dispatch.

The installed paths above resolve under:

`/home/vflores/.local/share/fnm/node-versions/v24.15.0/installation/lib/node_modules/@earendil-works/pi-coding-agent/`

The relevant pi-dcp sources are:

- `src/identity/project.ts`
- `src/identity/join.ts`
- `src/transform/pipeline.ts`
- `src/lifecycle.ts`
- `src/capabilities.ts`
- `PI_0_86_ADOPTION_PLAN.md`
- `DESIGN.md`

## 1. Immediate compatibility issue: `context_edit`

### What Pi 0.87 changed

Pi added `ContextEditEntry` to the exported `SessionEntry` union. Its shape is:

```ts
interface ContextEditEntry extends SessionEntryBase {
  type: "context_edit";
  targetId: string;
  replacement: { content: ContextEditableContent } | null;
}
```

`replacement: null` omits one earlier model-context contribution. A non-null replacement changes only that contribution's content. The raw target entry, metadata, UI history, exports, and accounting remain unchanged. Edits are branch-relative, and the latest edit for a target on the active branch wins.

Pi also exposes:

```ts
buildSessionProjection(): SessionProjection
SessionProjection.entries: ProjectedSessionEntry[]
ProjectedSessionEntry.sourceEntry: SessionEntry
ProjectedSessionEntry.messages: AgentMessage[]
```

The canonical projection applies context edits and retains direct source-entry provenance.

**Sources:** Pi 0.87.0 `CHANGELOG.md` (`ContextEditEntry`, append-only model-context edits); `docs/session-format.md` (`ContextEditEntry`, `Context Building`); `dist/core/session-manager.d.ts` (`ContextEditEntry`, `ProjectedSessionEntry`, `SessionProjection`, `buildSessionProjection`).

### Why current DCP fails

`pi-dcp/src/identity/project.ts` has a deliberately fail-closed validator for Pi's projected source entries and messages. Unknown or malformed host output returns `{ ok: false, reason: "projection_unsupported" }`.

`context_edit` is not in that switch. DCP therefore disables its transform whenever the active branch contains a Pi 0.87 context edit. Pi can create such edits during selected error/retry and final-recovery paths, not only when an extension explicitly requests one. The 0.87 changelog explicitly lists recovery omissions being persisted as context edits.

The rest of DCP's call chain propagates this failure:

- `src/transform/pipeline.ts:transformOutgoingContext()` calls `sessionManager.buildSessionProjection()` through DCP's validated host adapter.
- A failed projection returns the untouched context and no baseline.
- `src/lifecycle.ts:transformContext()` records the fallback reason and leaves compression unavailable for that request.
- Compression authorization later validates the same projection and rejects a call that depends on it.

This is a correct fail-closed response: DCP sends the request uncompressed rather than authorizing a transform against an unknown transcript. It is therefore a safe degradation, not a hard turn failure, but it means the current extension is not functionally compatible with a 0.87 session that contains context edits.

### Reproduction performed

Using Pi 0.87.0's public `buildSessionProjection()` and the current DCP adapter with a user message, assistant message, and an omission edit targeting the assistant:

```json
{
  "hostContextRoles": ["user"],
  "localProjection": "projection_unsupported"
}
```

The host correctly applies the edit. The DCP adapter rejects the entry type before it can compare the host result.

### Recommendation

Promote the existing roadmap's public-projection work to an immediate Pi 0.87 compatibility phase:

1. Require `buildSessionProjection` as a host capability; semver alone is not certification.
2. Wrap the public host projection in DCP's own adapter.
3. Preserve `sourceEntry.id` as DCP's canonical entry identity.
4. Keep an explicit certified entry-type table. `context_edit` is accepted only when the host helper has already applied it and its source identity is valid.
5. Apply DCP's provider-dropped-assistant rule after host projection. The host helper converts entries; DCP still owns its provider boundary rule and its `unprojectedEntryIds` behavior.
6. Validate every projected message and entry identity. Any helper exception, unsupported source type, malformed edit, or ambiguous join remains fail-closed.
7. Add differential tests for omission, content replacement, multiple edits where the latest branch edit wins, branch navigation, compaction, system checkpoints, and legacy malformed messages.

This is the same design described in `PI_0_86_ADOPTION_PLAN.md` section 6. Pi 0.87 changes the priority from future enhancement to compatibility work.

Do **not** replace the wrapper with `buildSessionContext().messages`: that final array loses per-entry provenance, which DCP needs for block coverage, anchors, aliases, and authorization. This constraint is already documented in the adoption plan section 6.4.

## 2. Immediate compatibility issue: system-free `context` events

### What Pi 0.87 changed

Pi 0.87's `ExtensionRunner.emitContext()` now runs the `context` phase as follows:

1. Clone the current full message list.
2. For each `context` handler, pass only messages whose role is not `system`.
3. Restore the system messages after the handler returns.
4. Run `context_with_system` handlers on the restored full transcript.
5. Send the final result from `context_with_system` verbatim.

The documentation states that `context` handlers do not see system messages and do not need to preserve prompt/tool declarations. It also states that `context_with_system` owns the leading system message and executable tool declarations; handlers must keep a system message at index 0.

**Sources:** Pi 0.87.0 `docs/extensions.md`, sections `context` and `context_with_system`; `dist/core/extensions/runner.js`, `ExtensionRunner.emitContext()`.

### Why current DCP can fail

DCP currently registers only:

```ts
pi.on("context", async (event, ctx) => transformContext(event, ctx, runtime));
```

`transformOutgoingContext()` now adapts `ctx.sessionManager.buildSessionProjection()` through DCP's validator. That projection includes system messages when Pi has persisted prompt/tool state or a compaction system checkpoint. `joinProjectedMessages()` then requires a strictly ordered fingerprint match for every projected message against the incoming event messages.

On Pi 0.87, the incoming `context` event intentionally omits system messages while the DCP expected projection can still contain them. The join therefore cannot find candidates for the expected system messages and returns `join_ambiguous`. DCP correctly falls back, but compression is disabled for the request.

### Reproduction performed

With a system entry and a user entry, the current DCP projection contains both while a Pi 0.87-style `context` input contains only the user message. The current join returns:

```json
{
  "ok": false,
  "reason": "join_ambiguous"
}
```

This is independent of the new `context_edit` failure. Fixing only the projector would still leave the system/message-boundary mismatch. The current failure is also fail-closed and safe: the request passes through without DCP transformation, but DCP compression is unavailable for that request.

### Recommendation

First repair the join boundary without changing the lifecycle hook:

- Keep the complete host projection for DCP's canonical index. System messages remain non-compressible barriers and continue to prevent a range from silently crossing prompt/tool state.
- Build a provider-visible view of that projection by excluding system messages only for the join.
- Join that visible view against the messages supplied to `context`. System messages that are present in the incoming list are preserved as extras; Pi 0.87's normal system-free input does not require DCP to manufacture them.
- Keep a mapping from visible projected indexes back to the complete projection indexes. Build protocol units and snapshots from the complete projection, but render the transformed visible messages back into the incoming list without manufacturing system messages for a system-free hook.
- Validate that the leading system message and tool declarations remain host-owned. DCP should not remove, compress, or rewrite them.
- Test repeated user messages, system patches between turns, compaction system checkpoints, injected messages from another extension, and both system-present and system-free inputs.

This design keeps DCP's existing request boundary. The host capability discriminator is an actual API capability, such as the public `buildSessionProjection()` method, not a parsed version string; the current-host policy does not require a version-family fork.

Treat `context_with_system` as a measured fallback, not the default fix. Use it only if the differential tests show that system messages are required to disambiguate a provider-visible sequence or that a host cannot preserve the mapping above. If it is adopted, isolate it behind a capability mode, keep the leading system message at index 0, and add explicit tests for prompt/tool preservation. `before_agent_start` remains the correct hook for stable DCP guidance; DCP should not use the full-transcript hook to persist nudges or rewrite system state.

## 3. Canonical projection migration details

Pi's canonical projection is a better boundary than copying `sessionEntryToContextMessages()` entry by entry:

- It follows the active branch and compaction rules.
- It applies the latest active context edit for each target.
- It returns each projected message with its `sourceEntry`.
- It exposes the resolved `thinkingLevel` and model identity.
- It handles system checkpoints and state-only entries according to Pi's current host contract.

DCP still must not trust the helper blindly. The wrapper must retain:

- entry identity and timestamp validation;
- explicit certification of entry types;
- DCP's provider-dropped assistant rule;
- projected-message validation;
- DCP fingerprints and protocol-unit construction;
- system-message non-compressibility;
- `unprojectedEntryIds` for block availability and anchors;
- request-level fail-closed behavior;
- startup capability gating for hosts without the current projection API.

A practical internal shape is to convert `SessionProjection.entries` into DCP `ProjectedMessage` values:

```ts
for (const projectedEntry of hostProjection.entries) {
  validateSourceEntry(projectedEntry.sourceEntry);
  if (isProviderDroppedAssistant(projectedEntry.sourceEntry)) {
    unprojectedEntryIds.add(projectedEntry.sourceEntry.id);
    continue;
  }
  for (const [projection, message] of projectedEntry.messages.entries()) {
    validateProjectedMessage(message);
    messages.push(wrapProjectedMessage(
      projectedEntry.sourceEntry.id,
      projection,
      message,
    ));
  }
}
```

The exact implementation must account for the host's `context_edit` entries, whose own `messages` array is empty while their target entry's projected messages carry the replacement. DCP should not manufacture a message for the edit entry itself.

## 4. Actionable lifecycle boundaries

### `agent_before_settle`

Pi 0.87 adds a final actionable boundary after retries, automatic compaction, and recovery work. It receives a boundary preview containing:

- proposed structural entries;
- projected context entries with source provenance;
- model context messages;
- pending messages;
- whether one continuation is allowed;
- the activity outcome.

Handlers can return structural drafts (`custom`, `custom_message`, `context_edit`, or `compaction`) and optionally request one continuation. `agent_settled` is now described as final and notification-only; work requested there is deferred until all settled handlers finish.

DCP currently performs automatic settled work in `onSettled()` from `agent_settled`: it rebuilds the branch, runs automatic pruning strategies, appends DCP operation envelopes with `pi.appendEntry()`, evaluates nudges, and persists `nudge.requested` operations. This should be reviewed against the new boundary.

**Potential benefit:** construct DCP operation drafts at `agent_before_settle`, so Pi's boundary preview includes them in the same ordered proposal and DCP can make decisions from Pi's repaired post-retry projection. This could reduce branch-read races and make operation ordering explicit.

**Do not move it blindly:**

- DCP must preserve the rule that a nudge is a request-local suffix, not a persisted model-visible message.
- DCP must not request `continue: true` merely to deliver a nudge on the next user turn.
- DCP's custom operation envelope must remain a valid `custom` draft and be reduced exactly once.
- Existing `agent_settled` behavior may still be needed for notification flushes.
- Add boundary-preview tests before changing persistence timing.

### `turn_end`

Pi 0.87 expands `turn_end` with the assistant message entry ID, tool-result entry IDs, outcome, proposed structural entries, and a rebuilt context preview. DCP does not currently register this event. It could use it to:

- update turn counters from canonical persisted IDs rather than observing only `turn_start`;
- validate the completed assistant/tool pair before nudge eligibility;
- replace some branch re-reads used by post-turn bookkeeping;
- observe exactly which structural entries other extensions proposed.

This is useful but not an immediate correctness fix. `turn_end` should not become a pruning write boundary without resolving ordering with retries and `agent_before_settle`.

### `tool_call` ordering change

Pi 0.87 now waits for earlier agent events to drain before the `tool_call` hook and documents that the session manager is current through the assistant tool-calling message. This may reduce the need for DCP's historical race workaround in `bindCompressionProvenance()`, but the hook remains useful as an authoritative tool-call boundary. Keep the existing binding until a 0.87 integration test proves that removing it does not weaken provenance or duplicate-call protection.

## 5. Cache warming

Pi 0.87 does not introduce cache warming; it improves the 0.86 cache-warming feature and retains `cache_warming_decision`. Pi supplies cost estimates, cache lifetime policy, and continuation probability. An extension may change `warm` to `stop`, but should not force `warm` after Pi chose `stop`.

DCP can benefit because it knows when the next provider-visible prefix is stale even if Pi's persisted session tree did not change:

- a new active compression block;
- decompression or recompression;
- tool-output redaction;
- a pending transient nudge;
- a DCP generation invalidation;
- projection fallback or mutation blocking.

The existing `PI_0_86_ADOPTION_PLAN.md` section 7 already defines the correct conservative policy: stop only with positive evidence that the previous DCP-transformed request cannot be reused, record metadata-only reasons, and never override Pi's stop decision. Keep this as the next optimization after the 0.87 projection/boundary compatibility work.

## 6. Changes not worth adopting for DCP now

### `ContextEditEntry` as normal compression

Do not replace DCP's operation-backed range compression with Pi context edits. A context edit targets one entry, while DCP compresses complete protocol-unit ranges and supports nested reversible blocks. A series of omissions plus one replacement would make the compressed state durable in Pi's model context, complicate DCP baselines and aliases, and weaken the current rollback/recompression semantics.

Pi context edits are valuable host infrastructure and must be understood by DCP's projector. They are not a replacement for DCP's domain model.

### `context_with_system` as a general system-rewrite hook

Use it only as the Pi 0.87-compatible request boundary needed to preserve DCP's existing full-message join. Do not use it to put nudges into system state, rewrite tool declarations, or compress system checkpoints. Stable DCP guidance still belongs in the named `before_agent_start` section, and live nudges still belong in the outgoing context tail.

### Per-model image input limits

Pi 0.87 adds cache-safe per-model image resize profiles for attachments, `read`, and tool-result images. The host owns image normalization before provider dispatch. DCP should validate and estimate the resulting messages but should not reproduce model-specific resizing or modify image bytes.

### `shouldStopAfterTurn` removal

DCP does not use this inherited agent option. No action required.

### Canonical agent state ownership

Pi 0.87 makes `SessionManager` canonical for provider context and no longer treats direct assignment to `session.agent.state.messages` as a durable history replacement. DCP does not assign that field; it returns outgoing context from extension hooks. No action required, but future work must continue using the session manager and extension events rather than mutating agent state.

## 7. Required validation and rollout

Before claiming Pi 0.87 support:

1. Pin all four Pi development packages and peers to the current Pi 0.87.x family; the exact 0.87.0 lockfile is the certification artifact.
2. Add a compatibility fixture for `context_edit` omission and replacement.
3. Add a differential fixture comparing the DCP wrapper with `buildSessionProjection()` while preserving source-entry identity.
4. Add a Pi 0.87 lifecycle fixture proving that the system-agnostic join handles both system-present and system-free `context` inputs without double transformation.
5. Test persisted system sections, tool declarations, compaction checkpoints, context edits, branch navigation, retry recovery, and injected messages from another extension.
6. Test that system messages remain non-compressible and that DCP never manufactures them into Pi's system-free context input.
7. Test `agent_before_settle` and `turn_end` previews before moving any DCP write.
8. Make the README and roadmap's current-host statement match the actual lockfile/test environment.
9. Run the existing complete suite, differential compatibility tests, `git diff --check`, Ripwire quality delta, and lifecycle contract checks.

The current `npm run check` certifies the pi-dcp package against the exact 0.87.0 development dependencies. It does not claim support for older Pi hosts or an untested future minor release.

## Bottom line

Pi 0.87's host-owned projection and system-free context boundary are now integrated without changing DCP's reversible, operation-backed compression model. The next opportunities are lifecycle-boundary review and conservative cache-warming coordination. Durable host context edits, unrestricted full-transcript rewriting, and image-policy duplication should remain outside DCP's core design. See `PI_0_86_0_87_ROADMAP.md` for the combined future-work order.
