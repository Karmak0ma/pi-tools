# Pi 0.86 capability investigation and pi-dcp adoption plan

**Status:** historical Pi 0.86 roadmap; structured-prompt Phase 1 and Pi 0.87 compatibility repair implemented, later capability phases remain open
**Host version investigated:** `@earendil-works/pi-coding-agent` 0.86.1
**Current lockfile host:** `@earendil-works/pi-coding-agent` 0.87.0
**Current pi-dcp peer range:** Pi `0.87.0` exact
**Support policy:** internal latest-host certification only; no previous-version matrix
**Primary audience:** maintainers and agents implementing the next pi-dcp phases
**Combined roadmap:** `PI_0_86_0_87_ROADMAP.md`

## 1. Purpose

Pi 0.86 added transcript-backed system state, prompt-cache warming, public extension model calls, richer compaction events, per-model compaction budgets, and persisted usage accounting. The release also changed session projection enough to break pi-dcp's Pi 0.84.1-specific adapter.

This document records:

1. what changed in Pi;
2. what caused the compatibility incident;
3. which new capabilities fit pi-dcp's design;
4. which capabilities should remain outside pi-dcp;
5. a phased implementation and validation plan;
6. the decisions that must be made before native-compaction behavior changes.

This is a proposal, not authorization to implement every phase. The current repository tests against Pi 0.87.0 and certifies only the current Pi 0.87.x host family. The structured-prompt work and the Pi 0.87 projection/context compatibility repair are implemented; the remaining capability phases are future work. Phase 4 conflicts with the frozen first-release native-compaction contract and requires a separate explicit product decision before implementation.

## 2. Executive recommendation

Adopt the capabilities in this order:

| Priority | Capability | Decision | Main reason |
|---:|---|---|---|
| 1 | Structured `systemPromptOptions.sections` | Adopt soon | Stable DCP rules become replayable prompt state and preserve cache prefixes better than complete prompt replacement. |
| 2 | Public `sessionEntryToContextMessages()` | Adopt behind DCP's fail-closed wrapper | Reduces projection drift while retaining canonical entry provenance and strict validation. |
| 3 | `cache_warming_decision` | Adopt conservatively | Prevents Pi from paying to warm a provider prefix DCP already knows will become stale. |
| 4 | Rich native-compaction hooks | Prototype and measure first | Could solve premature native compaction, but cancellation and custom summaries alter a frozen safety contract. |
| 5 | `ctx.modelRegistry.streamSimple()` | Use only for optional extension-owned summarization | Useful plumbing, but a second model call should not replace the current model-authored `compress` workflow. |
| — | Persistent messages or system patches for DCP nudges | Reject | Nudges are transient, turn-relative control signals and must not become durable conversation state. |
| — | Pi usage entries for estimated DCP savings | Reject | Pi usage means actual billed model work; DCP savings are estimates. |

The first three phases are independent. Phase 4 may use Phase 5, but neither is needed to complete Phases 1–3.

## 3. Compatibility incident: what changed and why DCP failed

### 3.1 Previous assumption

`src/identity/project.ts` contained a local, versioned projection adapter for Pi 0.84.1. The adapter deliberately failed closed when it saw an unknown session entry or message shape. This is a safety feature: DCP must not authorize compression against a transcript it cannot map to canonical entry IDs.

The package accepted Pi `>=0.84.1`, but its development dependencies and projection fixtures were pinned to 0.84.1. A later host could therefore satisfy semver while changing the projection contract.

### 3.2 Pi 0.86 projection changes

Pi 0.86 introduced three context-relevant forms.

#### Persisted usage entries

A `UsageEntry` records model-attributed work that is not an assistant response. Prompt-cache warming uses `kind: "cache_warm"`. Usage entries contribute to session token and cost totals, but Pi hides them from the conversation tree and projects no model message.

The old DCP adapter did not recognize `type: "usage"`, so it returned `projection_unsupported`.

#### Persisted system messages

Pi now stores prompt and tool state in transcript messages:

```ts
{
  role: "system",
  content: "",
  sections: { /* named prompt-section patches */ },
  toolsAdded: [/* complete tool declarations */],
  toolsRemoved: [/* tool references */],
  timestamp: 0,
}
```

The first request declares the current prompt sections and tools. Later system messages patch named sections and tool availability. Replaying them reconstructs the effective prompt and tool loadout.

The old DCP message validator rejected `role: "system"`.

#### Compaction system checkpoints

A Pi 0.86 `CompactionEntry` may contain `systemMessage`. Pi projects it before the compaction summary:

```text
system checkpoint
compaction summary
retained non-system context
post-compaction context
```

The old DCP adapter emitted only the summary. Even after accepting usage and ordinary system entries, this omission would have caused an identity join failure after native compaction.

### 3.3 Implemented compatibility repair

The current working implementation now:

- recognizes usage and other non-context entry types;
- projects ordinary system messages;
- projects a compaction system checkpoint before its summary;
- mirrors Pi's defensive null-content normalization for legacy or hand-edited sessions;
- retains DCP's special handling for errored, aborted, empty, and legacy-null assistant turns that the provider does not receive;
- marks system protocol units permanently non-compressible;
- includes system content, section patches, and tool declarations in heuristic token estimates;
- pins development Pi packages, peer dependencies, and the current lockfile to exact 0.87.0 for the internal current-host policy.

The historical plan text above described a multi-version policy. That policy is withdrawn: the lockfile and deterministic suite certify Pi 0.87.0 only, and a future Pi update requires updating the four pins and rerunning the suite rather than retaining a previous-version matrix.

The regression tests are in `test/golden/projection.test.ts`.

### 3.4 Lesson

Semver capability presence does not certify projection compatibility. DCP needs both:

1. a host capability check; and
2. a tested projection contract for each supported Pi behavior family.

The proposed public-projector adoption in Phase 2 reduces this duplication, but it does not remove DCP's need for provenance, validation, and fail-closed handling.

## 4. Current DCP architecture constraints

Any proposal must preserve these properties.

### 4.1 DCP is an outgoing-context lens

DCP changes a cloned `AgentMessage[]` in the `context` event. It does not delete or rewrite raw Pi history. DCP operations are append-only custom session entries. Active blocks replace covered content only in outgoing model context.

### 4.2 Canonical identity comes from Pi entry IDs

Model-facing aliases such as `m0001` and `b0001` are local references. Authorization and persisted coverage use Pi entry IDs and tool-call IDs. Any host helper that returns only messages is insufficient on its own.

### 4.3 Unknown projection remains fail closed

A new host entry type could be either metadata or model-visible context. Treating every unknown type as invisible would risk compressing the wrong transcript. DCP must continue to reject unknown entry contracts until classified.

### 4.4 Stable rules and transient nudges are different data

Stable selection rules belong in the system prompt. A nudge is based on live usage, turn boundaries, pending state, and recent compression behavior. It must remain a one-request suffix and stay outside canonical history and DCP baselines.

### 4.5 Pi native compaction is not DCP compression

DCP compression is model-authored, range-selected, operation-backed, reversible while source entries remain active, and applied only to outgoing context.

Pi native compaction replaces an old prefix during future session reconstruction. It changes which raw entries `buildContextEntries()` exposes. Native compaction therefore requires rebase logic even when automatic threshold compaction is disabled.

## 5. Opportunity 1: structured DCP system guidance

### 5.1 Pi capability

`before_agent_start` now exposes mutable structured prompt inputs through:

```ts
event.systemPromptOptions.sections
event.systemPromptOptions.promptGuidelines
event.systemPromptOptions.selectedTools
```

Pi recommends changing these structured values instead of returning a complete `systemPrompt`. Pi diffs named prompt sections against the transcript's current system state. Providers that support mid-conversation system messages can receive a narrow patch and retain their cached prefix. Other providers receive a replayed leading prompt and pay a cache miss only when the effective prompt changes.

### 5.2 Current DCP behavior

`src/lifecycle.ts:beforeAgentStart` currently returns:

```ts
{
  systemPrompt: `${event.systemPrompt}\n\n${buildSystemGuidance(runtime.config)}`,
}
```

This forces the complete prompt for the run. The DCP guidance is not represented as its own structured section in Pi's transcript state.

### 5.3 Proposal

Use one stable section key owned by DCP:

```ts
const DCP_SYSTEM_SECTION = "pi_dcp_context_compression";

event.systemPromptOptions.sections[DCP_SYSTEM_SECTION] =
  buildSystemGuidance(runtime.config);
```

When DCP is disabled or its guidance should not be present, delete the section rather than setting an empty changing value:

```ts
delete event.systemPromptOptions.sections[DCP_SYSTEM_SECTION];
```

The handler should not return `systemPrompt` after mutating the structured section.

### 5.4 Required invariants

The section content must be deterministic for one effective DCP configuration. It may include:

- alias selection rules;
- complete-protocol-unit rules;
- nested block placeholder rules;
- compression permission guidance;
- stable protected-content policy;
- stable final-answer and compression timing rules.

It must not include:

- current token counts;
- timestamps;
- pending nudge state;
- current aliases;
- random or operation IDs;
- exact turn counters;
- per-request readiness;
- fallback diagnostics.

Those values would create repeated system patches and unstable cache prefixes.

### 5.5 Expected benefits

- DCP guidance survives session resume as transcript state.
- Native compaction checkpoints include the effective DCP section.
- Prompt changes become explicit, narrow system patches.
- Stable sessions avoid complete prompt replacement.
- Tool and prompt state follow one Pi-owned replay mechanism.
- The implementation follows Pi's recommended extension pattern.

### 5.6 Risks

- A configuration change intentionally creates a new system patch.
- Another extension can modify the same section key if ownership is not unique.
- Providers without mid-conversation system-message support still need one cache miss when the effective prompt changes.
- Existing sessions may contain earlier system state without the DCP section; the first request after adoption will append it.

### 5.7 Validation plan

Add integration tests that prove:

1. the first eligible request adds one DCP section;
2. an unchanged configuration does not create a different section value;
3. a meaningful configuration change creates one deterministic patch;
4. disabling DCP removes the section;
5. guidance survives session reconstruction;
6. guidance survives a Pi 0.86 compaction checkpoint;
7. no live usage or nudge state appears in the section;
8. existing transient nudge tests remain unchanged;
9. provider payload tests show stable leading prompt bytes when nothing changed.

### 5.8 Completion criterion

Phase 1 is complete when DCP no longer returns a complete replacement `systemPrompt`, all stable rules are present in one owned structured section, transient nudges remain request-local, and cache/persistence tests pass on Pi 0.86.1.

## 6. Opportunity 2: public session-entry projection

### 6.1 Pi capability

Pi publicly exports:

```ts
sessionEntryToContextMessages(entry: SessionEntry): AgentMessage[]
```

The helper performs Pi's entry-level message conversion, including:

- persisted message projection;
- null-content normalization;
- custom-message conversion;
- branch-summary conversion;
- compaction system checkpoint plus summary ordering;
- exclusion of metadata-only entries.

The export was observed in the previously installed Pi 0.84.1 package and is present in the current 0.86.1 package. Because the repository now installs 0.86.1, the proposed compatibility matrix must independently reproduce the 0.84.1 observation before Phase 2 relies on it as a supported minimum.

### 6.2 What the helper does not provide

It does not provide:

- the source entry ID for each returned message;
- projection ordinals as canonical keys;
- DCP fingerprints;
- tool-call IDs;
- `unprojectedEntryIds`;
- provider-dropped assistant filtering;
- unknown-entry certification;
- DCP structural validation;
- block availability and anchor behavior.

DCP must retain those responsibilities.

### 6.3 Proposal

Use Pi's helper only inside a DCP-owned wrapper:

```ts
for (const entry of entries) {
  validateEntryIdentity(entry);

  if (!isCertifiedEntryType(entry.type)) {
    return projectionUnsupported();
  }

  if (isProviderDroppedAssistant(entry)) {
    unprojectedEntryIds.add(entry.id);
    continue;
  }

  const projected = sessionEntryToContextMessages(entry);
  for (const [projection, message] of projected.entries()) {
    validateProjectedMessage(message);
    messages.push(wrapProjectedMessage(entry.id, projection, message));
  }
}
```

Keep a certified entry-type table. The table answers whether DCP understands the host contract. Pi's helper answers how the current host converts a certified entry.

Any unknown type, malformed identity, helper exception, invalid projected message, or ambiguous join uses the existing request-level fail-closed path:

1. return an untouched deep clone of the incoming context for that request;
2. publish no baseline and clear any unrelated authorization slot;
3. append no DCP operation and reject any compression call that depends on the failed projection;
4. set readiness to unavailable with a metadata-only reason, queue the persisted fallback notice when the active reason changes, and emit the UI notification at most once per reason code;
5. allow a later request to recover when projection becomes valid.

Projection failure alone does not mark the branch permanently corrupt. Persisted DCP state corruption remains the separate branch-disabling condition.

### 6.4 Why not use `buildSessionContext().messages` directly

`buildSessionContext()` is useful for comparison, but its final `AgentMessage[]` loses entry-to-message provenance. DCP cannot safely derive block coverage, anchors, or canonical alias identities from that array alone.

The final session context can serve as a differential oracle in tests:

```text
DCP projected messages, after DCP-specific provider-drop rules
versus
Pi built session messages, after the same provider-drop normalization
```

It should not replace per-entry mapping.

### 6.5 Expected benefits

- Less duplicate host conversion code.
- Automatic adoption of compatible conversion fixes in the active Pi version.
- Lower risk of omitting fields such as compaction system checkpoints.
- Smaller local adapter surface.
- Clear separation between host conversion and DCP identity/security.

### 6.6 Risks

- A future helper may return no messages for a new metadata entry and tempt DCP to accept an uncertified type. The explicit type table prevents this.
- The host helper does not apply DCP's provider-dropped assistant rule.
- A runtime value import must resolve the host-supported public package API. Do not import a private `dist/core/...` path.
- Different Pi versions can convert the same malformed legacy entry differently. The compatibility matrix must detect this.

### 6.7 Current-host certification

The internal extension certifies the exact Pi `0.87.0` lockfile host and requires that exact version in all four peer dependencies. Every Pi update must refresh the four pins and rerun `npm ci` plus the complete deterministic suite. No 0.84.x, 0.85.x, or 0.86.x host matrix is maintained.

Pi 0.87's public `buildSessionProjection()` is a required startup capability. A host without it is unsupported and disables DCP rather than selecting an older projection path. Tests for usage entries, persisted system state, legacy compaction metadata, and null normalization remain because those data shapes are still accepted by the certified Pi 0.87 host.

### 6.8 Completion criterion

Phase 2 is complete when DCP delegates certified entry conversion to the current public helper, retains exact canonical provenance and fail-closed behavior, and the Pi 0.87.0 lockfile suite passes.

## 7. Opportunity 3: cache-warming coordination

### 7.1 Pi capability

Pi's cache warmer can refresh an expensive prompt prefix shortly before provider cache expiry. The global setting is:

```json
{
  "cacheWarming": "off" | "streaming" | "idle"
}
```

Before a refresh, extensions receive:

```ts
pi.on("cache_warming_decision", (event, ctx) => {
  event.warmCost;
  event.missCost;
  event.continuationProbability;
  event.action; // "warm" | "stop"
});
```

Returning `{ action: "warm" }` or `{ action: "stop" }` overrides the decision. The last extension override wins. `"stop"` ends warming until the next real request.

Pi already stops warming on model switch, native compaction, and branch navigation. Pi also applies its own cost threshold, time bounds, model cache-lifetime requirements, and thinking-mode restrictions.

### 7.2 DCP-specific stale-prefix risk

DCP can know that the next real provider request will differ even when Pi's persisted message history changed only through a non-context DCP operation. Examples include:

- a new active compression block;
- a decompression or recompression;
- tool-pruning state applied by DCP;
- a pending transient nudge;
- an invalidated DCP generation awaiting publication;
- mutation-blocked branch or compaction transition state;
- projection fallback that will send raw context instead of the last transformed context.

Warming the previous request in those states may pay for a prefix that DCP will not reuse.

### 7.3 Conservative proposal

DCP may change Pi's `"warm"` to `"stop"` only when it has positive local evidence that the last provider-visible DCP transform is stale.

DCP should not override Pi's `"stop"` to `"warm"`. Pi has better information about provider lifetime, cache tier, cost, and continuation probability.

A candidate policy is:

```ts
if (event.action !== "warm") return;

if (
  runtime.mutationBlocked
  || runtime.pendingNudge
  || !runtime.lastReadiness?.ready
  || hasUnpublishedDcpGeneration(runtime)
  || providerVisibleTransformChangedSinceLastRealRequest(runtime)
) {
  return { action: "stop" };
}
```

The two conceptual predicates must be backed by explicit runtime state. Do not infer them from timestamps or approximate array equality.

### 7.4 Observability

Record metadata-only counters:

- Pi decisions observed as warm or stop;
- DCP warm decisions changed to stop;
- DCP stop reason code;
- whether the next real request changed the transformed prefix;
- estimated warm cost and miss cost, without message content.

This permits validation of whether DCP is preventing real waste or stopping useful warming too often.

### 7.5 Validation plan

Test:

1. Pi stop remains stop;
2. a stable, ready DCP state does not override warm;
3. pending compression-state publication stops warming;
4. pending transient nudge stops warming;
5. projection fallback stops warming;
6. next real request clears the stop condition where appropriate;
7. no content, summaries, paths, or tool arguments enter diagnostics;

### 7.6 Completion criterion

Phase 3 is complete when DCP overrides only proven-stale warm candidates, never forces warming, and measured diagnostics show that each override corresponds to a changed next provider-visible context.

## 8. Opportunity 4: native-compaction integration

### 8.1 Pi capability

`session_before_compact` exposes:

- `reason`: `"manual"`, `"threshold"`, or `"overflow"`;
- `willRetry`;
- `signal`;
- all current branch entries;
- messages selected for summarization;
- split-turn prefix messages;
- previous compaction summary;
- extracted file operations;
- tokens before compaction;
- first retained entry ID;
- effective per-model compaction settings.

An extension may:

- return `undefined` and allow default compaction;
- return `{ cancel: true }`;
- return a custom compaction result with summary, retention boundary, token count, optional usage, and optional JSON details.

`session_compact_failed` reports failure or abort outcome, reason, retry intent, and whether extension-provided compaction content was in use.

### 8.2 Current product contract

`IMPLEMENTATION_PLAN.md` currently requires the user to disable automatic threshold compaction and states that DCP:

- never cancels native compaction;
- never supplies a custom compaction result;
- only invalidates and rebases around native compaction.

This contract is a deliberate safety boundary. Phase 4 cannot silently override it. Before implementation, update the product contract, README, design, and tests through an explicit decision.

### 8.3 The architectural problem Phase 4 could solve

DCP reduces outgoing provider context but does not change Pi's persisted token accounting. Pi can therefore start threshold compaction while the DCP-transformed provider context remains safely below the model limit.

Native compaction can then:

- summarize source history DCP already summarized;
- remove raw entries that made DCP decompression possible;
- invalidate active block coverage;
- erase part of DCP's measured savings benefit;
- make users disable an otherwise useful Pi safety feature.

### 8.4 Stage 4A: telemetry only

Before behavior changes, measure:

- native compaction reason;
- effective reserve and recent-token settings;
- Pi's `tokensBefore`;
- DCP's estimated transformed token count at the same boundary;
- active block count and estimated savings;
- whether compaction succeeded, failed, or was aborted;
- block availability before and after rebase;
- whether the operation was manual, threshold, or overflow recovery.

Do not include raw content, summaries, paths, or tool arguments.

This stage should also add `session_compact_failed` handling so every observed attempt has a terminal outcome.

### 8.5 Stage 4B: DCP-aware custom summary prototype

A prototype may supply a custom native summary that respects active DCP blocks. It must preserve:

- Pi's `firstKeptEntryId`;
- `tokensBefore`;
- split-turn `turnPrefixMessages`;
- previous compaction summary;
- file-operation context;
- protected tool information;
- active DCP summary meaning and nested provenance;
- actual model usage when a model call is made.

Pi's `serializeConversation()` truncates large tool results to 2000 characters. A custom DCP summarizer must not assume that serialization preserves complete protected output.

The prototype must return `undefined` on unsupported state so Pi's default compactor remains available.

### 8.6 Stage 4C: threshold cancellation experiment

Cancellation may be considered only for `reason === "threshold"` and only after Stage 4A proves that Pi regularly compacts contexts whose actual DCP-transformed request is safely below the threshold.

Never cancel:

- manual compaction;
- overflow recovery;
- compaction while DCP is invalid or in fallback;
- compaction when transformed token confidence is insufficient;
- compaction when protocol validation or projection is unavailable.

Known risks:

- Pi may repeat the threshold check every turn because persisted usage remains high;
- DCP's heuristic token estimate may undercount provider input;
- cancellation can remove Pi's response-token safety margin;
- another extension may alter context after DCP;
- model switches change the effective reserve and recent-token settings;
- a cancelled threshold operation may be followed by overflow recovery.

A successful prototype needs a hysteresis or suppression design for repeated threshold checks. A one-off cancellation without such a design is incomplete.

### 8.7 Completion criterion

Stage 4A telemetry is complete before any behavior-changing prototype begins when:

1. `session_before_compact`, `session_compact`, and `session_compact_failed` produce one correlated attempt and terminal outcome without raw content;
2. manual, threshold, and overflow reasons plus `willRetry` are distinguished;
3. effective settings, DCP transformed-size estimate, active-block count, and post-rebase availability are recorded as metadata-only values;
4. success, abort, and failure fixtures pass;
5. the measurements are sufficient to decide whether premature threshold compaction is material.

The complete Phase 4 behavior change is complete only after:

1. Stage 4A is complete and telemetry demonstrates a material problem;
2. the frozen no-cancel/no-custom-compaction contract is explicitly revised;
3. manual and overflow compactions always proceed;
4. a custom summary passes split-turn, prior-summary, file-operation, protected-content, branch, and crash tests;
5. any threshold cancellation has a proven repeated-trigger policy and conservative token safety margin;
6. README and configuration guidance no longer contradict runtime behavior.

## 9. Opportunity 5: extension-owned model calls

### 9.1 Pi capability

Pi now exposes authenticated model calls through the active model registry:

```ts
ctx.modelRegistry.streamSimple(model, context, options)
ctx.modelRegistry.stream(model, context, options)
```

These calls use configured providers, resolve authentication, include extension-registered providers, and return an `AssistantMessageEventStream`. `streamSimple()` uses provider-neutral options; `stream()` allows API-specific options.

This is preferable to legacy `pi-ai/compat` streaming calls for extension-owned work because the compatibility functions cannot see all extension provider registrations.

### 9.2 Appropriate DCP use

Use these APIs only if DCP implements optional custom native summarization or another explicit secondary-model feature. A custom compaction call should:

- use an explicitly selected model policy;
- pass the compaction abort signal;
- disable prompt-cache writes for one-off summarization where supported;
- use a fresh routing session ID where required;
- handle setup errors, stream errors, aborts, and empty output;
- return actual response usage in the compaction result;
- fall back to Pi's default compaction when safe.

### 9.3 Why it should not replace `compress`

The current `compress` tool is authored by the active task model inside its current reasoning context. It selects complete protocol units and submits a summary against a validated immutable baseline.

A separate summarization call:

- has less task understanding;
- adds cost;
- needs model-selection policy;
- can produce meaning inconsistent with the active agent;
- introduces authentication and retry failure modes;
- weakens the direct relationship between the active model and the summary it will later consume.

The default DCP compression path should remain the validated model-authored tool call.

### 9.4 Completion criterion

Phase 5 is complete only as part of an explicitly optional feature whose failure safely returns to the current DCP or Pi behavior, whose actual usage is recorded, and whose model-selection and privacy policy are documented.

## 10. Capabilities DCP should not adopt

### 10.1 Persistent nudges

Do not move DCP nudges into `before_agent_start` persistent messages or transcript-backed system sections.

A nudge is:

- one-shot;
- derived from current usage and recent turns;
- intentionally excluded from canonical DCP history;
- expected to disappear after compression or state change;
- appended after canonical transformation so it cannot affect joining or baseline authorization.

Persistence would make stale nudges replay after resume, affect protocol grouping, move cache boundaries, and request compression after compression already occurred.

Keep:

- stable rules in the structured system section;
- live nudges in the transient outgoing context suffix;
- `relocateCacheBreakpoint()` for the transient suffix.

### 10.2 Estimated savings as Pi usage

A Pi `UsageEntry` represents actual model-attributed token and cost activity. DCP's savings values are estimates derived from transformed message size.

Keep estimated savings in DCP's operation/statistics ledger. Report actual model usage only when DCP itself performs a model call and the host API offers an appropriate usage field, such as a custom compaction result.

### 10.3 Direct replacement with `buildSessionContext()`

The final built context has no per-entry provenance. Use it as a test oracle, not as the canonical source for DCP block identity.

### 10.4 Unconditional cache warming

DCP should never force a warm decision that Pi's cost model rejected. DCP can identify local staleness; it does not know provider cache economics better than Pi.

### 10.5 Compression of system messages

System messages define the instruction and tool environment under which later messages occurred. Keep them as non-compressible protocol barriers. They may appear in diagnostics, but neither `mNNNN` selection nor block coverage may remove them.

## 11. Cross-phase compatibility and rollout policy

### 11.1 Selected current-host policy

The project selected the internal current-host policy on 2026-09-21:

- the four Pi peer dependencies use exact `0.87.0`;
- the lockfile pins and certifies exact Pi `0.87.0` behavior;
- Pi 0.87's `buildSessionProjection()` is a required startup capability;
- older host APIs are unsupported and fail closed rather than receiving a compatibility claim;
- no previous-version matrix or previous-host lifecycle tests are maintained;
- when Pi updates, update the four pins and rerun `npm ci` plus the complete deterministic suite.

The local legacy projector was removed. Current-host tests invoke Pi 0.87's public projection helper directly, and older host APIs remain unsupported.

### 11.2 Capability versus semantic checks

Capability checks answer whether an API exists. Fixtures answer whether its behavior matches DCP's assumptions. Both are required for:

- session projection;
- structured prompt persistence;
- cache-warming hooks;
- compaction preparation fields;
- custom compaction result shape.

### 11.3 Rollout sequence

For each phase:

1. add a red regression or differential fixture;
2. implement behind the smallest internal seam;
3. run typecheck and the complete non-live suite;
4. run projection/provider golden tests;
5. run Ripwire quality and contract checks;
6. test session resume, branch navigation, and native compaction;
7. update README and design documents if the product contract changes;
8. reload Pi and validate one real session without inspecting or logging private content.

### 11.4 Rollback

Each phase should remain separately revertible:

- Phase 1 can return to full prompt replacement without changing block state.
- Phase 2 can disable the host-projection integration without changing persisted operations.
- Phase 3 can remove the warming handler without changing conversation state.
- Phase 4 requires special care because custom native compaction changes future session reconstruction. Prototype it in disposable sessions before normal use.
- Phase 5 model calls should fail before any durable operation when no valid result exists.

## 12. Proposed issue breakdown

### Issue A: structured DCP prompt section

**Scope:** `src/lifecycle.ts`, `src/prompts/defaults.ts`, integration and cache tests.  
**Outcome:** stable guidance becomes one Pi-owned structured section.  
**Dependencies:** none.  
**Risk:** low to medium.

### Issue B: public projection helper adapter

**Scope:** `src/identity/project.ts`, current-host projection fixtures, and validation.
**Outcome:** Pi 0.87 converts certified entries; DCP retains provenance and validation.
**Dependencies:** compatibility harness for multiple Pi versions.  
**Risk:** medium because projection is an authorization boundary.

### Issue C: DCP-aware cache-warming stop policy

**Scope:** `src/lifecycle.ts`, runtime state, metadata-only diagnostics, integration tests.  
**Outcome:** stale DCP prefixes are not warmed.  
**Dependencies:** define explicit transformed-prefix publication state.  
**Risk:** low correctness risk; moderate risk of losing useful cache savings if the stop policy is too broad.

### Issue D: native-compaction telemetry

**Scope:** lifecycle events, diagnostics, stats, compaction fixtures.  
**Outcome:** measured evidence for premature threshold compaction and post-compaction block loss.  
**Dependencies:** none; no behavior change.  
**Risk:** low if logs remain metadata-only.

### Issue E: DCP-aware custom native compaction prototype

**Scope:** separate prototype or guarded experimental path.  
**Outcome:** determine whether active DCP summaries can safely guide Pi compaction.  
**Dependencies:** Issue D; explicit product decision.  
**Risk:** high.

### Issue F: threshold cancellation experiment

**Scope:** disposable prototype only until repeated-trigger and safety behavior are proven.  
**Outcome:** determine whether DCP can safely avoid unnecessary native threshold compaction.  
**Dependencies:** Issues D and E; explicit revision of the frozen contract.  
**Risk:** very high.

### Issue G: optional secondary-model summarization

**Scope:** model policy, authenticated stream handling, usage reporting, privacy and abort behavior.  
**Outcome:** optional custom summary generation for native compaction.  
**Dependencies:** Issue E.  
**Risk:** high and not required for standard DCP compression.

## 13. Open decisions

Resolve these before Phase 4 or Phase 5:

1. Does pi-dcp continue to require automatic Pi compaction to be disabled, or may it coordinate with automatic threshold compaction?
2. If native compaction becomes DCP-aware, does DCP provide a custom summary, cancel selected threshold attempts, or only observe and rebase?
3. What minimum safety margin is required between estimated transformed tokens and the provider context limit?
4. How are repeated threshold checks suppressed after a safe cancellation?
5. Which model generates an optional native-compaction summary: active model, configured secondary model, or Pi default?
6. Is secondary-model summarization allowed in manual mode?
7. How is permission obtained for a model call that the active agent did not explicitly request?
8. When the next Pi release lands, which current-host fixtures and APIs must be refreshed before updating the four pins?

## 14. Final acceptance criteria

The complete roadmap is successful when:

- one explicit Pi version-support policy has been selected, its exact test artifact passes, and `peerDependencies`, lockfile strategy, `README.md`, and `IMPLEMENTATION_PLAN.md` agree;
- stable DCP guidance uses a deterministic structured prompt section;
- transient nudges remain non-persistent and baseline-independent;
- certified entry conversion uses Pi's public behavior without losing DCP entry provenance;
- unknown entry and message contracts still fail closed;
- system messages and tool-state patches remain non-compressible;
- cache warming is stopped only for proven-stale DCP prefixes;
- native-compaction telemetry correlates every attempted compaction with success, abort, or failure before any behavior-changing prototype starts;
- native-compaction behavior changes only after telemetry and an explicit contract revision;
- manual and overflow compaction are never blocked;
- actual model usage and estimated DCP savings remain separate;
- the exact current Pi lockfile host has explicit projection and lifecycle fixtures;
- the complete non-live test suite, typecheck, quality delta, and contract checks pass;
- documentation describes actual runtime behavior rather than intended behavior.

## 15. Verified Pi references

The investigation used Pi 0.86.1's installed public documentation, declarations, implementation, and examples.

### Documentation

- `@earendil-works/pi-coding-agent/CHANGELOG.md`
  - Pi 0.86.0 transcript-backed system/tool updates, prompt-cache warming, extension model calls, and per-model compaction budgets.
- `@earendil-works/pi-coding-agent/docs/extensions.md`
  - `before_agent_start`
  - structured `systemPromptOptions`
  - `context`
  - `cache_warming_decision`
  - `ctx.sessionManager`
  - `ctx.modelRegistry.stream()` and `streamSimple()`
  - compaction lifecycle events
- `@earendil-works/pi-coding-agent/docs/session-format.md`
  - system messages
  - usage entries
  - compaction system checkpoints
  - `buildContextEntries()`
  - `buildSessionContext()`
- `@earendil-works/pi-coding-agent/docs/settings.md`
  - cache-warming modes and economics
  - per-model compaction overrides
- `@earendil-works/pi-coding-agent/docs/compaction.md`
  - custom summarization
  - split-turn handling
  - serialization truncation
  - compaction reasons and result fields

### Public implementation and types

- `dist/core/session-manager.d.ts`
  - `UsageEntry`
  - `CompactionEntry.systemMessage`
  - `sessionEntryToContextMessages()`
  - `buildContextEntries()`
  - `buildSessionContext()`
- `dist/core/session-manager.js`
  - exact entry projection and null normalization
- `dist/core/extensions/types.d.ts`
  - lifecycle event and result contracts
- bundled `@earendil-works/pi-ai/dist/types.d.ts`
  - `SystemMessage`
  - prompt sections and tool transitions
  - transcript context

### Examples

- `examples/extensions/prompt-customizer.ts`
  - preferred structured section mutation pattern
- `examples/extensions/custom-compaction.ts`
  - custom compaction model call, serialization, retention boundary, abort signal, and usage reporting

## 16. Related pi-dcp documents

- `DESIGN.md` — historical architecture and normative safety requirements.
- `CACHE_SNAPSHOT_REDESIGN.md` — implemented v2 baseline, aliases, operations, and nudge design.
- `IMPLEMENTATION_PLAN.md` — frozen first-release contract, including the prohibition on native-compaction cancellation and replacement. Its 0.84.1 development pin, initial 0.1.0 package/version assumptions, and later-version adapter policy are stale relative to the current 0.2.0 working tree and must be revised when the support policy is selected.
- `README.md` — user-facing configuration and automatic Pi compaction prerequisite.
- `SAVINGS_STATS_STATUS.md` — current distinction between measured/estimated savings and actual provider usage.
