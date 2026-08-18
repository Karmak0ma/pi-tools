# pi-dcp Compression Refactor Proposal

## Status

Proposed refactor based on:

- Forensic analysis of the failed Pi session:
  `/home/vflores/.pi/agent/sessions/--home-vflores-repos-breakfast_conquer--/2026-08-16T11-47-27-964Z_01a00a65-f05b-75a2-b877-a96f1282ace9.jsonl`
- Analysis of the current pi-dcp implementation.
- Comparison with the working OpenCode extension:
  `/home/vflores/repos/opencode-dynamic-context-pruning`

No implementation changes are included in this proposal. The proposal intentionally separates confirmed facts from inferences and recommendations.

## Executive conclusion

The captured compression failure had two independent causes:

1. **Primary correctness defect: the active provider API was unsupported.**
   The session used `openai-codex-responses`, but pi-dcp did not certify that API in `src/transform/adapters.ts`. The context pipeline therefore failed before publishing a baseline or exposing usable compression aliases.

2. **Secondary runtime defect: the session was running stale extension code.**
   The session started before commit `e7c9cc97`, which added execute-time recovery of persisted compression provenance. The session contains no `/reload`, so it continued using the older implementation that required an ephemeral `tool_call` binding.

The model was nevertheless encouraged to call `compress`, and it was told to use aliases. It then spent substantial effort searching the raw JSONL file for strings that looked like `mNNNN` and `bNNNN`. Those strings were not a reliable current alias catalog. The model selected `m0227..m2109`, but the failed call stopped at provenance validation before range validation could report that the range was invalid.

The refactor should therefore prioritize:

- making compression availability reflect actual per-request readiness;
- certifying `openai-codex-responses` through provider-wire tests;
- preventing prompts and nudges when aliases were not published;
- making aliases locally visible and easy to use;
- providing OpenCode-quality selection and summary instructions;
- adding session-level regression coverage and runtime diagnostics.

## 1. Evidence and scope

### 1.1 Files analyzed

Pi-dcp source and tests:

- `src/transform/adapters.ts`
- `src/transform/pipeline.ts`
- `src/transform/blocks.ts`
- `src/identity/snapshot.ts`
- `src/identity/protocol.ts`
- `src/compression/tool.ts`
- `src/compression/range.ts`
- `src/compression/service.ts`
- `src/prompts/defaults.ts`
- `src/prompts/nudge.ts`
- `src/lifecycle.ts`
- `src/runtime.ts`
- `src/commands/context.ts`
- `src/commands/debug.ts`
- `src/commands/index.ts`
- `src/config/defaults.ts`
- `test/integration/lifecycle.test.ts`
- `test/unit/cache-snapshot-v2.test.ts`
- `test/golden/providers.test.ts`
- `test/golden/projection.test.ts`

OpenCode DCP source and tests:

- `index.ts`
- `README.md`
- `lib/hooks.ts`
- `lib/message-ids.ts`
- `lib/messages/inject/inject.ts`
- `lib/messages/prune.ts`
- `lib/messages/sync.ts`
- `lib/prompts/system.ts`
- `lib/prompts/compress-range.ts`
- `lib/prompts/context-limit-nudge.ts`
- `lib/prompts/turn-nudge.ts`
- `lib/prompts/iteration-nudge.ts`
- `lib/prompts/extensions/tool.ts`
- `lib/compress/pipeline.ts`
- `lib/compress/search.ts`
- `lib/compress/range-utils.ts`
- `lib/compress/range.ts`
- `lib/commands/compression-targets.ts`
- `lib/commands/manual.ts`
- `tests/compress-range.test.ts`
- `tests/message-ids.test.ts`

Pi host documentation consulted:

- Pi extension lifecycle and tool documentation.
- Pi session format and `SessionManager` documentation.

### 1.2 Redaction and privacy

The session contains encrypted reasoning payloads. They were not used in this analysis. Credentials, full raw tool outputs, summaries, paths inside sensitive content, and provider secrets are not reproduced here.

## 2. Forensic analysis of the failed session

### 2.1 Session identity and timing

Session file:

```text
/home/vflores/.pi/agent/sessions/--home-vflores-repos-breakfast_conquer--/2026-08-16T11-47-27-964Z_01a00a65-f05b-75a2-b877-a96f1282ace9.jsonl
```

The session header timestamp is:

```text
2026-08-16T11:47:27.964Z
```

The compression attempt occurred on the following day at approximately:

```text
2026-08-17T17:20:38Z
```

Commit `e7c9cc97` (`Fix bug in dcp`) was committed at:

```text
2026-08-16T23:01:06+02:00
```

The session contains no `/reload` or `dcp reload` request. Therefore the session was long-running and did not load that later fix.

### 2.2 Provider and model used by the session

A scan of all assistant messages found:

```text
provider: openai-codex
model:    gpt-5.6-luna
api:      openai-codex-responses
```

This tuple appeared in 309 assistant messages.

### 2.3 pi-dcp operations before compression

The session contains 18 `pi-dcp.v2.operation` custom entries:

- 12 `tools.pruned` operations.
- 5 `nudge.requested` operations.
- 0 `compression.created` operations.

The pruning operations included deduplication and old-error-input pruning. The nudge operations were soft nudges at configuration generations 5, 7, and 8.

The absence of a `compression.created` entry confirms that no compression mutation succeeded in the session.

### 2.4 Exact compression sequence

The relevant sequence is:

1. **Line 658:** the user asked:

   ```text
   Please perform one faithful pi-dcp compression now using the current local aliases.
   ```

2. **Lines 660–675:** the agent performed manual filesystem and JSONL inspection to find possible aliases.

3. **Line 676:** the agent made one `compress` tool call with:

   ```text
   topic: Initial Phase 5 bootstrap and design handoff
   startId: m0227
   endId:   m2109
   ```

4. **Line 677:** pi-dcp returned:

   ```text
   pi-dcp: baseline_unavailable (assistant_provenance_missing)
   ```

5. **Line 678:** the agent reported that no context was compressed.

6. **Line 679:** another soft nudge operation was recorded after the failed attempt.

There is exactly one persisted assistant entry containing the compression tool call, and exactly one matching tool result. The failure is therefore not caused by an absent persisted tool call or a duplicate persisted tool-call ID in the session file.

### 2.5 Agent effort spent discovering a range

The agent made eight relevant inspection/search calls after the user requested compression:

1. Inspected environment variables.
2. Read the beginning of the session JSONL.
3. Counted session lines.
4. Searched an incorrect path containing an underscore instead of the correct hyphenated session-directory name.
5. Retried the search using the correct path and collected `bNNNN` strings.
6. Requested additional block-like strings.
7. Searched specifically for `mNNNN` strings.
8. Searched the JSONL around the discovered IDs.

The agent ultimately used two IDs, `m0227` and `m2109`, from that raw-file search.

This is the primary usability failure: the extension told the model to use aliases but did not make the aliases available in a trustworthy, actionable form. The model compensated by searching the session file, which is not a valid alias-discovery mechanism.

### 2.6 Why the selected IDs were not reliable aliases

Current pi-dcp aliases are allocated in `src/identity/snapshot.ts` from protocol-unit ordinals. They are not Pi JSONL line numbers, entry IDs, or arbitrary strings found anywhere in the conversation.

The selected range was suspect for several reasons:

- The session has only 645 message entries, while `m2109` implies a much later protocol-unit ordinal.
- No compression operation existed to establish active `bNNNN` blocks.
- The strings found by grep could have originated from tool output, documents, prior assistant text, or other context content.
- There was no verified current pi-dcp alias catalog associated with the provider request.

The recorded failure did not yet reach alias/range validation. If provenance had been available, the likely next failure would have been `range_invalid` or another baseline/range mismatch.

## 3. Root causes

### 3.1 Primary root cause: unsupported provider adapter

`src/transform/adapters.ts` currently certifies:

```text
openai-completions
openai-responses
opencode-cli-runner
 test
```

It does not certify:

```text
openai-codex-responses
```

`src/transform/pipeline.ts` asks `adapterForModel()` for the active model API. When the adapter is missing, it fails closed with `provider_adapter_unsupported` before the pipeline can publish a baseline.

The relevant behavior is conceptually:

```ts
const adapter = adapterForModel({ api: options.ctx.model?.api || "unknown" });
if (!adapter) return failure(fallback, state, "provider_adapter_unsupported");
```

This means the request receives the untouched fallback context and no successful baseline.

However, `src/lifecycle.ts` activates the `compress` tool based on runtime validity and permission, not on whether the current request has a usable adapter/baseline. Nudge scheduling also proceeds independently of alias readiness.

Result:

1. The model receives compression guidance.
2. The model is encouraged to compress.
3. The model does not receive usable aliases.
4. The compression tool has no baseline with which to authorize the call.
5. The tool returns `baseline_unavailable`.

This is the primary defect because even a freshly reloaded session would still fail on this provider API until the adapter is certified.

### 3.2 Secondary root cause: stale runtime and missing provenance recovery

Before commit `e7c9cc97`, compression relied only on the ephemeral map populated by the `tool_call` lifecycle hook.

The newer implementation added `recoverProducingBaseline()`, which can recover a baseline from a uniquely persisted assistant entry containing the current `compress` call. The session started before this commit and did not reload.

The old behavior therefore could fail when:

- the `tool_call` hook did not run;
- the binding was missed during event ordering or reload;
- the in-memory map was cleared;
- the session was using an older loaded module after source updates.

The session’s `assistant_provenance_missing` response is consistent with this stale-runtime condition. It is a downstream symptom in this particular trace because the unsupported adapter had already prevented a valid baseline from being published.

### 3.3 Lifecycle gating defect

Compression readiness is currently represented indirectly by `runtime.valid`, permission, and the presence of a baseline. These are not equivalent.

`runtime.valid` can be true while:

- the active API has no certified adapter;
- the latest context transform failed closed;
- no aliases were published for the current request;
- a prior baseline is retained but is not applicable to the current provider request.

The extension needs an explicit readiness state instead of encouraging compression whenever the extension is generally valid.

### 3.4 Prompt/usability defect

Current system guidance is concise:

```text
local mNNNN labels identify protocol units and bNNNN labels identify active summaries...
```

It does not explain:

- where the labels appear in the actual content;
- that the model must use labels from the current provider request only;
- that it must not inspect the raw session JSONL to invent labels;
- how tool-call/result protocol units are grouped;
- how to choose a safe closed range;
- how to handle nested summaries;
- what to do when labels are absent.

The manual command is similarly underspecified:

```text
Please perform one faithful pi-dcp compression now using the current local aliases.
```

That wording assumes the aliases are visible and current. In the failing request, that assumption was false.

### 3.5 Inline visibility defect

`src/transform/blocks.ts` creates hidden custom unit messages such as:

```text
[pi-dcp unit m0001: user intent]
```

These annotations are separate messages before the corresponding canonical messages. They are better than a completely absent catalog, but they are less salient and more fragile than attaching the ID directly to the content it identifies.

OpenCode instead appends a stable `<dcp-message-id>` tag directly to message content and tool parts. This makes it much easier for the model to see which ID belongs to which message.

The OpenCode approach should be adapted where Pi/provider wire goldens prove that it preserves provider protocol and cache requirements.

### 3.6 Alias semantics are not host entry IDs

Pi-dcp’s `mNNNN` labels are ephemeral aliases over protocol units. They are not the JSONL `id` fields. OpenCode similarly distinguishes model-visible aliases from raw host IDs, but its extension maintains a persistent raw-ID-to-alias map and resolves calls against freshly fetched host messages.

Pi-dcp must continue to keep aliases non-canonical. The improvement is not to make `mNNNN` durable; it is to make the current alias mapping visible, stable during a request, and easy to resolve against the producing baseline.

## 4. OpenCode DCP behavior

### 4.1 Stable raw identity plus model-visible aliases

OpenCode’s `lib/message-ids.ts` maintains two maps:

- raw OpenCode message ID -> `mNNNN` alias;
- `mNNNN` alias -> raw OpenCode message ID.

The aliases are allocated monotonically and retained in session state. Native compaction resets the mapping intentionally, because the visible conversation has changed.

OpenCode does not treat aliases as canonical identity. They are presentation references. Canonical resolution happens through the raw message IDs stored in the extension state and refreshed from the host transcript.

### 4.2 Inline ID injection

`lib/messages/inject/inject.ts` appends ID tags directly to message content:

```xml
<dcp-message-id>m0007</dcp-message-id>
```

The extension injects IDs into:

- user text parts;
- assistant text parts;
- assistant tool parts;
- all visible messages eligible for compression.

For an assistant/tool exchange, the same logical unit remains identifiable across its parts.

This is more usable than presenting a detached catalog because the model can inspect the history naturally and copy the ID immediately adjacent to the desired boundary.

### 4.3 Strong compression prompts

OpenCode’s `lib/prompts/system.ts` frames compression as high-fidelity crystallization, not deletion. It explicitly says to compress only closed work and not compress details needed immediately for exact edits or references.

`lib/prompts/compress-range.ts` adds detailed rules for:

- exhaustive technical summaries;
- preserving user intent;
- quoting short user messages when useful;
- valid boundary IDs;
- no invented IDs;
- inclusive ranges;
- nested block placeholders;
- placeholder uniqueness;
- batching independent ranges.

The extension’s prompt is long because it encodes the selection protocol directly into the model interface. This is appropriate for a tool whose correctness depends on model-selected boundaries.

### 4.4 Fresh execution-time context

OpenCode’s `lib/compress/pipeline.ts` calls `prepareSession()` before mutation. `prepareSession()`:

1. refreshes manual mode;
2. checks compression permission;
3. asks the host permission layer;
4. fetches the current host session messages;
5. initializes state if needed;
6. assigns/rebuilds message references;
7. recalculates pruning state;
8. builds a fresh search context.

The tool then resolves model-provided aliases against this fresh host transcript through `lib/compress/search.ts` and `lib/compress/range-utils.ts`.

OpenCode therefore does not rely exclusively on one short-lived global snapshot that may be overwritten by another context transform.

### 4.5 Nested summary handling

OpenCode validates and expands nested `(bN)` placeholders. It can also append required block summaries when the model omitted them, while preserving the complete previous summary content.

This lowers the probability that a mostly-correct compression call fails due to a missing nested reference.

### 4.6 Clear manual command behavior

OpenCode’s `/dcp-compress` command creates a real model-visible trigger. Its manual prompt explicitly says:

- manual compression is required;
- find significant completed conversation content;
- follow the active mode;
- preserve critical implementation details;
- choose safe targets;
- return after compression.

The prompt also includes current block guidance where needed.

## 5. Proposed design

## 5.1 P0: provider and readiness correctness

### 5.1.1 Certify `openai-codex-responses`

Add a named adapter for `openai-codex-responses` only after provider-wire validation.

Certification must cover:

- ordinary user/assistant messages;
- assistant tool calls;
- tool results;
- custom summary messages;
- pending/partial protocol forms;
- aliases and nested summaries;
- provider payload validation;
- deterministic repeated transforms;
- append-prefix behavior.

Do not treat adding the API string to the map as sufficient certification.

### 5.1.2 Add explicit alias readiness

Add runtime state that distinguishes extension validity from current request readiness. For example:

```ts
type AliasReadiness =
  | {
      ready: true;
      adapterId: string;
      baselineHash: string;
      generation: number;
    }
  | {
      ready: false;
      reason:
        | "provider_adapter_unsupported"
        | "projection_unsupported"
        | "join_ambiguous"
        | "protocol_invalid"
        | "alias_overflow";
      adapterId?: string;
    };
```

Store the latest readiness result in `DcpRuntime` as diagnostics/state, not as canonical session state.

### 5.1.3 Gate compression surfaces

If the latest request cannot publish a baseline/aliases:

- do not emit a compression nudge;
- do not present manual compression as available;
- keep the tool defensively rejected if Pi requires it to remain registered;
- ideally remove `compress` from the active tool set while unavailable;
- report the concrete reason.

A recommended tool result is:

```text
pi-dcp compression unavailable: provider_adapter_unsupported (openai-codex-responses). No aliases were published. Reload after updating pi-dcp or switch to a certified model; do not inspect the session JSONL for aliases.
```

This is more useful than `baseline_unavailable (assistant_provenance_missing)`, which describes the final symptom rather than the first actionable cause.

### 5.1.4 Do not retain stale authorization after failure

When `transformContext()` receives a failed transform result:

- clear any unrelated authorization slot for that request;
- record the failure reason and adapter;
- do not leave a previous baseline presented as current;
- ensure nudges and manual commands observe the failed readiness state.

The baseline registry may retain valid historical baselines for in-flight calls, but current readiness must be explicit and separate.

## 5.2 P0: provenance and baseline handling

Retain the newer `recoverProducingBaseline()` behavior from `e7c9cc97`, but strengthen it.

The tool should:

1. locate exactly one active-branch assistant entry containing the current `compress` call;
2. recover the baseline associated with that assistant entry’s parent;
3. validate model, generation, config, branch, and canonical history hash;
4. resolve aliases against that recovered baseline, not a mutable global “latest snapshot”;
5. fail with an explicit provenance error only when the baseline genuinely cannot be recovered.

The registry should support:

- repeated equivalent transforms;
- an in-flight request surviving a later equivalent transform;
- permission confirmation delays;
- lookup by assistant parent;
- bounded cleanup after settlement;
- pinning while a compression call is executing.

### 5.2.1 Improve error classification

Use a first-failure hierarchy such as:

```text
provider_adapter_unsupported
projection_unsupported
join_ambiguous
protocol_invalid
alias_unavailable
baseline_unavailable
baseline_identity_mismatch
history_changed
range_invalid
content_protected
summary_invalid
```

A missing baseline should not hide a prior provider-adapter failure.

## 5.3 P1: model-facing alias usability

### 5.3.1 Inline labels

Adapt OpenCode’s inline tag approach to Pi/provider adapters.

Conceptual form:

```text
<pi-dcp-message-id>m0042</pi-dcp-message-id>
```

Place the label directly adjacent to the first provider-visible content of each protocol unit. For tool exchanges, repeat the unit label on the assistant call and associated result content where the provider allows it.

Requirements:

- deterministic content;
- no random IDs or timestamps;
- no canonical durable IDs exposed unnecessarily;
- no insertion between assistant calls and tool results;
- no invalidation of provider protocol structure;
- adapter-specific provider-wire tests;
- labels available exactly where the model reads the history.

The existing separate `pi-dcp.v2.unit` custom messages may remain as an adapter fallback if inline labels are unsafe for a provider.

### 5.3.2 Make the no-alias state explicit

If annotations cannot be inserted, the prompt must not claim that aliases are available. The model should receive either:

```text
Compression is unavailable for this request because pi-dcp could not publish safe local aliases.
```

or no compression guidance/tool at all.

### 5.3.3 Keep alias identity ephemeral

Do not persist `mNNNN`/`bNNNN` as canonical operation references. Persist only:

- Pi entry IDs;
- tool-call IDs;
- durable block IDs;
- coverage and anchors;
- internal baseline hashes.

This preserves branch safety and allows aliases to be reallocated after a real context transition.

## 5.4 P1: OpenCode-quality prompts

Replace the short current guidance with a detailed but stable prompt contract.

### 5.4.1 System guidance should explain

- compression is for closed, resolved work;
- compression is authoritative and must be exhaustive;
- preserve user intent, constraints, decisions, exact paths, and verification results;
- do not compress active work, unresolved questions, pending tool exchanges, or details needed immediately;
- `mNNNN` identifies protocol units, not arbitrary JSONL entries;
- `bNNNN` identifies active summaries;
- boundaries must be copied from visible current context;
- never invent aliases;
- never search the session file for aliases;
- if aliases are absent, do not call `compress`;
- tool calls and results must be selected as one complete protocol unit.

### 5.4.2 Compression tool description should explain

- inclusive range semantics;
- `startId` must precede `endId`;
- ranges must not overlap;
- summary requirements;
- nested `(bNNNN)` placeholder rules;
- placeholder uniqueness;
- how block boundaries are handled;
- that the call is validated against the producing assistant response baseline.

### 5.4.3 Manual compression request

Use a trigger similar to:

```text
Perform exactly one pi-dcp compression pass now.

Choose one or more older, resolved ranges from the visible conversation only.
Use only current visible mNNNN or bNNNN labels; do not inspect the session JSONL
or invent IDs. Keep the latest user intent, active work, unresolved questions,
pending tool exchanges, and protected content out of the selected range. Write an
exhaustive technical summary preserving decisions, constraints, paths, findings,
and verification evidence. If no safe visible labels are available, do not call
compress and report that compression is unavailable.
```

A focus string may be appended after these stable instructions.

## 5.5 P1: OpenCode-style execution preparation

Pi cannot fetch a remote host transcript in the same way OpenCode can, but it can prepare equivalent canonical data from `SessionManager`.

Before compression mutation:

1. read `buildContextEntries()` once;
2. project canonical entries;
3. join the projection to the current outgoing context;
4. build protocol units;
5. recover the producing baseline;
6. resolve aliases against the baseline;
7. validate ranges and protection;
8. expand nested summaries;
9. build the complete operation;
10. append exactly one self-contained operation.

If context has changed during permission confirmation, recompute all validation. Equivalent transforms should not invalidate the call; real branch/model/config/history changes should.

## 5.6 P1: improve nested-block tolerance

Retain the existing nested-summary safeguards and align their behavior with OpenCode:

- detect active blocks wholly inside a selected range;
- require or automatically append their complete stored summaries;
- reject blocks only partially intersected by a range;
- expand `(bNNNN)` placeholders exactly once;
- reject unknown/duplicate/out-of-scope placeholders;
- enforce depth and expanded-size limits;
- preserve protected content by canonical tool-call ID rather than text matching.

## 5.7 P2: runtime diagnostics and stale-code visibility

Add the following to `/dcp debug`:

```text
runtime version:       0.2.0 / commit-or-build-id
runtime loaded at:     <internal timestamp, UI only>
active model:          openai-codex/gpt-5.6-luna
active API:            openai-codex-responses
adapter:               unsupported
compression readiness: unavailable
last transform:        provider_adapter_unsupported
last baseline:         none
retained baselines:    <count>
recommendation:        update/reload pi-dcp or switch to a certified API
```

The normal log must remain privacy-safe. Do not log summaries, paths, arguments, raw message content, credentials, or full provider payloads.

A one-time UI warning should explain when the extension is loaded but the active API is not certified.

## 6. Architecture changes

### 6.1 Separate three identities

The current design combines several concepts. They should remain conceptually separate:

1. **Canonical baseline** — immutable branch/context/model/config state before the assistant response.
2. **Provider annotation** — deterministic model-visible `mNNNN`/`bNNNN` labels.
3. **Execution authorization** — proof that the current tool call came from an assistant response produced from the baseline.

A provider-visible alias is not an authorization token. The model should not need to echo a random snapshot ID when Pi already knows which assistant response generated the tool call.

### 6.2 Baseline registry

Continue using a bounded registry rather than one mutable current snapshot:

```ts
interface BaselineRegistry {
  byAssistantParent: Map<string | null, BaselineSnapshot[]>;
  byProjectionHash: Map<string, BaselineSnapshot>;
  byHash: Map<string, BaselineSnapshot>;
  order: BaselineSnapshot[];
  pinned: Set<string>;
  maxEntries: number;
}
```

A registry entry is an authorization aid, not canonical state. The tool must still recompute and validate the branch projection before appending.

### 6.3 Request readiness

Add a runtime field such as:

```ts
lastReadiness?: {
  ready: boolean;
  reason?: string;
  adapterId?: string;
  baselineHashPrefix?: string;
  generation: number;
};
```

`runtime.valid` should mean only that the extension/session state is usable. It should not imply that the current provider request has a compression baseline.

### 6.4 Tool activation

At session start and model selection:

- inspect the active API;
- keep `compress` active only if the configuration permits it and the API is certified;
- defensively recheck readiness at execution time;
- reactivate after a successful supported transform or model switch.

If Pi requires the tool to remain registered for schema stability, it can remain registered but should be removed from the active set and return a clear capability error if called through stale history.

## 7. Test plan

## 7.1 Reproduce the captured failure

Add a fixture derived from the captured session’s metadata and relevant final call, with content redacted.

The regression must assert:

1. active API `openai-codex-responses` is detected;
2. the adapter/readiness state is unavailable before certification;
3. `compress` is not advertised or is defensively rejected;
4. no misleading compression nudge is emitted;
5. the result names `provider_adapter_unsupported` rather than only `assistant_provenance_missing`.

After certification, the same fixture should assert:

1. a successful transform publishes aliases;
2. the persisted assistant call recovers its baseline;
3. `m0227..m2109` is rejected as unavailable/invalid when it is not present in the current baseline;
4. a range using actual visible aliases succeeds.

## 7.2 Adapter tests

For `openai-codex-responses`, add fixtures for:

- text-only conversation;
- user/assistant/tool protocol;
- multiple tool calls and results;
- custom summary messages;
- incomplete/pending forms;
- image content if supported;
- thinking blocks if supported;
- nested summaries;
- labels on all supported provider-visible locations.

Each fixture should validate:

- provider payload shape;
- role ordering;
- tool-call/result pairing;
- deterministic serialization;
- absence of random IDs/timestamps;
- alias visibility;
- no insertion inside a protocol exchange.

## 7.3 Baseline/provenance tests

Add tests for:

1. equivalent transforms followed by compression from the first request;
2. equivalent transforms while permission confirmation is pending;
3. persisted assistant call recovery without an early `tool_call` hook;
4. missing persisted assistant entry;
5. duplicate persisted tool-call IDs;
6. changed assistant parent;
7. unrelated descendant/user message insertion;
8. branch navigation during confirmation;
9. model change during confirmation;
10. config generation change;
11. native compaction between request and tool execution;
12. reload while a compression call is in flight;
13. stale old-schema calls after reload.

## 7.4 Alias usability tests

Add tests that assert:

- every visible compressible protocol unit has an adjacent label;
- the same tool exchange has consistent unit labeling;
- aliases are copied from current context rather than raw session IDs;
- ordinary appended history preserves old labels;
- aliases are not emitted when the adapter is unsupported;
- a model-facing prompt explicitly says not to inspect JSONL files;
- no label catalog is accidentally sourced from assistant/tool output text.

## 7.5 Prompt tests

Test prompt text as stable fixtures. Assert it contains requirements for:

- closed/resolved selection;
- exhaustive summaries;
- user-intent fidelity;
- visible current IDs only;
- no invented IDs;
- no raw-session-file inspection;
- complete protocol units;
- nested placeholders;
- no compression when aliases are absent.

## 7.6 Lifecycle tests

Add tests for:

- unsupported adapter at startup;
- model selection to a supported adapter;
- model selection to an unsupported adapter;
- failed transform clearing current readiness;
- nudge suppression when no baseline is available;
- manual command behavior when compression is unavailable;
- `/dcp debug` output containing adapter/readiness details;
- `/reload` making the loaded runtime version visible.

## 7.7 Existing test command

The current targeted tests pass:

```text
npm test -- --reporter=dot test/integration/lifecycle.test.ts test/unit/cache-snapshot-v2.test.ts

2 test files passed
15 tests passed
```

This coverage is insufficient for the captured failure because it does not exercise `openai-codex-responses`. The new regression must be added before implementation is considered complete.

## 8. Implementation phases

### Phase 1: lock the failure

- Add the captured-session regression fixture.
- Add an adapter readiness test for `openai-codex-responses`.
- Make the test fail before the implementation change.
- Add tests proving no compression guidance/nudge is emitted without readiness.

### Phase 2: provider support

- Implement the Codex Responses adapter.
- Add provider-wire fixtures.
- Validate protocol and append-prefix behavior.
- Enable compression only after the adapter tests pass.

### Phase 3: readiness and diagnostics

- Add explicit readiness state.
- Gate tool activation, prompts, manual commands, and nudges.
- Improve failure reason ordering.
- Add `/dcp debug` adapter/build/readiness fields.

### Phase 4: provenance hardening

- Retain and extend execute-time persisted-call recovery.
- Add baseline registry tests.
- Make permission confirmation resilient to equivalent transforms.
- Reject only actual history/model/config/branch changes.

### Phase 5: alias transport usability

- Implement inline labels for certified adapters.
- Keep separate custom unit messages only as a tested fallback.
- Update system guidance and tool descriptions.
- Explicitly prohibit raw JSONL alias searches.

### Phase 6: OpenCode-quality compression semantics

- Expand selection and summary prompts.
- Improve nested-block placeholder handling.
- Improve protected-content explanations.
- Add safe range suggestions to `/dcp context` or a model-visible status surface where possible.

### Phase 7: session soak and cache measurement

Compare:

1. pi without pi-dcp;
2. current pi-dcp;
3. refactored pi-dcp;
4. refactored pi-dcp with compression transitions;
5. refactored pi-dcp with pruning transitions.

Measure:

- first changed provider message/token;
- cache read/write usage;
- transform latency;
- alias overhead;
- compression success rate;
- number of model retries caused by invalid ranges/provenance.

## 9. Non-goals and constraints

The refactor must preserve:

- append-only Pi session history;
- non-destructive outgoing-context transformation;
- canonical operation state based on Pi branch entries;
- complete tool-call/result protocol units;
- model-authored summaries;
- fail-closed behavior on ambiguous mapping;
- privacy-safe logging;
- explicit permission handling;
- branch isolation.

The refactor should not:

- make `mNNNN` or `bNNNN` durable canonical IDs;
- mutate Pi’s raw message entries;
- silently infer aliases from arbitrary text;
- use a session file search as a normal model workflow;
- advertise unsupported providers;
- claim that compression is available merely because the extension loaded;
- promise cache stability across native compaction, model changes, branch changes, configuration changes, or intentional pruning/compression transitions.

## 10. Acceptance criteria

The refactor is complete when:

1. `openai-codex-responses` has a certified provider adapter with wire tests.
2. The captured session’s first actionable failure is reported as unsupported adapter/readiness, not only missing provenance.
3. Compression is not advertised when aliases/baseline publication failed.
4. Nudges are suppressed when compression is unavailable for the current request.
5. A valid supported request publishes visible current aliases.
6. The model no longer needs to inspect raw JSONL to discover ranges.
7. Aliases are locally adjacent to the content they identify.
8. Prompts explicitly forbid invented IDs and raw JSONL alias searches.
9. The stale runtime condition is visible through `/dcp debug` and `/dcp status`.
10. A persisted assistant call can recover its baseline after the early provenance hook is missed.
11. Equivalent context transforms do not invalidate an in-flight valid compression call.
12. Real history, branch, model, config, or generation changes still fail closed.
13. Nested compressed blocks are preserved and validated safely.
14. The captured session regression and all provider/lifecycle tests pass.
15. Compression success rate is measured on real supported Pi sessions.

## 11. Final recommendation

The first implementation should not begin with a broad rewrite of compression semantics. The highest-leverage sequence is:

1. certify `openai-codex-responses`;
2. gate compression and nudges on actual alias readiness;
3. add the captured-session regression;
4. expose runtime/adapter diagnostics;
5. improve inline labels and prompts;
6. then deepen provenance and nested-summary behavior.

The OpenCode extension works well not because it avoids all complexity, but because it makes the compression contract visible and operational:

- stable raw identity is maintained by the extension;
- model-visible IDs sit beside the content they identify;
- the tool resolves selections against fresh current host state;
- prompts explain the full selection protocol;
- nested summaries are preserved defensively;
- manual compression produces a clear model-visible trigger.

pi-dcp should adopt those usability and execution principles while retaining Pi-specific strengths: append-only custom operations, branch-aware reconstruction, immutable outgoing transforms, and baseline authorization tied to the producing assistant response.
