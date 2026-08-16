# pi-dcp Cache and Snapshot Redesign

**Status:** proposed clean-break redesign
**Scope:** provider-cache stability, context snapshot identity, compression execution, nudges, and closely related correctness defects
**Target:** the next incompatible pi-dcp protocol version
**Audited implementation:** current `pi-dcp` working tree, version `0.1.0`

## 1. Executive summary

The current pi-dcp design creates a new random, expiring, model-visible snapshot for every provider request. Pi runs the `context` transformation before every assistant request, so equivalent context is serialized differently on every pass. The same behavior can overwrite the snapshot that authorized an in-flight model response, causing otherwise valid `compress` calls to fail with `snapshot_id_mismatch`.

These are not independent bugs. Both come from treating a transformation invocation as snapshot identity instead of treating the canonical conversation baseline as identity.

A narrow change such as reusing a random snapshot or replacing its ID with a hash would reduce failures, but it would not meet the required cache invariant. The current metadata message also contains a growing alias catalog, moves to the latest user boundary, and is accompanied by token-dependent transient nudges. Those mutations prevent the transformed prompt from remaining append-only as ordinary conversation grows.

This redesign makes four deliberate choices:

1. **Implicit baseline authorization.** The model no longer submits a snapshot ID. A compression call is bound to the persisted assistant entry containing that call, its parent baseline, the active branch, the model/config generation, and a recomputed canonical history hash.
2. **Append-stable local aliases.** A global per-request metadata catalog is replaced by deterministic labels attached locally to protocol units. Existing transformed units remain byte-stable when new conversation is appended.
3. **Persisted nudges.** Threshold decisions are journaled, then materialized on the next user request as persistent `custom_message` entries returned from `before_agent_start`. They are never transiently inserted into earlier context.
4. **Clean protocol break.** The old model-visible `snapshotId` tool schema and version-1 operation protocol are not maintained as compatibility constraints. Existing raw history remains safe and immediately usable, but old DCP operations are not silently interpreted as new protocol state.

The central acceptance criterion is:

> For each explicitly certified Pi/provider adapter, and in the absence of a compression-state transition, tool pruning, branch navigation, model/configuration changes, native compaction, or another extension's payload rewrite, extending conversation history may only append to pi-dcp's canonical wire representation. pi-dcp must not cause an earlier divergence than Pi would produce without the extension.

A compression-state transition includes creating a summary and explicitly decompressing or recompressing one. Decompression/recompression necessarily changes earlier effective history and is therefore the same unavoidable cache-invalidation class as compression creation, even though it is user-initiated rather than a new summary.

This guarantee is deliberately adapter-scoped. Pi and provider adapters may merge roles or normalize message boundaries, so no extension can promise that arbitrary providers serialize one request as a literal byte prefix of the next. Version 2 must certify the property for named Pi/provider versions and fail closed or disable alias-based compression on uncertified paths.

## 2. Audit scope and evidence

The audit covered:

- Pi's agent-loop context-transform timing;
- pi-dcp lifecycle hooks and runtime state;
- canonical projection, joining, and protocol-unit construction;
- snapshot creation, serialization, publication, and validation;
- compression schema, tool execution, range validation, and operation persistence;
- block replacement, persisted tool redaction, nudges, and automatic pruning;
- branch reconstruction, reducer behavior, tests, and design documents.

Validation of the audited tree:

- `npm test -- --reporter=dot`: 14 files and 33 tests passed;
- `npm run typecheck`: passed.

The working tree contained pre-existing uncommitted changes. This audit did not modify them.

## 3. Current architecture

### 3.1 Request pipeline

Pi calls `transformContext` immediately before each assistant provider request:

- installed `pi-agent-core/dist/agent-loop.js:178-185`;
- installed coding-agent `dist/core/sdk.js:219-224`.

pi-dcp registers its context hook in `src/lifecycle.ts:34` and executes the outgoing pipeline under a runtime mutex in `src/lifecycle.ts:40`.

The pipeline in `src/transform/pipeline.ts:21-47`:

1. projects Pi context entries to canonical messages;
2. joins that projection to the incoming `AgentMessage[]`;
3. groups messages into indivisible protocol units;
4. reconciles block availability;
5. creates a snapshot;
6. replaces active compressed blocks;
7. applies persisted tool redactions;
8. evaluates a threshold nudge;
9. inserts the nudge and snapshot metadata;
10. validates the transformed protocol and publishes the snapshot.

### 3.2 Canonical state

Persistent state is represented by append-only `pi-dcp.operation` custom entries. These do not participate in model context. `reconstructFromBranch()` replays only operations on the selected branch, and `reduceEnvelope()` provides operation-ID and request-key idempotency checks.

This part of the design is fundamentally sound and should remain the basis of the next version.

### 3.3 Current snapshot transport

`createSnapshot()` in `src/identity/snapshot.ts:10-22` allocates aliases and stores:

- random `snapshotId`;
- session and leaf IDs;
- model key;
- runtime generation;
- `createdAt` and `expiresAt`;
- ordered units and content hash;
- unit and block alias maps.

`metadataMessage()` in `src/transform/metadata.ts:10` exposes the random ID, expiry, complete unit-alias catalog, and complete active-block catalog to the model. The `compress` schema requires the same ID in `src/compression/schema.ts:3-15`.

The runtime stores only one current snapshot in `DcpRuntime.snapshot`.

## 4. Findings

### 4.1 Critical: equivalent transforms are not deterministic

Every successful transform creates a snapshot even when canonical history, state, configuration, model, and generation are unchanged:

- `src/transform/pipeline.ts:38`.

The snapshot contains a new random ID and wall-clock timestamps:

- `src/identity/snapshot.ts:10-22`;
- `src/util/hash.ts:16-18`.

The ID and expiry are provider-visible:

- `src/transform/metadata.ts:10`.

Therefore equivalent transformations cannot be byte-identical.

`TransformOptions.currentSnapshot` exists but is never read. Its presence suggests intended reuse, but the implementation always supersedes it:

- declaration: `src/transform/pipeline.ts:19`;
- unconditional replacement: `src/transform/pipeline.ts:38`.

### 4.2 Critical: metadata breaks append-only prompt prefixes

The defect is broader than randomness.

The metadata contains the full current alias catalog, so its body grows when new units are appended. `insertMetadata()` also relocates the metadata immediately before the latest user unit:

- `src/transform/metadata.ts:10,31`.

On request N, metadata appears before the latest user at N. On request N+1, that old transient message is absent and a different message appears before the new latest user. The provider-visible sequence diverges at the previous user boundary instead of appending after the previous request.

OpenAI's cache is prefix-based. It can only reuse content before the first differing token. Depending on provider minimums and cache granularity, this late-prefix divergence can report as zero cached tokens even though an earlier prefix remains identical.

The precise guarantee violated by pi-dcp is not necessarily “every byte of the prompt changes.” It is:

> pi-dcp unconditionally destroys prefix continuity at a prior conversation boundary.

### 4.3 Critical: a single mutable snapshot causes false mismatches

After each transform, `runtime.snapshot` is overwritten:

- `src/lifecycle.ts:40`.

The compression tool accepts only the currently stored snapshot and requires exact equality with the model-provided random ID:

- `src/compression/tool.ts:31-35,43-47`.

A valid sequence can therefore be:

1. transform A publishes random snapshot A;
2. provider request A receives A;
3. an equivalent context pass publishes random snapshot B;
4. the model response to request A invokes `compress` with A;
5. runtime holds B and returns `snapshot_stale (snapshot_id_mismatch)`.

Equivalent context should denote the same authorization baseline. The current implementation instead gives each transformation invocation a mutually exclusive identity.

### 4.4 High: permission confirmation magnifies the snapshot race

For `permission: "ask"`, execution validates once, releases the mutex, awaits UI confirmation, reacquires the mutex, and validates again:

- `src/compression/tool.ts:30-48`.

Two-phase validation is correct in principle, but any equivalent context transform during the confirmation window replaces the one runtime snapshot. The second validation can reject unchanged history solely because a new random ID was published.

### 4.5 Medium: current-leaf validation is unnecessarily coupled to tool-batch ordering

`validateCurrentHistory()` allows the assistant entry containing the current tool call to be appended after the snapshot baseline. It expects that assistant entry to be the current leaf and removes only that entry before hashing:

- `src/compression/tool.ts:61-80`.

The current `compress` tool declares `executionMode: "sequential"`, so a sibling result preceding `compress` is not established as the cause of the observed failures. Nevertheless, the validator is coupled to a stronger leaf-order assumption than Pi's documented guarantee. Pi guarantees that session state is synchronized through the assistant tool-calling message; tool-result visibility depends on batch execution mode and ordering.

Validation should bind to the assistant call entry and its parent baseline rather than requiring that entry to remain the leaf. Version-2 tests must characterize the exact sequential behavior and any future parallel/mixed-tool behavior before permitting additional descendant entries.

### 4.6 High: failed transforms retain stale authorization state

When transformation fails closed, the result has no snapshot. `transformContext()` only updates runtime state when `result.snapshot` exists and does not clear the previous snapshot:

- `src/lifecycle.ts:40`.

The model can receive untouched fallback context while the runtime still holds aliases from an older successful request. A failed publication must not leave unrelated global authorization active.

The redesign avoids this class of bug by indexing baselines rather than storing one globally current snapshot.

### 4.7 High: transient nudges independently break cache stability

Nudge presence and text depend on live token usage, context window, turn count, prior nudge turn, thresholds, and model-specific limits:

- `src/transform/pipeline.ts:41-43`;
- `src/transform/metadata.ts:12-28,31`.

The text embeds the measured token count. A nudge may appear, disappear, or change without compression or pruning. It is inserted near historical content rather than persisted as a new session message.

This is incompatible with the required cache invariant.

### 4.8 High: manual compression mutates the system-prefix root

`beforeAgentStart()` appends a one-off manual instruction to the system prompt:

- `src/lifecycle.ts:39`.

A system-prompt mutation changes the earliest and most valuable cache prefix. `/dcp compress` already sends an actual user message requesting compression, so the dynamic system addition is redundant.

### 4.9 High: manual automatic-pruning setting is ineffective

`onSettled()` allows automatic strategy evaluation in manual mode when `manualMode.automaticStrategies` is true:

- `src/lifecycle.ts:51`.

However, `evaluateSettledStrategies()` immediately returns an empty list whenever `state.manualMode` is true:

- `src/strategies/settle.ts:8`.

The configured value therefore cannot enable automatic strategies in manual mode as documented.

### 4.10 High: forked operation ownership can conflict

Operation envelopes persist the originating `sessionId`, and reconstruction rejects an operation whose session ID differs from the current runtime session:

- `src/state/operations.ts:13`;
- `src/state/reconstruct.ts:5`.

Pi forks can copy branch entries into a new session with a new session ID. Replaying inherited pi-dcp operations can consequently mark state corrupt. This conflicts with the stated branch/fork behavior.

The next protocol must define operation ownership in terms of the selected branch lineage, not require copied immutable entries to contain the destination session's future ID.

### 4.11 Medium: transform diagnostics conflate semantic and transport changes

A successful pipeline returns `changed: true` even if it only inserted metadata:

- `src/transform/pipeline.ts:46`.

Operational diagnostics should separately report:

- semantic compression replacement;
- persisted tool redaction;
- deterministic alias annotation;
- newly appended nudge;
- changed-prefix position after provider conversion.

### 4.12 Medium: extension ordering is safe but opaque

The pipeline requires the incoming array length to match the canonical Pi projection:

- `src/transform/pipeline.ts:31`.

An earlier extension that adds or removes a message causes a fail-closed fallback. This is conservative and appropriate, but users need a clear diagnostic that extension ordering disabled DCP for that request.

## 5. Design goals

The new design MUST:

1. preserve Pi's raw session history;
2. keep DCP operations branch-local and append-only;
3. preserve complete assistant tool-call/result protocol units;
4. fail closed on ambiguous canonical mapping;
5. make equivalent transformations byte-identical after every certified provider conversion;
6. prevent pi-dcp from moving the certified provider adapter's natural append-normalization boundary earlier when ordinary history grows;
7. cause earlier historical-prefix changes only when a DCP compression-state transition or tool pruning changes effective history, or when the host itself changes branch/model/configuration/compaction state;
8. authorize compression from canonical request provenance rather than a model-echoed random nonce;
9. support sibling tool execution and permission delays safely;
10. make threshold nudges append-only;
11. provide deterministic, privacy-safe diagnostics and tests.

## 6. Non-goals

The redesign does not promise cache hits when:

- the user or assistant naturally changes the conversation suffix;
- the model, system configuration, context files, or tool schemas change;
- Pi performs native compaction;
- the user navigates to another branch;
- another extension rewrites an earlier provider prefix;
- the provider declines caching for its own policy or minimum-size reasons.

The requirement is that pi-dcp must not introduce an avoidable earlier-prefix divergence.

## 7. Normative cache invariants

### 7.1 Equivalent-input determinism

Given identical:

- canonical built context;
- selected branch;
- reduced DCP state;
- model key;
- safety-relevant configuration;
- active tool set;
- nudge entries already persisted in the branch;

two transformations MUST produce deeply equal `AgentMessage[]` and byte-identical provider payload messages.

No wall-clock value, random value, process-local ordinal, map insertion accident, or mutable runtime counter may enter the provider-visible representation.

### 7.2 Adapter-scoped append-prefix stability

For a certified adapter A, let `wireA(H)` be the adapter's canonical provider representation for history H. If H2 is H1 plus ordinary appended conversation and no DCP/host state transition changes the effective representation, pi-dcp MUST NOT create a divergence in `wireA(H2)` before the normalization boundary Pi/provider A produces without pi-dcp.

Where adapter A naturally serializes appended messages without rewriting its previous boundary, serialized `wireA(H1)` MUST be an exact prefix of serialized `wireA(H2)`. Where A merges or normalizes adjacent roles, the certified contract must define the smallest permitted boundary rewrite and prove that pi-dcp does not move it earlier.

Provider-level differential tests compare Pi with and without pi-dcp. Internal `AgentMessage` equality alone is insufficient.

### 7.3 Expected prefix invalidation

A prior prefix may change when:

- a successful compression operation replaces covered units with a summary;
- a successful tool-pruning operation redacts earlier arguments or results;
- decompression or recompression intentionally changes block activation;
- native compaction, branch navigation, model selection, or safety-relevant configuration changes the host context.

DCP diagnostics MUST identify which category caused the earliest change.

## 8. Proposed architecture

### 8.1 Certification boundary and request provenance

Version 2 supports alias-based compression only on explicitly certified combinations of:

- Pi version and context projection behavior;
- provider API adapter and conversion behavior;
- pi-dcp's position relative to other context-transforming extensions;
- absence of uncoordinated later `before_provider_request` rewrites that remove or alter DCP aliases.

The extension can prove its own canonical transform and inspect its model/API, but it cannot reconstruct arbitrary later extension mutations from session history. Certification therefore records the DCP-transformed request fingerprint used when publishing a baseline. It does not claim to identify the provider's complete cache key, which also includes the system prompt, tools, thinking settings, context files, and provider-specific payload fields outside the `context` hook.

Cache diagnostics compare pi-dcp-on and pi-dcp-off behavior at a provider adapter boundary. Compression authorization proves that aliases came from a retained DCP baseline; it does not attempt to rebuild an arbitrary final payload modified by other extensions.

### 8.2 Separate three identities

The current `ContextSnapshot` combines three concepts that need separate treatment:

1. **Canonical baseline** — immutable branch and context state before an assistant response.
2. **Provider annotation** — deterministic model-facing aliases attached to that baseline.
3. **Execution authorization** — proof that a tool call was produced by an assistant response to that baseline and still applies safely.

The new design uses separate types:

```ts
interface BaselineKey {
  branchIdentity: string;
  leafId: string | null;
  provider: string;
  modelId: string;
  api: string;
  contextWindow: number;
  thinkingLevel: string;
  generation: number;
  configSafetyHash: string;
  projectionHash: string;
  dcpTransformHash: string;
}

interface BaselineSnapshot {
  key: BaselineKey;
  units: readonly SnapshotUnit[];
  unitAliases: ReadonlyMap<string, number>;
  blockAliases: ReadonlyMap<string, BlockId>;
  createdMonotonicMs: number; // internal only
}
```

`createdMonotonicMs` may support bounded in-memory eviction, but it MUST NOT affect provider text, alias allocation, projection hashes, or tool arguments.

`configSafetyHash` covers every pi-dcp setting that changes alias allocation, protection, redaction, block replacement, or tool availability. `generation` changes on model/tool activation, trusted configuration, branch, native compaction, and DCP semantic mutations. System prompt, context files, skills, complete tool schemas, and unrelated provider payload fields are cache-key inputs outside the DCP context baseline; differential wire tests cover their interaction, while compression authorization does not pretend to reconstruct them.

Native message timestamps are excluded from DCP fingerprints and aliases. Certified provider tests must verify whether the provider adapter itself omits or normalizes them.

### 8.3 Runtime stores baselines by identity

Replace:

```ts
snapshot?: ContextSnapshot
```

with a bounded baseline registry:

```ts
interface BaselineRegistry {
  byAssistantParent: Map<string | null, BaselineSnapshot[]>;
  byProjectionHash: Map<string, BaselineSnapshot>;
}
```

The exact collection shape is implementation detail, but it must support:

- repeated equivalent transforms returning the same baseline;
- an in-flight request surviving later equivalent transforms;
- lookup from the assistant tool-call entry's parent;
- bounded cleanup after turns settle, branches change, or sessions shut down.

A registry entry is an optimization, not canonical state. Tool authorization must still recompute and validate history.

### 8.4 No model-visible snapshot ID or expiry

The next `compress` schema is:

```ts
const CompressionParametersV2 = Type.Object({
  topic: Type.String({ minLength: 1, maxLength: 120 }),
  content: Type.Array(Type.Object({
    startId: Type.String({ pattern: "^(m\\d{4}|b\\d{4})$" }),
    endId: Type.String({ pattern: "^(m\\d{4}|b\\d{4})$" }),
    summary: Type.String({ minLength: 1, maxLength: 100000 }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 16 }),
}, { additionalProperties: false });
```

There is no `snapshotId` field.

The model does not need to echo authorization data already implied by the assistant response containing its tool call.

### 8.5 Deterministic local aliases

The global `pi-dcp.metadata` catalog is removed.

Each compressible protocol unit receives a deterministic local annotation. Aliases are assigned from oldest to newest using canonical protocol-unit order. Under ordinary append-only history, all existing aliases remain unchanged and new units receive later aliases.

Conceptual output:

```text
[pi-dcp unit m0001: user intent]
<unit 1 messages>

[pi-dcp unit m0002: assistant response]
<unit 2 messages>

[pi-dcp unit m0003: tool exchange]
<unit 3 assistant call and all results>
```

Active block summaries carry their deterministic `bNNNN` label locally:

```text
[pi-dcp summary b0001; untrusted history]
Topic: ...
...
```

Alias transport is an explicit adapter contract, not one universal message shape:

```ts
interface AliasTransportAdapter {
  annotate(messages: readonly AgentMessage[], units: readonly SnapshotUnit[]): AgentMessage[];
  canonicalWire(messages: readonly AgentMessage[]): unknown;
  validateWire(wire: unknown): { ok: true } | { ok: false; reason: string };
}
```

The preferred transport uses hidden Pi custom messages immediately before units only where provider goldens prove that they remain model-visible and do not move the provider's normalization boundary earlier. A certified fallback attaches a stable text marker to the first provider-visible content block of the unit. If neither transport preserves protocol and cache properties for an API, version 2 disables compression aliases for that adapter and leaves pruning in fail-closed or separately certified mode.

Goldens must prove:

- prior annotations and messages remain stable under the adapter's documented append normalization;
- aliases remain visible to the model;
- consecutive roles are normalized deterministically;
- tool-call/result structure is preserved;
- custom-message details and timestamps do not leak into provider payloads;
- OpenAI Responses, OpenAI Chat Completions, and supported OpenCode bridges are certified separately rather than assumed equivalent.

The adapter-specific wire invariant is normative; the internal annotation representation is not.

### 8.6 Constant guidance

System guidance becomes a fixed string that explains:

- local `mNNNN` and `bNNNN` labels;
- contiguous complete-unit selection;
- semantic closure and protected content;
- summary fidelity and nested placeholders;
- that the tool call is validated against the assistant request baseline.

It MUST NOT mention a short-lived snapshot, latest metadata, expiry, or refreshing a nonce.

The guidance and active tool schema must remain constant throughout a session unless configuration intentionally enables/disables the tool. Dynamic manual instructions must not modify the system prompt.

## 9. Compression authorization algorithm

### 9.1 Establish the producing assistant entry

On `compress.execute(toolCallId, params, ...)`:

1. acquire the runtime mutex;
2. find exactly one active-branch assistant message containing a tool call whose ID equals `toolCallId` and whose name is `compress`;
3. reject duplicate IDs, missing entries, wrong tool names, or entries outside the selected branch;
4. record the assistant entry ID and its `parentId` as the provider-request baseline leaf.

Pi documents that `ctx.sessionManager` is synchronized through the current assistant tool-calling message before tool execution. Sibling results may or may not yet be present, so they cannot define baseline identity.

### 9.2 Recover the baseline

Find a cached `BaselineSnapshot` matching:

- assistant parent leaf;
- current session lineage;
- current model/API/context window;
- current DCP generation and safety configuration.

If the producing baseline is not retained in the registry, reject with `baseline_unavailable` and write no operation. Do not authorize by reconstructing a supposed original provider request from session history: later extension transforms, system-prompt state, tool schemas, and `before_provider_request` rewrites cannot in general be reproduced.

This is safe operationally because a tool call executes in the same live agent run that published its baseline. Registry entries must remain pinned through tool execution and permission confirmation, then may be evicted at settlement. A missing entry indicates reload, lifecycle invalidation, a defect, or an unsupported execution path and should fail closed.

### 9.3 Validate branch continuity

The assistant entry containing `compress` must descend directly from the recovered baseline leaf. For the current sequential tool mode, permitted descendant entries must be derived from observed and tested Pi ordering. Future support for parallel or mixed batches may admit only protocol-valid sibling results whose call IDs occur in that same assistant entry. No generic “execution artifact” category is accepted without a canonical session-entry schema.

Reject when:

- the selected branch no longer contains the assistant entry;
- navigation or native compaction changed its ancestry;
- an unrelated user or assistant message was inserted between the baseline and call;
- DCP generation or safety configuration changed after request creation;
- the model identity differs;
- projection or protocol reconstruction is ambiguous.

Do not require the assistant entry to remain the current leaf.

### 9.4 Recompute baseline hash

Recompute the canonical baseline hash from:

- branch lineage and baseline leaf;
- model key;
- safety configuration hash;
- generation;
- ordered protocol-unit canonical keys;
- content digests and tool-call IDs;
- active block IDs and versions.

It must equal the recovered snapshot hash. The hash remains internal and may be persisted in the resulting operation for audit/idempotency.

### 9.5 Resolve aliases

Resolve `mNNNN` and `bNNNN` against the recovered baseline snapshot—not against the newest context transform.

Then apply existing range, nesting, protection, summary, overlap, and envelope-size validation.

### 9.6 Permission flow

For `permission: "ask"`:

1. perform cheap baseline and parameter validation under the mutex;
2. release the mutex and await confirmation;
3. reacquire the mutex;
4. recover the same baseline from assistant provenance;
5. fully recompute and revalidate before appending.

Equivalent context transforms during confirmation cannot invalidate the call because there is no single mutable current snapshot. Real state changes still reject it.

### 9.7 Commit

On success:

1. build one self-contained version-2 compression operation;
2. synchronously append it;
3. persist best-effort statistics;
4. reduce it into in-memory state;
5. increment generation;
6. clear obsolete baseline-registry entries;
7. notify and return the receipt.

Only this successful semantic replacement is expected to change an earlier provider prefix.

## 10. Persisted nudge design

### 10.1 Why persistence is required

Pi custom messages created with `pi.sendMessage()` participate in LLM context and are persisted as `custom_message` entries. In contrast, `pi.appendEntry()` custom entries do not participate in LLM context.

A custom message persisted at the next request becomes an append-only Pi-session suffix. Certified provider adapters must still prove the corresponding normalization boundary; persistence alone does not guarantee byte-prefix behavior for arbitrary providers.

### 10.2 Durable scheduling and nudge emission

`pi.sendMessage(..., { deliverAs: "nextTurn" })` is a process-local queue until the next prompt and is not sufficient as the durable source of truth. Instead:

1. threshold evaluation at `agent_settled` appends a non-context version-2 `nudge.requested` operation;
2. on the next `before_agent_start`, pi-dcp finds the oldest undelivered request on the active branch;
3. the handler returns a persistent `message` result, which Pi stores as a `custom_message` and sends to the model;
4. pi-dcp records or derives delivery idempotently from the persisted custom message's deterministic nudge key;
5. if the process exits before the next prompt, replay restores the pending request;
6. branch navigation delivers only requests present and undelivered on the selected branch.

Conceptually, `before_agent_start` returns:

```ts
return {
  message: {
    customType: "pi-dcp.v2.nudge",
    content: stableNudgeText,
    display: false,
    details: { nudgeKey, kind, thresholdBand, configGeneration },
  },
};
```

`details` are extension state and are not model authorization. The visible `content` must be deterministic for its threshold band and MUST NOT contain live token counts, timestamps, random IDs, or expiry. A returned persistent message changes only the newly constructed suffix for that user request; it must not rewrite the system prompt.

Recommended stable bands:

- soft: context crossed the minimum threshold;
- imperative: context crossed the maximum threshold;
- critical: context crossed the critical threshold.

The exact measured usage remains available in diagnostics/UI, not provider text.

### 10.3 Deduplication

Persist a separate non-context operation or derive from active branch custom messages to ensure at most one nudge per configured interval/band.

A nudge key should use deterministic state such as:

```text
selected branch anchor + threshold band + config generation
```

Do not use wall-clock values in model-visible content. Internal timestamps may support UI and cleanup.

### 10.4 Manual compression

`/dcp compress [focus]` continues to send an actual user message. That user message is naturally append-only and can include the optional focus.

Remove the one-off `before_agent_start` system-prompt mutation. Manual authorization is bound to the user request and resulting assistant call rather than a random nonce consumed before validation.

At the next `before_agent_start`, capture the persisted manual user message's entry ID from the active branch and bind authorization to that canonical entry. A valid manual `compress` call must be in an assistant response whose retained baseline contains that user entry as its latest manual request ancestor. Authorization is consumed only after successful operation commit. A harmless validation retry remains authorized only for the same user-entry ancestry and unchanged DCP baseline; wall-clock lifetime is internal and never provider-visible.

## 11. Version-2 operation protocol and clean break

### 11.1 Namespace

Use a distinct custom entry namespace, for example:

```text
pi-dcp.v2.operation
```

and an envelope with `schema: 2`.

This prevents old and new reducers from silently interpreting each other's state.

### 11.2 Existing sessions

The clean-break policy is:

- version-1 custom operations remain untouched in raw session history;
- version 2 does not apply version-1 block replacements or tool redactions;
- raw conversation therefore reappears safely when version 2 loads;
- the extension emits one non-sensitive diagnostic that legacy DCP state was ignored;
- users may start new version-2 compression operations over currently available raw context;
- no automatic conversion of old summaries is attempted.

This restoration is safe because current version-1 summaries and redactions are derived from non-context `custom` operation entries; they were not persisted as replacement `custom_message` entries. Historical version-1 notification custom messages remain ordinary context messages and are not interpreted as version-2 state. If a future or third-party version-1 artifact persisted summary replacements as context messages, version 2 must diagnose rather than silently delete them.

This favors correctness and reversibility over preserving old DCP savings.

### 11.3 In-flight old tool calls

After reload, the new `compress` schema does not accept `snapshotId`. An old in-flight call is rejected with a clear protocol-version error and writes nothing. The model can retry from a new version-2 request.

Do not retain deprecated fields in the public schema. The selected policy is a deliberate clean break rather than `prepareArguments()` compatibility.

### 11.4 Fork ownership

Version-2 envelopes distinguish operation origin from branch applicability:

```ts
interface OperationEnvelopeV2 {
  schema: 2;
  opId: string;
  requestKey: string;
  originSessionId: string;
  createdAt: number;
  extensionVersion: string;
  operation: DcpOperationV2;
}
```

`originSessionId` is audit metadata, not a replay gate. The concrete replay rule is selected-branch physical presence: a valid version-2 operation applies when it appears in `getBranch()` in canonical order and passes reducer/schema checks. No separate lineage ID is required.

A fork may inherit copied operations without rewriting them. Abandoned-branch operations remain excluded because reconstruction uses `getBranch()`, never `getEntries()`. Immutable copied entries are not required to predict the destination session ID.

## 12. Transform pipeline v2

The revised outgoing pipeline is:

1. clone input for fail-closed fallback;
2. read the canonical built context once;
3. project supported Pi entries;
4. build and validate protocol units;
5. join canonical projection to incoming messages;
6. reconstruct/reconcile reduced version-2 state;
7. derive deterministic active block replacements;
8. apply persisted tool redactions;
9. allocate stable local unit and block aliases;
10. apply deterministic local annotations;
11. validate transformed protocol;
12. provider-convert in tests and verify deterministic prefix metrics;
13. publish/reuse the baseline snapshot in the internal registry;
14. return the transformed messages.

The context hook does not evaluate or inject nudges. Nudge evaluation and persistence occur outside the historical transform.

A transform failure returns an untouched deep clone and publishes no new baseline. It does not make an unrelated baseline globally current because no such global slot exists.

## 13. Alias-allocation rules

### 13.1 Unit aliases

- Assign `m0001...` in canonical oldest-to-newest protocol-unit order.
- Non-compressible units may either receive labels marked unavailable or be skipped; whichever rule is selected must remain stable under append-only growth.
- The latest user unit remains protected from compression even if labeled.
- Aliases are baseline-local execution references and are never persisted in operations.

Labeling every unit is preferred because skipped-unit rules can make the visible relationship between conversation and ordinal difficult for the model. Compression validation, not omission, should enforce protection.

### 13.2 Block aliases

Active blocks are sorted by canonical outgoing anchor and then canonical block ID. Their `bNNNN` aliases remain stable while no block activation, compression, pruning, branch, or compaction state changes.

A successful compression or activation change is allowed to renumber block aliases because the effective historical representation intentionally changed.

### 13.3 Alias capacity

The current four-digit grammar caps aliases at 9,999. Version 2 must either:

- fail closed before overflow with an explicit diagnostic; or
- adopt a wider grammar in the clean-break schema.

A wider grammar such as `m\d{5,6}` is preferable for long sessions, but provider/token cost should be measured.

## 14. Related correctness fixes

### 14.1 Manual automatic strategies

Remove the unconditional `state.manualMode` return from `evaluateSettledStrategies()`. The lifecycle caller should pass an explicit `automaticStrategiesAllowed` decision derived from both manual mode and configuration.

### 14.2 Failed-transform diagnostics

Record a reason code and provider-visible change category without logging raw content. At minimum:

- projection unsupported;
- join ambiguous;
- protocol invalid;
- previous extension changed context;
- provider annotation unsupported;
- alias overflow.

### 14.3 Notification separation

Compression/pruning notifications may remain chat messages when configured because they are persisted append-only. They must not be mistaken for nudge authorization. Stable custom types should distinguish:

- `pi-dcp.v2.nudge`;
- `pi-dcp.v2.notification`;
- `pi-dcp.v2.summary` provider-only replacement messages.

### 14.4 Context usage

Live token usage may drive whether a persisted nudge is appended, but exact counts remain in UI/debug state. Provider-visible nudge text uses fixed bands to remain deterministic.

## 15. Concurrency model

Continue using one fair FIFO mutex for mutation and baseline publication.

The mutex protects:

- branch reconstruction;
- reduced-state updates;
- baseline-registry publication/eviction;
- compression validation and commit;
- automatic pruning evaluation and commit;
- session rebase and generation changes.

Never hold it while awaiting UI confirmation.

Do not assume a sequential custom tool is the only tool in an assistant response. Authorization must tolerate sibling tool preflight/execution/results while rejecting unrelated branch changes.

## 16. Test plan

### 16.1 Cache determinism

1. Transform identical input twice under fake timers and deterministic runtime state; assert deep equality.
2. Advance beyond the former TTL; assert identical provider-facing payload.
3. For each certified adapter, append an ordinary user message and compare pi-dcp-on versus pi-dcp-off earliest divergence; require no earlier DCP-induced boundary change.
4. Append assistant and tool-result units and enforce the same differential invariant; require literal prefix equality where that adapter's baseline behavior is append-exact.
5. Cross nudge thresholds; assert the nudge appears as a newly persisted suffix and does not alter prior bytes.
6. Assert no random or ISO-date pattern appears in provider-visible DCP content.

### 16.2 Provider wire goldens

Test after Pi's actual `convertToLlm` and provider payload construction for:

- OpenAI Responses;
- OpenAI Chat Completions;
- supported OpenCode CLI adapters;
- custom messages adjacent to user, assistant, and tool exchanges;
- image content;
- thinking blocks;
- multiple sibling tool calls.

Capture the first changed token/message index between consecutive requests.

### 16.3 Baseline authorization

1. Transform an identical baseline multiple times and execute a call from the first pass.
2. Pause permission confirmation, run equivalent transforms, resume, and succeed.
3. Record actual sequential mixed-tool ordering and validate without assuming more than Pi guarantees; if a certified mode persists sibling results first, accept only results tied to calls in the same assistant entry.
4. Insert an unrelated user/assistant mutation and reject.
5. Navigate branch during confirmation and reject.
6. Change model/config/generation and reject.
7. Remove the assistant call entry from the active branch and reject.
8. Present duplicate tool-call IDs and reject.
9. Restart/reload with an in-flight old schema call and return a protocol-version error.

### 16.4 Operations and branches

1. Version-1 entries are ignored with one diagnostic and raw context is restored.
2. Version-2 branch replay is idempotent.
3. Static `forkFrom()` and clone-style forks inherit only selected-branch applicable state.
4. Origin session ID does not corrupt a copied valid operation.
5. Abandoned branch operations do not leak.
6. Native compaction orphans unavailable version-2 blocks without resurrecting them.

### 16.5 Nudges

1. One stable nudge is appended per eligible band/interval.
2. Nudge content contains no exact usage, timestamp, random ID, or expiry.
3. A pending `nudge.requested` operation survives process exit before the next user prompt.
4. `before_agent_start` persists the custom nudge once without interrupting an earlier active tool batch.
5. Branch navigation reconstructs nudge deduplication correctly.
6. Manual compression uses only the persisted user request and does not mutate the system prompt.
7. Failed manual compression does not consume authorization prematurely.

### 16.6 Existing safety tests

Retain and expand coverage for:

- immutable transforms;
- complete protocol units;
- range overlap and reversal;
- protected tools, paths, users, and recent turns;
- nested summaries, placeholder containment, cycles, and depth/size limits;
- reducer request-key conflicts;
- malformed operation tails;
- summary control-token rejection;
- bounded envelope size and performance.

## 17. Observability

Add cache-specific debug fields without recording prompt content:

```ts
interface CacheTransformDiagnostic {
  baselineHashPrefix: string;
  provider: string;
  model: string;
  canonicalMessages: number;
  transformedMessages: number;
  annotationCount: number;
  semanticChange: "none" | "compression" | "tool-prune" | "activation" | "host";
  firstChangedMessage: number;
  prefixStable: boolean;
  baselineReused: boolean;
  reason?: string;
}
```

`baselineHashPrefix` must be a short hash prefix, never raw session content. Normal logs remain free of summaries, tool arguments/results, paths, images, credentials, and full session filenames.

A development-only `before_provider_request` diagnostic may hash canonical provider payload segments to verify stability, but must never log the payload itself.

## 18. Rollout plan

### Phase 1: lock failing invariants

- Add repeated-transform and append-prefix tests against the current implementation.
- Add repeated-transform compression and sibling-tool tests.
- Confirm they fail for the audited reasons.

### Phase 2: introduce version-2 state and implicit baselines

- Add version-2 operation namespace/reducer.
- Replace the singleton snapshot with a baseline registry.
- Remove `snapshotId` from the tool schema.
- Bind execution to assistant entry provenance.

### Phase 3: replace metadata transport

- Remove global metadata and expiry.
- Add deterministic local annotations.
- Update constant system guidance.
- Certify provider wire formats.

### Phase 4: persist nudges

- Remove context-time nudge injection.
- Persist `nudge.requested` operations at settlement and materialize them as persistent `before_agent_start` custom messages on the next user request.
- Remove dynamic manual system-prompt augmentation.

### Phase 5: correctness and branch fixes

- Fix sibling result handling.
- Fix manual automatic strategies.
- Implement fork-safe version-2 ownership.
- Add branch, compaction, permission, and reload tests.

### Phase 6: soak and measure

- Compare provider cache-read accounting with pi-dcp disabled, version 1, and version 2.
- Measure annotation token overhead and transform latency.
- Verify that only compression-state transitions, pruning, or explicit host changes move the earliest changed prefix backward.

## 19. Acceptance criteria

The redesign is complete only when all of the following hold:

1. identical transforms produce byte-identical provider messages for every certified adapter;
2. ordinary appended history introduces no earlier provider-wire divergence than Pi without pi-dcp, and preserves a literal previous prefix on append-exact certified adapters;
3. no provider-visible DCP message contains random IDs, creation times, or expirations;
4. `compress` has no model-supplied snapshot identifier;
5. compression succeeds after repeated equivalent transforms;
6. compression validation follows the measured sequential tool-batch ordering, and any certified sibling-result ordering is handled without relying on the assistant entry remaining the leaf;
7. real branch/model/config/history changes are rejected before commit;
8. permission confirmation cannot be invalidated by an equivalent transform;
9. threshold nudges are persisted append-only and contain stable text;
10. manual compression does not mutate the system prompt and does not lose authorization on a harmless retry;
11. version-1 state is handled according to the documented clean-break policy;
12. forked version-2 operations do not fail solely because the destination session ID changed;
13. automatic pruning respects `manualMode.automaticStrategies`;
14. provider-wire goldens cover every certified provider path;
15. compression-state transitions (create/decompress/recompress) and pruning remain the only pi-dcp semantic operations expected to invalidate an earlier conversation prefix.

## 20. Rejected alternatives

### 20.1 Reuse the current random snapshot until history changes

This fixes duplicate equivalent transforms only while the snapshot remains alive. It still exposes expiry, retains a global mutable authorization slot, and leaves the moving/growing metadata catalog. It does not satisfy append-prefix stability.

### 20.2 Deterministic snapshot ID in global metadata

A deterministic hash removes randomness, but the hash and alias catalog change as history grows. The metadata also moves. Cache-prefix churn remains.

### 20.3 Keep transient nudges and declare their misses acceptable

This contradicts the explicit requirement that pi-dcp cause misses only when compression or pruning changes effective history. It also makes cache behavior dependent on noisy provider usage estimates.

### 20.4 Put dynamic snapshot metadata in the system prompt or tool schema

This moves changing content to the earliest possible prefix and is worse for caching. Tool-schema changes can also invalidate provider caches globally.

### 20.5 Persist aliases as canonical state

Aliases are presentation references, not durable identity. Persisting them complicates branching and replay and is unnecessary because canonical entry/tool IDs already exist.

### 20.6 Preserve version-1 schema compatibility

The selected policy is a clean break. Compatibility shims would retain ambiguous snapshot semantics and complicate proof of the new invariants. Raw history remains safe, so restoring it and starting version-2 operations is preferable to silently migrating authorization/state semantics.

## 21. Design conclusion

The current implementation's strongest properties—append-only raw history, canonical branch operations, protocol-unit safety, model-authored summaries, and fail-closed mapping—should remain.

The snapshot transport should not.

A snapshot is an internal canonical baseline, not a random credential that the model must echo. Model-facing aliases must be deterministic and locally anchored so old transformed context remains stable. Nudges must become real append-only session messages rather than transient historical insertions.

With those changes, pi-dcp can preserve its non-destructive compression model while becoming compatible with prefix caching and robust against repeated transformations, permission delays, retries, and sibling tool execution.
