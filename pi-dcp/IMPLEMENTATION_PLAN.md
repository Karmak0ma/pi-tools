# pi-dcp implementation plan

**Status:** frozen implementation plan  
**Inputs:** `DESIGN.md`, `DESIGN_review.md`, user decisions in the planning session  
**Target:** private, source-loaded `pi-dcp` extension for Pi `>=0.84.1`  
**License:** AGPL-3.0-or-later-compatible implementation and distribution

## 1. Frozen product contract

This plan supersedes the open decisions and delivery deferrals in `DESIGN.md` for the first completed release.

### 1.1 Included

The release includes:

- non-destructive outgoing-context transformation;
- branch-local, append-only canonical operations;
- fail-closed projection and identity joining;
- immutable, short-lived context snapshots;
- sparse `mNNNN` and `bNNNN` model references;
- model-authored contiguous range compression, including a batch of up to 16 ranges;
- nested block consumption with exact placeholders;
- decompression and recompression;
- settled-turn deduplication and old-error input pruning;
- explicit sweep;
- protected tools, paths, recent turns, and optionally complete user messages including images;
- built-in adapters for known question-tool schemas;
- model-visible manual compression requests;
- branch/session-local context and statistics commands;
- TUI, RPC, JSON/print, persisted-session, and in-memory-session behavior;
- OpenAI and `opencode-cli` provider compatibility gates;
- safe handling of historical, manual, or overflow Pi compactions if they are encountered;
- complete unit, property, golden, integration, crash, security, and performance coverage.

### 1.2 Excluded

Do not implement or expose configuration for:

- independently selected message-mode compression;
- a parent/child subagent state bridge;
- reducer checkpoints;
- a sidecar state/projection cache;
- cross-session aggregate statistics or session-file scanning;
- custom prompt files or prompt overrides;
- provider tokenizer dependencies;
- automatic modification of Pi settings;
- cancellation or replacement of Pi native compaction;
- standalone command aliases such as `/context` or `/sweep`.

These are exclusions from this release, not unresolved implementation decisions.

### 1.3 Pi compaction prerequisite

The user is responsible for disabling Pi automatic threshold compaction:

```json
{
  "compaction": {
    "enabled": false
  }
}
```

The extension MUST NOT read, edit, or claim to enforce this setting. The README MUST place this prerequisite immediately after installation instructions and explain that:

- pi-dcp is an outgoing-context lens and does not change Pi's persisted token accounting;
- automatic Pi compaction can otherwise replace history independently of DCP;
- manual `/compact`, overflow recovery, old sessions, and imported sessions may still contain native compactions;
- pi-dcp therefore retains projection/rebase support but never cancels any native compaction.

`session_before_compact` always invalidates the current DCP snapshot and returns `undefined`. It never returns `{cancel:true}` and never supplies a custom compaction result.

### 1.4 Package and compatibility policy

- Package name: `pi-dcp`.
- Initial version: `0.1.0`.
- Package is private: `"private": true`; no npm publication step.
- Pi loads `./src/index.ts` directly.
- Authoring TypeScript is retained; no `dist/` artifact is needed.
- The package requires Pi `>=0.84.1`; Pi `0.84.1` is the initially certified semantic version.
- `peerDependencies` use `>=0.84.1` for imported Pi packages.
- Development dependencies pin Pi packages to `0.84.1` so fixtures and type checks are reproducible.
- Later Pi versions are accepted only while runtime capabilities exist and every encountered entry/message form conforms to a versioned projection adapter. Capability presence alone never proves projection compatibility. Unknown or changed projection forms fail closed to raw context and are not called certified until their version is added to the support matrix with fixtures.
- Startup capability checks are authoritative even when semver is satisfied. A missing capability disables all mutation/transformation and emits one metadata-only diagnostic; ordinary Pi operation continues with raw context.
- `jsonc-parser` is the only non-Pi runtime dependency. Tokenization remains heuristic.

### 1.5 Review findings incorporated

The implementation MUST incorporate all three valid review corrections:

1. **Fork semantics:** `/tree` and clone-style operations normally copy/select active paths, but static `SessionManager.forkFrom()` can copy abandoned entries. Canonical replay always uses the selected leaf's `getBranch()`, never `getEntries()`. Add an explicit `forkFrom()` fixture proving copied abandoned operations do not leak into active state.
2. **Compaction projection:** the adapter is version-specific. For certified Pi 0.84.1, a compaction projects one summary; retained entries selected from `firstKeptEntryId` remain ordinary projected entries and no separate retained-tail message is invented. A fixture containing materialized `retainedTail` metadata must assert the actual 0.84.1 `buildContextEntries()` behavior. Any later Pi behavior gets a separate adapter and certification fixture.
3. **Reference wording:** documentation describes the reference package as having no published authoring `.ts` sources while generated `.d.ts` declarations are present; it does not call the package literally TypeScript-free.

## 2. Repository and package layout

Create this exact layout:

```text
pi-dcp/
├── DESIGN.md
├── DESIGN_review.md
├── IMPLEMENTATION_PLAN.md
├── LICENSE
├── README.md
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts
│   ├── capabilities.ts
│   ├── lifecycle.ts
│   ├── runtime.ts
│   ├── config/
│   │   ├── defaults.ts
│   │   ├── schema.ts
│   │   └── load.ts
│   ├── identity/
│   │   ├── types.ts
│   │   ├── project.ts
│   │   ├── fingerprint.ts
│   │   ├── join.ts
│   │   ├── protocol.ts
│   │   └── snapshot.ts
│   ├── state/
│   │   ├── operations.ts
│   │   ├── reducer.ts
│   │   └── reconstruct.ts
│   ├── compression/
│   │   ├── schema.ts
│   │   ├── validate.ts
│   │   ├── range.ts
│   │   ├── nesting.ts
│   │   ├── protected.ts
│   │   └── service.ts
│   ├── transform/
│   │   ├── pipeline.ts
│   │   ├── blocks.ts
│   │   ├── tools.ts
│   │   ├── metadata.ts
│   │   └── protocol-check.ts
│   ├── strategies/
│   │   ├── deduplicate.ts
│   │   ├── purge-errors.ts
│   │   └── settle.ts
│   ├── questions/
│   │   └── registry.ts
│   ├── prompts/
│   │   ├── defaults.ts
│   │   └── nudge.ts
│   ├── commands/
│   │   ├── index.ts
│   │   ├── context.ts
│   │   ├── stats.ts
│   │   ├── sweep.ts
│   │   ├── manual.ts
│   │   └── blocks.ts
│   ├── tokens/
│   │   └── estimate.ts
│   ├── security/
│   │   └── summary.ts
│   ├── ui/
│   │   └── notify.ts
│   ├── observability/
│   │   └── logger.ts
│   └── util/
│       ├── async-mutex.ts
│       ├── canonical-json.ts
│       ├── clone.ts
│       └── hash.ts
└── test/
    ├── unit/
    ├── property/
    ├── golden/
    ├── integration/
    ├── crash/
    ├── security/
    ├── performance/
    ├── helpers/
    └── fixtures/
        ├── sessions/
        ├── pi-0.84.1/
        └── providers/
```

### 2.1 Manifest

Use ESM, `private:true`, `pi.extensions:["./src/index.ts"]`, and keywords `pi-package`, `pi-extension`, `context`, `compression`. Define:

- `typecheck`: `tsc --noEmit`;
- `test`: `vitest run`;
- `test:unit`, `test:property`, `test:golden`, `test:integration`, `test:crash`, `test:security`, and `test:performance` as directory-specific Vitest runs;
- `check`: typecheck followed by every non-live suite;
- `test:live:opencode`: an explicitly opt-in integration command, never part of `check`;
- `test:live:openai`: an explicitly opt-in credentialed command, never part of `check`.

Use strict NodeNext TypeScript targeting ES2022, `noEmit:true`, `allowImportingTsExtensions:true`, Node types, and no unchecked `any` at session/config boundaries.

## 3. Definitive data model

### 3.1 Canonical identities

```ts
type EntryId = string;
type ToolCallId = string;
type BlockId = string;
type RunId = string;

type CanonicalMessageKey = {
  kind: "entry";
  entryId: EntryId;
  projection: number;
};

interface ProtocolUnit {
  key: string;                    // SHA-256 of ordered keys and call IDs
  entryIds: EntryId[];
  messageKeys: CanonicalMessageKey[];
  toolCallIds: ToolCallId[];
  startProjectedIndex: number;
  endProjectedIndex: number;
  settled: boolean;
  compressible: boolean;
}
```

### 3.2 Persisted operation envelope

Every mutation is exactly one custom entry with `customType === "pi-dcp.operation"`:

```ts
interface OpEnvelope {
  schema: 1;
  opId: string;                   // UUID v4
  requestKey: string;             // deterministic idempotency key
  sessionId: string;
  createdAt: number;
  extensionVersion: string;
  operation: DcpOperation;
}

type DcpOperation =
  | CompressionCreated
  | BlockActivationChanged
  | ToolsPruned
  | ManualModeChanged;
```

Aliases, indexes, timestamps used as identity, fingerprints, and raw content other than model-authored summaries MUST NOT be persisted.

### 3.3 Atomic multi-range compression operation

One tool call creates one envelope and one run. It never appends one operation per range.

```ts
interface CanonicalCoverage {
  directEntryIds: EntryId[];
  effectiveEntryIds: EntryId[];
  directToolCallIds: ToolCallId[];
  effectiveToolCallIds: ToolCallId[];
}

interface CreatedBlock {
  blockId: BlockId;
  ordinal: number;                // 0-based order in the submitted batch
  topic: string;                  // common tool-call topic
  summary: string;                // final expanded/augmented model-authored summary
  authoredSummary: string;        // exact original tool argument
  estimatedSummaryTokens: number;
  coverage: CanonicalCoverage;
  anchor: {
    beforeEntryId?: EntryId;
    afterEntryId?: EntryId;
  };
  consumedBlockIds: BlockId[];
  nestedDepth: number;
}

interface CompressionCreated {
  type: "compression.created";
  runId: RunId;
  mode: "range";
  toolCallId: ToolCallId;
  snapshotHash: string;
  model: { provider: string; id: string; api: string };
  blocks: CreatedBlock[];         // 1..16, chronological and non-overlapping
}
```

The reducer creates every block and deactivates every `consumedBlockId` atomically while applying this operation. `authoredSummary` preserves authorship/audit; `summary` differs only through deterministic nested-placeholder expansion and protected-content appendices. Normal UI/logging never emits either field.

`requestKey = sha256(sessionId + "\0" + toolCallId + "\0" + snapshotHash)`. Replaying an identical `requestKey`/payload is idempotent. The same key with different content marks the branch corrupt and disables DCP.

### 3.4 Remaining operations

```ts
interface BlockActivationChanged {
  type: "blocks.activation.changed";
  blockIds: BlockId[];
  active: boolean;
  cause: "user-decompress" | "user-recompress";
}

interface PrunedToolDecision {
  toolCallId: ToolCallId;
  kind: "dedup-output" | "old-error-input" | "sweep-output" | "question-input";
  estimatedTokens: number;
}

interface ToolsPruned {
  type: "tools.pruned";
  decisions: PrunedToolDecision[];
}

interface ManualModeChanged {
  type: "manual.changed";
  enabled: boolean;
}
```

A `tools.pruned` operation can contain decisions from more than one automatic strategy, allowing at most one journal append per `agent_settled`. Decisions are sorted by canonical tool order, then kind. Repeating the same `(toolCallId, kind)` is idempotent. Conflicting output-prune kinds retain the earliest canonical decision; `old-error-input` and `question-input` can coexist with an output decision only if their redactions affect disjoint fields.

Orphan status is never persisted. It is derived during reconstruction by comparing coverage and anchors with the current projected context. An unavailable block is `available:false`, `active:false`, and cannot be recompressed. This preserves audit state without lifecycle-generated journal writes.

### 3.5 Reduced state

```ts
interface ReducedBlock extends CreatedBlock {
  runId: RunId;
  createdByOpId: string;
  active: boolean;
  available: boolean;
  userDecompressed: boolean;
  parentBlockIds: BlockId[];
}

interface ReducedToolPrune {
  output?: { kind: "dedup-output" | "sweep-output"; opId: string; operationIndex: number };
  oldErrorInput?: { opId: string; operationIndex: number };
  questionInput?: { opId: string; operationIndex: number };
}

interface ReducedState {
  schema: 1;
  blocks: Map<BlockId, ReducedBlock>;
  runs: Map<RunId, BlockId[]>;
  toolPrunes: Map<ToolCallId, ReducedToolPrune>;
  manualMode: boolean;
  appliedOpIds: Set<string>;
  requestKeys: Map<string, string>; // requestKey -> canonical payload hash
  operationCount: number;
  corruptReason?: ReasonCode;
}
```

Reducer invariants:

- IDs are create-once.
- A run has 1..16 blocks in ordinal order.
- Available active blocks have complete coverage and a valid anchor.
- Active effective coverage never partially overlaps; nesting consumes enclosed blocks.
- Every consumed child names its active parent relationship.
- For each tool, the first output decision in active-branch operation order wins; later output decisions are idempotent no-ops. Old-error and question input flags are independent and deterministic. Redacted field paths are not persisted: the fixed schema adapter derives them from canonical arguments, and a schema mismatch skips redaction rather than guessing.
- Decompression can reveal eligible descendants; recompression is allowed only after explicit user decompression and while all coverage remains available.
- Derived orphaning is permanent for the current built projection but may differ after intentional tree navigation to a branch where coverage exists; it never resurrects a user-decompressed block automatically.
- Unknown envelope/operation schema stops replay at that operation and disables all DCP transforms and writes for the branch.

## 4. Runtime state and concurrency

```ts
interface DcpRuntime {
  valid: boolean;
  sessionId: string;
  sessionFile?: string;
  branchLeafId: string | null;
  generation: number;
  config: EffectiveConfig;
  reduced: ReducedState;
  index: CanonicalIndex;
  snapshot?: ContextSnapshot;
  mutex: AsyncMutex;
  pendingManual?: { nonce: string; focus?: string; createdAt: number };
  lastTransform?: TransformMetrics;
  lastSettledSuffixHash?: string;
  warnedReasonCodes: Set<ReasonCode>;
}
```

Use one fair FIFO async mutex per runtime. All replay, snapshot publication, journal mutation, settled strategy evaluation, branch changes, model changes, and compaction rebases use it. Never await UI confirmation while holding it: validate cheaply, release, confirm, reacquire, and fully revalidate. `compress` is additionally registered with `executionMode:"sequential"`.

A generation increment invalidates all snapshots. Increment on session start/replacement, tree/fork/switch completion, model selection, config reload, native compaction, and every successful DCP mutation.

## 5. Configuration contract

### 5.1 Loading

Merge complete valid layers in this order:

1. compiled defaults;
2. global `${PI_CODING_AGENT_DIR || ~/.pi/agent}/dcp.jsonc`, otherwise `dcp.json`;
3. trusted project `${cwd}/${CONFIG_DIR_NAME}/dcp.jsonc`, otherwise `dcp.json`.

If both extensions exist in a layer, JSONC wins and a warning is emitted. Project files are not even opened unless `ctx.isProjectTrusted()` is true. Arrays replace arrays. Unknown keys warn. Any parse/type/range error rejects the entire layer. No environment interpolation or executable values are supported.

### 5.2 Exact defaults

Use the design defaults, with excluded and native-cancellation settings removed:

```ts
const defaults = {
  enabled: true,
  debug: false,
  pruneNotification: "detailed",
  pruneNotificationType: "chat",
  commands: { enabled: true, protectedTools: [] },
  manualMode: { enabled: false, automaticStrategies: true },
  turnProtection: { enabled: false, turns: 4 },
  nudge: {
    minContextPercent: 35,
    maxContextPercent: 70,
    criticalContextPercent: 90,
    turnsBetweenNudges: 5,
    turnNudgeFrequency: 5,
    iterationNudgeThreshold: 15,
    minPotentialSavingsTokens: 12000
  },
  protectedFilePatterns: [],
  compress: {
    permission: "allow",
    showCompression: false,
    summaryBuffer: true,
    maxContextLimit: 100000,
    minContextLimit: 50000,
    modelMaxLimits: {},
    modelMinLimits: {},
    nudgeForce: "soft",
    protectedTools: [],
    protectUserMessages: false
  },
  strategies: {
    deduplication: { enabled: true, protectedTools: [] },
    purgeErrors: { enabled: true, turns: 4, protectedTools: [] }
  },
  snapshot: { ttlMs: 600000 },
  summary: {
    maxChars: 100000,
    maxExpandedChars: 200000,
    maxNestedDepth: 8
  }
} as const;
```

Integer/range validation follows `DESIGN.md`. Limits can be positive integers or `N%`; percentages require a known context window. Built-in always-protected tools are the union of `task`, `skill`, `todowrite`, `todoread`, `compress`, `batch`, `plan_enter`, `plan_exit`, `write`, and `edit`. Compression appendix protection starts with `task`, `skill`, `todowrite`, and `todoread`. Feature arrays only add to baselines.

No `compress.mode`, `experimental`, tokenizer, aggregate, checkpoint, cache, prompt, or native-compaction-cancellation keys are accepted.

### 5.3 Permission

- `allow`: tool active and execution allowed after normal validation.
- `ask`: tool active; after cheap validation, require `ctx.hasUI` and successful `ctx.ui.confirm()`. False, timeout, disconnect, cancellation, or error denies. JSON/print deny immediately.
- `deny`: remove only pi-dcp's `compress` from the active set and reject stale/queued execution defensively.

A pre-existing tool named `compress` is a collision: disable pi-dcp mutation and transformation rather than replace or deactivate another extension's tool.

## 6. Capability checks

`capabilities.ts` checks, without invoking destructive behavior:

- required lifecycle event registration is accepted;
- `appendEntry`, `registerTool`, `registerCommand`, `getActiveTools`, `setActiveTools`, and `sendUserMessage` exist;
- context objects expose `sessionManager.getLeafId`, `getBranch`, `buildContextEntries`, and session identity;
- `ctx.getContextUsage`, `ctx.isProjectTrusted`, `ctx.reload`, and `ctx.isIdle` exist for lifecycle processing; `ctx.hasUI` and `ctx.ui.confirm` are checked at execution time for `ask` permission;
- sequential tool definitions are supported by the installed types/runtime contract.

Factory-time checks cover `pi`; context-dependent checks finish at `session_start`. Failure sets `runtime.valid=false`, removes pi-dcp's active tool if safe, skips config project reads and operations, and emits one `capability_missing` diagnostic.

## 7. Identity projection and joining

### 7.1 Projection adapter

Read `buildContextEntries()` exactly once per reconciliation. Project each returned entry through a local Pi-0.84.1 adapter, recording canonical provenance beside each expected message.

Cover:

- normal message: one projection;
- custom operation and other context-invisible entries: zero;
- custom message: one;
- non-empty branch summary: one;
- Pi 0.84.1 compaction: exactly one summary projection; retained ordinary entries selected from `firstKeptEntryId` are projected under their own entry IDs, and no projection is synthesized from `retainedTail` metadata;
- unknown entry type or projection shape: adapter failure and raw-context fallback.

Maintain golden fixtures generated from Pi 0.84.1's actual `buildContextEntries()` behavior, including compaction records with and without `retainedTail` metadata. Do not import private Pi implementation functions at runtime. Add a separate adapter and fixture namespace before certifying any Pi version whose behavior differs.

### 7.2 Fingerprints

Use SHA-256 over canonical JSON containing role, line-ending-normalized text, image MIME/hash, thinking hash, ordered tool calls and canonical arguments, tool-result correlation/error/content shape, custom type, and assistant provider/model/API/stop reason. Do not trim text or normalize semantic whitespace. Equal fingerprints receive occurrence ordinals.

A transform-tolerant fingerprint that omits payload hashes may be logged as a reason category but never authorizes transformation.

### 7.3 Join algorithm

Join expected projections to incoming `context` messages in this order:

1. anchor exact assistant call-ID sets and tool-result IDs;
2. anchor unique structural fingerprint plus occurrence;
3. complete only a unique monotonic mapping between anchors using positional/LCS constraints;
4. construct complete protocol units;
5. reject duplicate call IDs, missing settled partners, name mismatches, impossible ordering, partial expected units, or tied complete mappings.

Any unavailable or ambiguous mapping causes an all-or-nothing no-op: return a deep clone of the original incoming array, inject no summaries/metadata/nudges, publish no usable snapshot, and append no operation.

### 7.4 Protocol units

A non-tool message is one unit. An assistant message containing one or more tool calls plus all corresponding settled results is one indivisible unit. Pending, streaming, aborted, or host-valid incomplete units remain byte-for-structure unchanged and are uncompressible/unprunable. Multiple sibling results retain source order.

## 8. Snapshot and sparse metadata

A snapshot contains session ID, leaf ID, model key, runtime generation, creation/expiry, ordered protocol units, active blocks, hashes, and alias maps. Use an opaque 128-bit random `snapshotId`; TTL is 10 minutes and one provider-turn generation. A newly published snapshot supersedes the previous one.

The hash includes session, leaf, model provider/ID/API/context window, config safety hash, generation, ordered unit keys/call IDs, active block IDs, and content digests. It excludes raw content from logs.

Aliases are allocated oldest-to-newest as `m0001...` for compressible protocol units and by outgoing anchor as `b0001...` for active blocks. Inject exactly one compact metadata custom message at the latest protocol-safe gap before the most recent user-intent unit. It contains:

- snapshot ID and expiry guidance;
- one line per selectable unit with alias, role/category, bounded content-free descriptor, and turn age;
- one line per active block with alias, topic, and estimated size;
- range/placeholder syntax.

Do not annotate every historical message. Metadata is ephemeral and never sent with `appendEntry` or `sendMessage`. If the provider adapter cannot serialize the custom role safely, use a bounded user-text metadata message at the same complete protocol boundary; provider goldens must approve that representation.

A tool call is valid only if snapshot ID, TTL, session, leaf, generation, model key, recomputed projection hash, and every referenced alias still match. Failure returns `snapshot_stale` and writes nothing.

## 9. Outgoing context pipeline

Under the mutex:

1. deep-clone incoming messages and retain a second untouched fallback clone;
2. reconcile branch operations if leaf/suffix changed;
3. project and uniquely join expected context;
4. build/validate protocol units;
5. derive block availability and active set;
6. replace active blocks at valid anchors, oldest first;
7. apply persisted tool redactions;
8. estimate would-send categories/tokens heuristically;
9. determine nudge need and safe anchors;
10. create the immutable snapshot and sparse metadata;
11. insert nudges and metadata only at safe unit gaps;
12. run provider-neutral role, size, and call/result validation;
13. return the transformed clone.

Any exception or validation failure returns the untouched fallback clone. The handler performs no synchronous filesystem I/O and appends no operations.

Active block replacement is an ephemeral `CustomMessage` with `customType:"pi-dcp.summary"`, `display:false`, deterministic anchor timestamp, a bounded untrusted-history header, topic, summary, and current `bNNNN` alias. It is never persisted. Adjacent summaries may be serialized together only if separate aliases remain recoverable.

## 10. Compression tool

### 10.1 Schema

Register exactly:

```ts
Type.Object({
  snapshotId: Type.String({ minLength: 16, maxLength: 128 }),
  topic: Type.String({ minLength: 1, maxLength: 120 }),
  content: Type.Array(Type.Object({
    startId: Type.String({ pattern: "^(m\\d{4}|b\\d{4})$" }),
    endId: Type.String({ pattern: "^(m\\d{4}|b\\d{4})$" }),
    summary: Type.String({ minLength: 1, maxLength: 100000 })
  }, { additionalProperties: false }), { minItems: 1, maxItems: 16 })
}, { additionalProperties: false })
```

Tool name is `compress`; execution mode is sequential. Topic applies to every range in the batch. Blocks are distinguished by ordinal in UI.

### 10.2 Validation and commit order

1. Validate TypeBox shape, extension health, enabled state, permission policy, and manual nonce eligibility.
2. Consume a delivered manual nonce after shape validation regardless of later success.
3. Validate/recompute the snapshot.
4. Resolve all aliases to canonical units/blocks.
5. Require each direct range to be forward, contiguous, chronological, and non-overlapping.
6. Expand boundaries to complete protocol units.
7. Reject pending units, latest active user intent, protected recent turns, protected tools/paths, and protected user messages.
8. Recheck overlaps after expansion.
9. Find active blocks wholly enclosed by each range; reject partial intersections.
10. Parse placeholders and require each selected nested block exactly once and no unselected block.
11. Validate summaries for length, Unicode/control characters, delimiters, non-empty non-placeholder content, and optional protected-term quality checks.
12. Expand nested summaries chronologically; append protected content deterministically; enforce depth 8 and 200,000 expanded characters.
13. Compute coverage, anchors, token estimates, parent/child relations, and the complete next reduced state.
14. If permission is `ask`, release mutex, confirm without raw content, reacquire, and repeat steps 1–13 against current state.
15. Generate IDs and deterministic request key; append one `compression.created` envelope.
16. After synchronous `appendEntry()` returns, swap in-memory state, increment generation, invalidate snapshot, notify, and return receipt details.

The receipt contains op/run/block IDs, snapshot hash, estimated delta, and confidence but is not canonical state. No exactly-once or durable-flush guarantee is claimed.

### 10.3 Nested summaries

`(bNNNN)` is recognized only in a compress summary argument. User/tool text cannot resolve it. Expansion substitutes the complete stored wrapped summary. Reject missing, duplicate, unknown, out-of-range, cyclic, too-deep, or too-large expansion. Deduplicate protected appendices by canonical tool-call ID.

## 11. Tool pruning

### 11.1 Settled automatic evaluation

On `agent_settled`, acquire the mutex, read `getBranch()` and `buildContextEntries()` directly, reconcile their canonical projection, and compute both enabled strategies. This path does not require a previous successful `context` join or snapshot because decisions are based only on canonical settled branch data. If manual mode is enabled and `automaticStrategies` is false, do nothing. Otherwise compute the complete next state, append at most one `tools.pruned` envelope containing all new sorted decisions, then swap state, increment generation, and invalidate every snapshot after synchronous append return. Use `lastSettledSuffixHash` to avoid duplicate evaluation without relying on hook counters. A projection failure or append-path failure writes nothing and does not affect the next model request.

### 11.2 Deduplication

Signature is tool name plus canonical JSON of recursively key-sorted plain-object arguments with undefined removed; arrays retain order and null remains distinct. Keep the newest completed eligible call by canonical branch order. Prune only older outputs. Skip errors, pending calls, protected tools/paths, and protected recent turns.

### 11.3 Old errors

Turn age is derived from canonical user turns. At age `>=4` by default, record `old-error-input`. Outgoing transformation retains error result text and replaces only string-valued fields in a valid plain-object argument map. Preserve arrays, numbers, booleans, null, malformed/serialized arguments, prototypes, and the argument object shape.

### 11.4 Sweep

- no argument: all eligible completed tools after the latest non-DCP user message;
- positive integer `N`: newest `N` eligible completed tools on the active built branch;
- anything else: usage error and no write.

Sweep records `sweep-output`, observes every protection, and appends one operation.

### 11.5 Question registry

Implement two explicit adapters in `questions/registry.ts`:

- `question`: accepts only the tested `questions` string or array schema;
- `ask_user_question`: accepts only an object with a `questions` array whose entries match the known header/question/options structure.

An adapter runs only after a corresponding result exists. It redacts the recognized input field to a bounded marker and preserves the result/answers. A name with an unexpected schema and every unknown question-like tool are skipped. No config-defined or heuristic adapter exists.

### 11.6 Output markers

Retain call ID, name, valid arguments, result role, result correlation/name/error/timestamp, and provider-valid content shape. Ordinary cleared output becomes `[Old tool result content cleared by pi-dcp]`. Never remove one half of a tool exchange.

## 12. Protection and path rules

Recognized path keys are `path`, `filePath`, `filepath`, `target`, and tool-specific nested edit items. Normalize relative paths against `ctx.cwd` only for matching. Do not log raw or normalized paths. Reject non-plain/cyclic argument traversal. Conservative ambiguity over-protects.

`protectUserMessages:true` protects the complete selected user unit, including text and images. Images otherwise remain unless their complete unit is compressed. Unknown roles/content blocks are preserved and uncompressible.

Turn protection counts canonical user turns, excludes DCP custom metadata, and protects the configured newest count. The latest real user-intent unit is always protected from autonomous compression.

## 13. Prompting and manual mode

Append, never replace, a fixed built-in system guidance segment in `before_agent_start`. It covers semantic closure, summary fidelity, current range schema, protocol-unit aliases, placeholders, protected content, snapshot freshness, and manual mode. No custom prompt store exists.

Nudges are ephemeral and deduplicated by canonical anchor, nudge kind, and config generation. Heuristic estimates may trigger soft/strong nudges but are labeled estimates and never drive native-compaction cancellation.

`/dcp compress [focus]`:

- rejects if another request is pending;
- creates one expiring nonce;
- idle: `sendUserMessage(text)`;
- streaming: `sendUserMessage(text,{deliverAs:"followUp"})`;
- `before_agent_start` consumes the nonce into one model-visible instruction;
- send failure clears the nonce;
- the model must make the real `compress` call and author every summary.

Manual mode allows compression only through such a valid nonce. It never fabricates an assistant call or invokes tool execution directly.

## 14. Commands and UI

Register only `/dcp` and strict subcommands:

- no arg/help: status, permission, manual state, config paths, compaction prerequisite reminder;
- `context`: latest transformed category/token estimate, active blocks, savings, changed-prefix position, confidence;
- `stats`: current branch/session operation-derived counts only;
- `sweep [N]`: exact semantics above;
- `manual [on|off]`: no arg toggles; persist only an actual state change;
- `compress [focus]`: one real user/follow-up request;
- `decompress [N|bNNNN]`: no arg lists active blocks; target resolves from a fresh command-local list;
- `recompress [N|bNNNN]`: no arg lists eligible user-decompressed blocks;
- `reload`: `await ctx.reload(); return` with no old-runtime access afterward.

Command aliases are ephemeral and never persisted. Mutations resolve under mutex. A nested target under an active ancestor instructs the user to decompress the ancestor first.

Detailed notification shows action/topic/count/estimates/duration/confidence; summary only when explicitly configured. Minimal shows action and estimate. Off shows nothing. TUI/RPC use supported notify/status/dialog APIs. JSON/print emit no decorative stdout output. Logs and receipts remain metadata-only except the persisted summary fields required for state.

## 15. Lifecycle behavior

- **Factory:** run Pi-surface checks; register one command and one sequential tool; read no project files and start no watcher/timer.
- **session_start:** finish capability checks; load trusted config; replay only `getBranch()`; project built entries; derive availability; clear prompt/snapshot state; set active tool without disturbing unrelated tools.
- **session_before_tree/fork/switch:** invalidate snapshot and reject new mutations.
- **session_tree/start after fork or switch:** replay selected `getBranch()`, derive availability, increment generation. Never replay abandoned entries copied by `forkFrom()`.
- **before_agent_start:** append fixed guidance and consume one matching manual nonce.
- **turn_start:** invalidate prior-turn snapshot and record in-memory boundary.
- **context:** run the exact fail-closed pipeline.
- **agent_settled:** evaluate and atomically persist automatic pruning decisions; clear one-turn UI indicators.
- **model_select:** invalidate snapshot, update model limits, increment generation.
- **session_before_compact:** invalidate snapshot; return `undefined` for manual, threshold, and overflow.
- **session_compact:** replay/project, derive orphan availability, clear nudges, increment generation. Never append orphan operations or resurrect unavailable blocks.
- **session_shutdown:** invalidate runtime, clear UI, and release resources. There are no sidecar writes.

## 16. Native compaction and forks

Even though README requires auto-compaction to be disabled, implementation must safely consume native compaction entries because they can be historical, manual, imported, or overflow-generated.

After any compaction, a block is available only if all effective coverage and its bracketing anchor map into the new built projection. Otherwise it remains audit-visible but inactive and cannot be recompressed. A native compaction summary is ordinary new context and may be compressed later. Pre-compaction DCP summaries are never carried forward in place of Pi's authoritative summary.

Fork tests distinguish:

- selected active-path navigation/clone behavior;
- static `forkFrom()` physically copying all non-header entries, asserted by inspecting the child file/`getEntries()`;
- selected child leaf replay through `getBranch()`, asserted to exclude physically copied but unreachable DCP operations.

## 17. Token estimates and observability

Use `ctx.getContextUsage()` as a reported anchor when current. Local transformed deltas use a documented conservative UTF-8 heuristic plus fixed message/tool/schema overhead. Count system, user, assistant, thinking, tool arguments/results, images as unknown/model-dependent, native/custom summaries, DCP summaries, nudges, and metadata. Confidence is `reported` or `heuristic`; never label it tokenizer-accurate.

Normal structured reason codes are:

- `capability_missing`, `config_layer_invalid`, `state_schema_unknown`, `state_conflict`;
- `projection_unsupported`, `join_ambiguous`, `protocol_invalid`;
- `snapshot_missing`, `snapshot_stale`, `snapshot_mismatch`;
- `range_invalid`, `range_overlap`, `content_protected`, `block_partial`, `placeholder_invalid`, `summary_invalid`;
- `permission_denied`, `permission_unavailable`, `manual_nonce_required`;
- `tool_collision`, `append_best_effort`, `provider_adapter_unsupported`.

Logs include hashed session/branch IDs, reason code, counts, duration, estimate/confidence, and extension version. They never include raw text, summary text, paths, images, tool arguments/results, credentials, or complete session filenames.

## 18. Provider compatibility gate

### 18.1 OpenAI

Golden fixtures cover Pi's OpenAI Responses and Chat/Completions conversion paths, including:

- ordinary text;
- single and parallel tool calls/results;
- DCP custom summary and metadata adapters;
- dedup/error/question markers;
- nested summaries;
- pending forms left unchanged;
- rejection of invalid half exchanges.

A credential-free fake stream/provider is the mandatory CI integration gate. An optional live test uses an explicit environment variable and performs a bounded text/tool/compression smoke test; it is never required for ordinary `check`.

### 18.2 opencode-cli bridge

Gate API/provider IDs `opencode-cli-runner` / `opencode-cli` against:

- `opencode/deepseek-v4-flash-free`;
- `opencode/mimo-v2.5-free`;
- `opencode/nemotron-3-super-free`;
- `opencode/big-pickle`.

Vendor immutable credential-free serialization/tool-parser fixtures into `test/fixtures/providers/opencode-cli/`; CI must not depend on the sibling repository. Each fixture records the source `pi-opencode-bridge` commit or content hash, bridge package version, API/provider IDs, model ID, and a SHA-256 digest of the source sample. A fixture-refresh script may read `../pi-opencode-bridge` explicitly, but it is manual, reviewable, and never runs during tests. Add an opt-in live matrix that invokes the installed bridge/OpenCode CLI. Dynamically discovered free models use the same tested generic adapter but are not individually certified until added to the vendored fixture list. The README states this distinction.

Unknown providers receive provider-neutral transformation only if their Pi conversion accepts the generic custom-message representation in a fixture; otherwise DCP returns raw context with `provider_adapter_unsupported`.

## 19. Test plan

### 19.1 Unit tests

Implement every unit category in `DESIGN.md` §22.1, adjusted to the frozen scope. Add explicit tests for:

- atomic multi-range envelope/reducer behavior;
- one settled append combining dedup and old-error decisions;
- derived orphan state with no appended operation;
- no native-compaction cancellation for all three reasons;
- no excluded configuration keys;
- exact `question` and `ask_user_question` adapters;
- sparse single-message metadata placement;
- heuristic-only confidence labels.

### 19.2 Property/fuzz tests

Use deterministic seeds and persist failing seeds. Generate valid protocol conversations, append-only trees, repeated messages, operation sequences, range sets, placeholders, malformed summaries/config/operations, and frozen input objects. Assert protocol completeness, branch-only replay, reducer idempotency, reversible decompression, non-overlap, placeholder containment, immutability, fail-closed ambiguity, and bounded execution.

### 19.3 Golden tests

Store exact input and outgoing JSON for:

- OpenAI Responses and Chat/Completions;
- each of the four certified opencode-cli models' bridge representation;
- Pi 0.84.1 normal, branch-summary, legacy `firstKeptEntryId`, and materialized `retainedTail` compaction projections;
- single/multi/nested compression and all redactions;
- TUI/RPC/non-UI command/notification output;
- every schema-1 operation.

Golden changes require explicit review; tests never rewrite them automatically in `check`.

### 19.4 Pi integration tests

Build a fake ExtensionAPI/context harness for deterministic tests and a subprocess harness using installed Pi 0.84.1 for real lifecycle tests. Cover restart, in-memory state, tree branches, clone, static `forkFrom()`, resume/new/reload, streaming follow-up, permissions in each UI mode, parallel sibling tools, all compaction reasons, historical compactions, model switch, extension ordering, malformed operation tails, and provider strictness.

### 19.5 Crash tests

Terminate before append, during host append, after synchronous return before memory swap, after swap before receipt, and during compaction rebase. On reopen, assert only best-effort guarantees: present complete operations replay wholly; absent operations expose raw context; duplicate request keys reduce once; conflicts/malformed tails disable DCP. Never repair Pi JSONL or assert exactly-once durability.

### 19.6 Security/privacy tests

Instrument file access to prove untrusted project files are not read. Test forged aliases/placeholders in conversation text, traversal/glob/prototype payloads, malformed Unicode/control characters, expansion bombs, secret canaries in all logs/notifications, and provider-role injection. Protection matching may conservatively over-protect but must not under-protect recognized write/edit paths.

### 19.7 Performance tests

On a deterministic 2,000-message/1,000-result fixture require:

- replay p95 under 50 ms;
- full projection/join/transform p95 under 100 ms;
- O(messages + content bytes), demonstrated by scaling checks;
- additional peak memory below 2.5x serialized input and 256 MB;
- each operation below 256 KB under defaults;
- no synchronous I/O in `context`;
- no mutex held during UI waits.

Because cache/checkpoints are excluded, remove the design's cached 25 ms and checkpoint 15 ms targets.

## 20. Ordered implementation work

Each step is a merge gate. Do not start model compression until the identity/protocol foundation passes.

1. **Scaffold and license:** manifest, TypeScript/Vitest config, AGPL license/notices, README skeleton with the compaction prerequisite, support matrix, and CI-safe scripts.
2. **Utilities/config/capabilities:** canonical JSON, hashing, cloning, mutex, strict config schema/layering/trust, logger, capability failure mode.
3. **Projection spike promoted to production:** Pi 0.84.1 projection adapter, retained-tail/legacy fixtures, fingerprints, join, protocol units, ambiguity fallback, performance baseline.
4. **Canonical state:** operation validators, pure reducer, branch-only reconstruction, atomic batch schema, derived availability, forkFrom and malformed-tail tests.
5. **Runtime/lifecycle:** session construction, generation/snapshot invalidation, active-tool collision handling, tree/fork/switch/model/reload/shutdown behavior, native-compaction no-cancel/rebase behavior.
6. **Base transform and snapshots:** clone pipeline, protocol validation, sparse metadata, provider-neutral fallback, OpenAI/opencode bridge goldens.
7. **Redaction foundation:** protections, path extraction, question registry, persisted sweep, automatic settled dedup/error pruning, markers and stats.
8. **Range compression:** tool schema, validation service, coverage/anchors, one atomic batch commit, summary insertion, permissions, receipts, stale rejection.
9. **Nested/reversible blocks:** placeholders, expansion bounds, parent/child reducer rules, decompress/recompress commands and property tests.
10. **Prompts/manual/UI:** fixed guidance, nudges, nonce-driven `/dcp compress`, all commands, notifications and mode degradation.
11. **Hardening:** complete property/fuzz, crash, security, provider, extension-ordering, and performance suites; fix every fail-closed edge.
12. **Documentation and release gate:** README behavior/config/commands/privacy/troubleshooting, provider certification, compaction warning, AGPL attribution, rollback instructions; run all acceptance checks.

## 21. Required verification commands

Before declaring implementation complete:

```bash
npm ci
npm run typecheck
npm run test:unit
npm run test:property
npm run test:golden
npm run test:integration
npm run test:crash
npm run test:security
npm run test:performance
npm run check
```

Run live provider smoke tests separately when their prerequisites are available:

```bash
npm run test:live:openai
npm run test:live:opencode
```

A live provider outage does not invalidate deterministic compatibility tests, but the support matrix records the last successful live run date/model/version.

## 22. Completion criteria

The implementing agent is finished only when:

1. all included features are implemented and all excluded surfaces are absent;
2. every test command above passes;
3. Pi raw entries are unmodified and only valid custom operations/ordinary tool receipts are appended;
4. replay uses only the selected `getBranch()` and passes static `forkFrom()` leakage tests;
5. Pi 0.84.1 compaction fixtures with `firstKeptEntryId` and materialized `retainedTail` metadata pass while proving that no separate retained-tail projection is invented;
6. every ambiguous join returns an untouched clone and writes nothing;
7. all transformed contexts preserve settled call/result protocol and current incomplete forms;
8. one compression call persists one coherent multi-range operation;
9. compression/decompression/recompression, including nesting, are reversible while coverage is available;
10. aliases never appear in canonical persisted state and every mutation validates a current snapshot;
11. settled automatic pruning performs no more than one append and is idempotent;
12. all native compaction reasons are never cancelled, and post-compaction unavailable blocks are derived inactive without writes;
13. README prominently instructs the user to set Pi `compaction.enabled:false` and states pi-dcp does not change settings;
14. permissions behave correctly in TUI, RPC, JSON, and print modes;
15. untrusted project config is not read and malformed inputs fail safely;
16. OpenAI and all four named opencode-cli model fixtures pass;
17. logs, notifications, and caches (none are created) pass secret-canary checks;
18. performance limits pass without cache/checkpoint shortcuts;
19. disabling/removing pi-dcp immediately restores ordinary raw Pi context without repair;
20. AGPL license, notices, attribution, and source availability requirements are satisfied for any distribution.
