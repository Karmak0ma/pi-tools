# Pi Dynamic Context Pruning (pi-dcp): Implementation Design

**Status:** proposed implementation design; no production code is included here  
**Behavioral reference:** `@tarquinen/opencode-dcp` 3.1.9  
**Target host:** `@earendil-works/pi-coding-agent` extension API  
**Audience:** an implementer who has never used DCP

> **Protocol note:** This v1 design is retained as historical background. The
> implemented clean-break protocol is specified by
> `CACHE_SNAPSHOT_REDESIGN.md` (v2): implicit baseline authorization,
> deterministic local aliases, v2 operation entries, and persisted nudges.

## Table of contents

1. [Document conventions](#1-document-conventions)
2. [Problem, vocabulary, and non-goals](#2-problem-vocabulary-and-non-goals)
3. [Observed reference behavior](#3-observed-reference-behavior)
4. [Observed OpenCode/Pi architecture comparison](#4-observed-opencodepi-architecture-comparison)
5. [Normative requirements](#5-normative-requirements)
6. [Proposed package and module layout](#6-proposed-package-and-module-layout)
7. [Proposed runtime architecture](#7-proposed-runtime-architecture)
8. [Canonical identity and snapshots](#8-canonical-identity-and-snapshots)
9. [Canonical persisted state and reducer](#9-canonical-persisted-state-and-reducer)
10. [Context pipeline and protocol invariants](#10-context-pipeline-and-protocol-invariants)
11. [Compression algorithm](#11-compression-algorithm)
12. [Automatic pruning strategies](#12-automatic-pruning-strategies)
13. [Prompting and nudges](#13-prompting-and-nudges)
14. [Configuration and permissions](#14-configuration-and-permissions)
15. [Commands and UI](#15-commands-and-ui)
16. [Pi native compaction interaction](#16-pi-native-compaction-interaction)
17. [Subagents](#17-subagents)
18. [Tokens, statistics, notifications, and observability](#18-tokens-statistics-notifications-and-observability)
19. [Threat model and summary validation](#19-threat-model-and-summary-validation)
20. [Risk and design-tension matrix](#20-risk-and-design-tension-matrix)
21. [Delivery phases](#21-delivery-phases)
22. [Test matrix](#22-test-matrix)
23. [Performance goals](#23-performance-goals)
24. [Migrations, rollback, and compatibility](#24-migrations-rollback-and-compatibility)
25. [Open decisions](#25-open-decisions)
26. [Acceptance criteria](#26-acceptance-criteria)
27. [Exact analysis-time source references](#27-exact-analysis-time-source-references)

## 1. Document conventions

### 1.1 Observed versus proposed

- **OBSERVED-DCP** means behavior found in the installed, compiled OpenCode DCP 3.1.9 package or its README.
- **OBSERVED-OPENCODE** means host behavior found in the checked-out OpenCode source.
- **OBSERVED-PI** means behavior documented or implemented by the installed Pi package.
- **PROPOSED** means this design's Pi adaptation. It is not a claim about either existing product.

This distinction matters: behavioral similarity does not imply identical internals, and several OpenCode assumptions are unsafe in Pi.

### 1.2 Normative words

**MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative. Pseudocode is normative where it expresses validation or ordering, but names may change without changing behavior.

### 1.3 Core vocabulary

- **Persisted context:** Pi's append-only session-tree entries and the `AgentMessage[]` built from the active branch.
- **Outgoing context:** a cloned `AgentMessage[]` about to be sent to a model. DCP changes this only.
- **Pruning:** replacing or omitting outgoing content while retaining original session history.
- **Compression:** model-authored, high-fidelity replacement of a selected closed span with a summary.
- **Pi native compaction:** Pi/harness-generated summarization of old context into a `CompactionEntry`; unlike DCP, this changes future session reconstruction.
- **Block:** a persisted DCP summary plus coverage metadata. An active block replaces covered content in outgoing context.
- **Direct coverage:** messages explicitly selected in a compression request.
- **Effective coverage:** direct coverage plus complete tool-protocol partners and all content inherited from consumed nested blocks.
- **Snapshot:** one immutable, short-lived mapping from ephemeral model references to canonical session identities.
- **Canonical identity:** Pi session entry IDs and tool-call IDs, never model-facing `mNNNN`/`bNNNN` references.

## 2. Problem, vocabulary, and non-goals

### 2.1 What non-destructive outgoing-context DCP is

DCP is a lens over a conversation, not a history editor. Before each provider call it:

1. reconstructs canonical DCP state from the current Pi branch;
2. maps that state onto the exact incoming context snapshot;
3. replaces active compressed spans with summaries;
4. redacts selected stale tool content;
5. injects ephemeral model guidance and references; and
6. returns a new, protocol-valid message array.

The original Pi JSONL entries remain unchanged. `/tree`, `/fork`, export, audit, and user inspection retain raw messages. Decompression merely disables an outgoing replacement; it does not recover deleted data because no raw data was deleted.

### 2.2 DCP compression versus Pi compaction

| Property | DCP `compress` | Pi native/model-generated compaction |
|---|---|---|
| Summary author | Main task model, through an explicit `compress` tool call | Pi's summarization request or extension-provided compaction hook |
| Selection | Model-selected contiguous range (message mode later selects messages) | Host-selected old prefix/cut point |
| Persistence | DCP operation custom entry; outgoing replacement | Pi `CompactionEntry`; changes `buildContextEntries()` |
| Reversible | Yes, while raw entries remain in active built context | Not through DCP; pre-compaction entries cease to be built context |
| Timing | Semantic closure, nudges, or manual model-visible request | Manual `/compact`, threshold, or overflow recovery |
| Scope | Multiple independently nested blocks | One host compaction checkpoint at a time |

A DCP summary MUST be the model's own tool argument. `/dcp compress` MUST ask the model to perform one compression; it MUST NOT fabricate a tool call or an extension-authored summary.

### 2.3 Goals

- Preserve the useful semantics of DCP 3.1.9 on Pi without mutating raw messages.
- Prefer range compression for a safe MVP.
- Make identity, branches, protocol pairs, crash behavior, and native compaction explicit.
- Work in TUI, RPC, JSON, print, persisted, and in-memory sessions with defined degradation.
- Fail closed whenever mapping or safety cannot be established.

### 2.4 Non-goals

- Byte-for-byte reproduction of OpenCode prompts, UI, state files, or internal IDs.
- Preventing Pi's host threshold solely by changing an outgoing `context` event.
- A universal relationship between Pi subagents and parent sessions.
- Provider-exact tokenization for every model.
- Mutating Pi settings or disabling native compaction globally.
- Restoring history that Pi native compaction no longer exposes through `buildContextEntries()`.

## 3. Observed reference behavior

### 3.1 Installed artifact inventory

**OBSERVED-DCP:** the installed package is version **3.1.9**, is **AGPL-3.0-or-later**, and is compiled-only: the published files contain `dist/`, README, and LICENSE, not TypeScript source. Its compiled JavaScript contains 64 files and 6,981 total lines at analysis time. The top-level package exposes an OpenCode plugin and depends on the OpenCode SDK, Anthropic tokenizer, JSONC parser, and Zod.

### 3.2 Full behavioral inventory

**OBSERVED-DCP:**

- Range compression accepts one or more non-overlapping contiguous ranges.
- Experimental message mode independently compresses selected raw messages.
- Range summaries can contain `(bN)` placeholders. Existing block summaries are expanded into the new summary, consumed blocks become inactive children, and direct/effective message and tool coverage is retained.
- `/dcp decompress N` disables an active block or grouped run, can reactivate nested children, and reports restored messages/tokens.
- `/dcp recompress N` re-enables only user-decompressed blocks if origin messages still exist, and may deactivate nested blocks again.
- Deduplication normalizes tool parameters, groups by tool name plus recursively sorted JSON, and prunes all but the newest duplicate output.
- Purge-errors waits a configurable turn age, preserves the error, and replaces string-valued input fields.
- Question pruning removes question input while retaining output/answers.
- Ordinary pruned tool outputs are replaced by a marker; edit/write/question receive special handling.
- Protected tool lists, protected file patterns, optional verbatim user-message protection, and turn protection constrain pruning.
- Compression can append protected tool outputs and protected user messages to the authored summary.
- Context and iteration/turn nudges encourage compression. A max-limit nudge is forceful; reminders are anchored and deduplicated.
- Manual mode blocks autonomous compression; `automaticStrategies` determines whether dedup/purge still run.
- Compression permission is `allow`, `ask`, or `deny`; deny omits the tool. Host permissions can further deny it.
- Six prompts exist: `system`, `compress-range`, `compress-message`, `context-limit-nudge`, `turn-nudge`, `iteration-nudge`. Editable overrides are experimental and disabled by default.
- Notifications can be off/minimal/detailed and chat/toast; session and aggregate pruning statistics are maintained.
- `/dcp`, `context`, `stats`, `sweep [N]`, `manual [on|off]`, `compress [focus]`, `decompress [N]`, and `recompress [N]` are provided.
- Subagent processing is disabled by default. When enabled, the initial subagent instruction is not reference-addressable, and task results can be expanded/cached.

### 3.3 OpenCode 3.1.9 defaults that must be reported

| Setting | Observed default |
|---|---:|
| `enabled` | `true` |
| `debug` | `false` |
| notification | detailed, chat |
| `commands.enabled` | `true` |
| manual mode | disabled; `automaticStrategies: true` |
| turn protection | disabled; 4 turns |
| subagents | disabled |
| custom prompts | disabled |
| protected file patterns | `[]` |
| compression mode | `range` |
| compression permission | `allow` |
| show compression | `false` |
| summary buffer | `true` |
| max context limit | `100000` |
| min context limit | `50000` |
| nudge frequency | 5 |
| iteration threshold | 15 |
| nudge force | `soft` |
| protect user messages | `false` |
| deduplication | enabled |
| purge errors | enabled; 4 turns |

The README says always-protected tool defaults include `task`, `skill`, `todowrite`, `todoread`, `compress`, `batch`, `plan_enter`, `plan_exit`, `write`, and `edit`. Its compression-specific prose says `task`, `skill`, `todowrite`, and `todoread` are protected-summary defaults, while displayed config arrays are empty because those arrays are additions to built-in baselines. Feature lists and defaults therefore vary by protection surface; an implementation MUST test the effective union, not assume every list is the same.

## 4. Observed OpenCode/Pi architecture comparison

| Concern | OpenCode / DCP observed | Pi observed | Consequence for proposed design |
|---|---|---|---|
| Hook surface | Plugin hooks mutate OpenCode `{info, parts}` records through system/messages/chat/command/event hooks | Extension lifecycle with `before_agent_start`, `context`, message/turn/agent, session, compaction hooks | Adapt behavior, do not translate record mutations literally |
| Host API | SDK client fetches session messages and sends notifications | Read-only `ctx.sessionManager`; extension API sends messages/appends custom entries | No remote fetch is needed for current session; no host config mutation |
| Identity | Mutable messages and parts carry message IDs and call IDs | Session entries carry stable IDs; `context` only contains copied `AgentMessage[]` with no entry IDs | Identity projection is the central problem |
| Tool protocol | Tool part can contain call/input/status/output together | Assistant `toolCall` blocks and separate `toolResult` messages | Every transform must preserve both halves |
| Persistence | DCP sidecar state keyed by OpenCode session | Pi JSONL is an append-only tree; custom entries share the branch | Canonical state belongs in branch custom entries, not a sidecar |
| Context mutation | In-place output transform | `context` receives a deep copy and may return replacement messages | Always clone and return; extension ordering remains observable |
| Config/permission | DCP JSONC plus host permission mutation/ask API | Global/project Pi settings and trust; extension UI; no generic host tool permission policy to mutate | Own JSONC, explicit UI policy, never edit Pi config |
| Compaction | OpenCode compaction and plugin message transform | `manual|threshold|overflow` hooks with `willRetry`; append-only compaction entries | Define cancellation and rebasing conservatively |
| Branching | Session/message IDs exposed by SDK | `getBranch()` and `buildContextEntries()` differ; `/tree`, fork, clone, compaction | Replay only active branch and orphan blocks outside built context |
| UI modes | Chat/toast client calls | TUI, RPC, JSON, print; `hasUI` differs from TUI capability | Permission and command degradation must be mode-specific |
| Subagents | OpenCode task sessions have discoverable parent/child assumptions | Pi only supplies an example that launches independent agents; no universal protocol | Independent by default; future opt-in bridge only |

Pi's agent state is reconstructed from session context on lifecycle changes, but it remains an `AgentMessage[]`, not a mutable database. Pi's `context` transform occurs before each provider call. Pi tool calls may run in parallel by default, though a custom tool can request `executionMode: "sequential"`.

## 5. Normative requirements

1. **History safety:** DCP MUST NOT alter/delete existing Pi message, compaction, or branch-summary entries.
2. **Canonical state:** versioned `pi.appendEntry("pi-dcp.operation", ...)` operations on the current branch MUST be authoritative.
3. **Branch isolation:** reconstruction MUST replay DCP operations from `getBranch()` only, in branch order.
4. **No persisted aliases:** `mNNNN`, `bNNNN`, array indexes, fingerprints, and timestamps MUST NOT be canonical identities.
5. **Heuristic boundary:** outside exact host projection and stable tool-call IDs, identity joining is heuristic. Ambiguous or unavailable canonical mapping MUST disable all DCP pruning/compression for that request, return an untouched clone, append no operation, and emit a diagnostic.
6. **Protocol:** DCP MUST never create a half tool exchange. Settled pairs transformed by DCP remain complete; host-supported pending/incomplete forms are preserved untouched.
7. **Immutability:** transforms MUST return clones and MUST NOT mutate `event.messages` or session objects.
8. **Sequential mutation:** `compress` MUST have `executionMode: "sequential"` and use a per-session async mutex shared with commands and lifecycle rebases.
9. **Snapshot validation:** every compress call MUST name the current snapshot ID; stale, expired, wrong-branch, wrong-session, or wrong-model snapshots MUST be rejected.
10. **Summary authorship:** only the model-provided summary argument becomes a DCP block summary.
11. **Safe native compaction:** DCP MUST never cancel manual or overflow compaction.
12. **Trust:** untrusted project configuration MUST NOT be read or applied.
13. **Permission:** deny MUST keep `compress` inactive and reject execution defensively; ask without `ctx.hasUI` or a successful `ctx.ui.confirm()` MUST deny.
14. **Best-effort durability:** each mutation MUST fit in one self-contained custom operation entry. Pi exposes no transactional/awaited append acknowledgement, so the design MUST NOT claim exactly-once or atomic durable commit.
15. **Malformed state/config:** use last known-good/default behavior and fail closed for pruning, never guess.
16. **Privacy:** raw content, summaries, paths, and tool arguments MUST be absent from normal logs and aggregate stats.

## 6. Proposed package and module layout

```text
pi-dcp/
├── DESIGN.md
├── LICENSE                 # route chosen in legal review
├── README.md
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts            # extension factory; registrations only
│   ├── lifecycle.ts        # Pi event wiring
│   ├── config/
│   │   ├── defaults.ts
│   │   ├── schema.ts
│   │   └── load.ts
│   ├── identity/
│   │   ├── project.ts      # SessionEntry -> projected message identities
│   │   ├── fingerprint.ts
│   │   ├── join.ts
│   │   ├── protocol.ts
│   │   └── snapshot.ts
│   ├── state/
│   │   ├── operations.ts
│   │   ├── reducer.ts
│   │   ├── reconstruct.ts
│   │   ├── checkpoint.ts
│   │   └── cache.ts        # optional, non-canonical sidecar
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
│   │   └── purge-errors.ts
│   ├── prompts/
│   │   ├── defaults.ts
│   │   ├── store.ts
│   │   └── nudge.ts
│   ├── commands/
│   │   ├── index.ts
│   │   ├── context.ts
│   │   ├── stats.ts
│   │   ├── sweep.ts
│   │   ├── manual.ts
│   │   └── blocks.ts
│   ├── ui/notify.ts
│   ├── tokens/estimate.ts
│   ├── security/summary.ts
│   └── observability/logger.ts
└── test/
    ├── unit/
    ├── property/
    ├── golden/
    ├── integration/
    └── fixtures/
```

Proposed manifest shape:

```json
{
  "name": "@scope/pi-dcp",
  "type": "module",
  "keywords": ["pi-package", "context", "compression"],
  "files": ["src", "README.md", "LICENSE"],
  "pi": { "extensions": ["./src/index.ts"] },
  "peerDependencies": {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-agent-core": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  },
  "dependencies": {
    "jsonc-parser": "^3.3.1"
  }
}
```

Pi peers MUST use `"*"` and MUST NOT be bundled. `jsonc-parser` is a runtime dependency. A tokenizer MAY be added after license/size/model evaluation.

## 7. Proposed runtime architecture

### 7.1 Session runtime

```ts
interface DcpRuntime {
  sessionId: string;
  sessionFile?: string;
  branchLeafId: string | null;
  generation: number;
  config: EffectiveConfig;
  reduced: ReducedState;
  index: CanonicalIndex;
  snapshot?: ContextSnapshot;
  mutex: AsyncMutex;
  pendingManual: null | { nonce: string; focus?: string; createdAt: number };
  lastTransform?: TransformMetrics;
}
```

There is one runtime per loaded extension/session instance. Session replacement and reload invalidate the old instance. No timer or watcher starts in the factory.

### 7.2 Lifecycle mapping

| Pi event | Proposed action |
|---|---|
| factory | Register commands and the sequential `compress` definition, but do not assume it is active. Load no project files and start no resources. Pi permits later tool registration and active-set changes; this design registers once so config changes do not require redefining the tool. |
| `session_start` startup/new/resume/fork/reload | Acquire mutex; load effective trusted config; replay `getBranch()` operations; project `buildContextEntries()`; mark unavailable block coverage orphaned; clear snapshots/pending prompts; set status; validate state; add or remove `compress` from `pi.getActiveTools()` via `pi.setActiveTools()` according to enabled/permission policy. Execution also rechecks policy. Fork starts from entries actually copied by Pi, not parent sidecars. |
| `session_before_tree` | Invalidate snapshot before navigation; do not write state. |
| `session_tree` | Replay only new `getBranch()`; rebase against `buildContextEntries()`; orphan non-built blocks; increment generation. Branch summary is ordinary context and can later be compressed. |
| `session_before_fork` / `session_before_switch` | Invalidate snapshots and reject new mutations; no canonical write. |
| `before_agent_start` | Build chained DCP system guidance if enabled; consume exactly one valid pending manual nonce into an ephemeral instruction; never persist nudge messages. |
| `turn_start` | Record in-memory turn boundary and invalidate snapshot made for a prior turn. |
| `context` | Execute the exact pipeline in section 10; publish a new immutable snapshot for the transformed request. |
| `tool_call` | No DCP interception is required for its own tool; compression execute validates the snapshot. Other tools are observed only through persisted messages later. |
| `turn_end` | Update turn/settled counters from canonical entries; no pruning write unless an explicit automatic strategy decision is materialized. |
| `agent_settled` | Flush optional aggregate counters/cache atomically; clear one-turn UI indicators. |
| `model_select` | Invalidate snapshots; recalculate limits/tokenizer; increment generation. |
| `session_before_compact` | Apply policy in section 16. |
| `session_compact` | Invalidate snapshot, replay/rebase, orphan old unreachable blocks, and never reactivate them on retry. |
| `session_shutdown` | Invalidate runtime, clear UI, stop resources, finish/abort cache write; canonical operations are already appended. |

No state transition relies solely on `agent_end`, because Pi may retry, compact, or process follow-ups before `agent_settled`.

## 8. Canonical identity and snapshots

### 8.1 Why this is critical

Pi session entries have IDs, but `ContextEvent.messages` does not. A message's text/timestamp is not unique. Compaction entries project to summary messages; custom entries project to none; tool calls and results are separate messages. Other extensions may transform context before pi-dcp. Therefore array position alone is unsafe.

### 8.2 Canonical identities

```ts
type EntryId = string;      // Pi SessionEntry.id
type ToolCallId = string;   // Assistant ToolCall.id / ToolResult.toolCallId

type CanonicalMessageKey =
  | { kind: "entry"; entryId: EntryId; projection: number }
  | { kind: "retained"; compactionEntryId: EntryId; projection: number };

interface ProtocolUnit {
  key: string; // hash of ordered canonical keys + toolCallIds
  entryIds: EntryId[];
  messageKeys: CanonicalMessageKey[];
  toolCallIds: ToolCallId[];
  startProjectedIndex: number;
  endProjectedIndex: number;
}
```

Entry IDs plus projection ordinal identify projected messages. Tool-call IDs are canonical correlation keys, not replacements for entry IDs. For current Pi versions, a normal message entry projects once, a custom entry zero times, and compaction/branch entries project according to `sessionEntryToContextMessages()` semantics. The implementation MUST isolate this adapter and version-test it.

### 8.3 Deterministic projection and join

1. Read `entries = sessionManager.buildContextEntries()` once.
2. Project each entry with a local adapter matching Pi's documented projection. Record entry ID and projection ordinal beside every expected `AgentMessage`.
3. Build tool maps:
   - each assistant `toolCall.id -> assistant canonical key`;
   - each tool result `toolCallId -> result canonical key`;
   - reject duplicate call IDs, missing partners, name mismatches, or impossible ordering.
4. Join the expected projection to incoming `event.messages` using ordered evidence:
   - **Tier A:** exact ordered tool-call ID sets and tool-result IDs;
   - **Tier B:** exact structural fingerprint and occurrence count;
   - **Tier C:** monotonic position/LCS constraints among already anchored neighbors.
5. This is a heuristic adapter, not identity supplied by Pi. Only exact unmodified projections and stable tool-call correlation provide strong evidence. A transform-tolerant text-only match MAY support display diagnostics, but MUST NOT authorize compression or pruning unless unique exact anchors establish every affected protocol unit. Arbitrary deletion/reordering is never guessed.
6. If more than one complete monotonic mapping has the same evidence score, an affected content-only item lacks exact canonical mapping, an expected protocol unit maps partially, or any mapping is otherwise unavailable, fail closed for the entire DCP transform: return an untouched clone, inject no aliases/nudges, and append no operation.

Structural fingerprint pseudocode:

```ts
fingerprint(m): string = sha256(canonicalJson({
  role: m.role,
  text: normalizedTextBlocks(m),       // normalize line endings only; do not trim meaning
  images: imageBlocks(m).map(i => [i.mimeType, sha256(i.data)]),
  thinking: thinkingBlocks(m).map(t => sha256(t.thinking)),
  calls: toolCalls(m).map(c => [c.id, c.name, canonicalJson(c.arguments)]),
  result: m.role === "toolResult"
    ? [m.toolCallId, m.toolName, m.isError, contentShape(m)] : null,
  custom: m.role === "custom" ? m.customType : null,
  model: m.role === "assistant" ? [m.provider, m.model, m.api, m.stopReason] : null
}))
```

A secondary transform-tolerant fingerprint omits text payload hashes, but is diagnostic-only and MUST NOT authorize a mutation. Occurrence numbers are calculated within equal fingerprints; positions are tie-break constraints, never identities. This deliberately sacrifices compatibility with some earlier context-transforming extensions rather than risk pruning the wrong content.

### 8.4 Protocol units and model-facing references

A protocol unit is either one non-tool message or one assistant message containing tool calls plus every corresponding tool-result message. Multiple calls from one assistant response belong to one unit. `m0001` refers to a unit, not an arbitrary array element, avoiding model selection of half a protocol.

```ts
interface ContextSnapshot {
  schema: 1;
  snapshotId: string;       // random 128-bit or SHA-256-derived opaque ID
  snapshotHash: string;     // hash of session, branch, model, generation, units, active blocks
  sessionId: string;
  branchLeafId: string | null;
  modelKey: string;
  generation: number;
  createdAt: number;
  expiresAt: number;
  units: readonly SnapshotUnit[];
  messageRefs: ReadonlyMap<`m${string}`, string /* ProtocolUnit.key */>;
  blockRefs: ReadonlyMap<`b${string}`, string /* canonical block opId */>;
}
```

Aliases are allocated from visible oldest to newest (`m0001...`) and active blocks by outgoing anchor order (`b0001...`). They are ephemeral for this immutable snapshot, can change on the next request, and MUST never be persisted in an operation. Default TTL is 10 minutes and one provider-turn generation; any new context snapshot supersedes the old one. The tool schema requires `snapshotId`, and the model receives it in DCP metadata.

The snapshot hash MUST include the active branch leaf, ordered canonical unit keys, tool-call IDs, active block operation IDs/versions, model provider/id/context window, config safety hash, and transform generation. It MUST exclude full raw text from logs, though the in-memory hash input may include content digests.

### 8.5 Validation and stale rejection

```ts
validateSnapshot(call): Snapshot {
  require(runtime.snapshot?.snapshotId === call.snapshotId)
  require(now <= snapshot.expiresAt)
  require(snapshot.sessionId === currentSessionId)
  require(snapshot.branchLeafId === sessionManager.getLeafId())
  require(snapshot.generation === runtime.generation)
  require(snapshot.modelKey === currentModelKey)
  require(recomputeProjectionHash() === snapshot.snapshotHash)
  require(all refs exist exactly once)
  return snapshot
}
```

Stale rejection is a normal tool error: “Context snapshot changed; inspect the latest references and retry once.” It MUST NOT write an operation. Tests must cover custom messages, branch summaries, compaction summaries, fork/clone, tree navigation, repeated identical messages, earlier context transforms, model changes, and tool calls with parallel results.

## 9. Canonical persisted state and reducer

### 9.1 Choice

**PROPOSED:** Pi custom entries are canonical. A mutable sidecar is at most a disposable acceleration cache. Compress tool result `details` are an audit receipt only, because results can be absent after a crash and coupling state reconstruction to tool protocol makes command operations awkward.

Only entries with `type === "custom" && customType === "pi-dcp.operation"` from `sessionManager.getBranch()` are replayed. `getEntries()` MUST NOT be used for state reconstruction because it includes abandoned branches.

### 9.2 Operation envelope and schemas

```ts
interface OpEnvelope<T extends DcpOperation> {
  schema: 1;
  opId: string;             // UUID; reducer idempotency key
  sessionId: string;
  createdAt: number;
  extensionVersion: string;
  operation: T;
}

type DcpOperation =
  | CompressCreated
  | BlockActivationChanged
  | ToolsPruned
  | ManualModeChanged
  | StateCheckpoint;

interface CanonicalCoverage {
  directEntryIds: EntryId[];
  effectiveEntryIds: EntryId[];
  directToolCallIds: ToolCallId[];
  effectiveToolCallIds: ToolCallId[];
}

interface CompressCreated {
  type: "compress.created";
  blockId: string;          // durable UUID/op-derived ID, not bNNNN
  runId: string;            // groups ranges from one call
  mode: "range" | "message";
  topic: string;
  summary: string;
  summaryTokens: number;
  coverage: CanonicalCoverage;
  anchor: { beforeEntryId?: EntryId; afterEntryId?: EntryId };
  consumedBlockIds: string[];
  parentBlockIds: string[];
  model: { provider: string; id: string };
  snapshotHash: string;
}

interface BlockActivationChanged {
  type: "block.activation";
  blockIds: string[];
  active: boolean;
  cause: "user-decompress" | "user-recompress" | "nested-consumption" | "orphan-rebase";
}

interface ToolsPruned {
  type: "tools.pruned";
  toolCallIds: ToolCallId[];
  reason: "dedup" | "old-error" | "sweep";
  estimatedTokens: number;
}

interface ManualModeChanged {
  type: "manual.changed";
  enabled: boolean;
}

interface StateCheckpoint {
  type: "checkpoint";
  reducerVersion: number;
  throughOpIdsHash: string;
  state: SerializedReducedState;
}
```

Operations store canonical IDs and summary text, never `m`/`b` references. A checkpoint is optional and itself canonical, but only valid if its branch-prefix hash matches. Implementations MUST first ship replay without checkpoints; add checkpoints only after equivalence tests.

### 9.3 Append/journal sequence and crash behavior

For a compression call:

1. validate and compute the complete next state without mutating memory;
2. append one self-contained batch envelope containing every range; Pi has no multi-entry transaction, so one entry is required for mutation-level coherence;
3. after the synchronous `appendEntry()` call returns, swap the in-memory reduced state, while making no claim that bytes have been durably flushed;
4. return a tool receipt whose `details` includes op IDs, block IDs, estimated token delta, and snapshot hash.

Pi's `pi.appendEntry()` returns `void` and exposes no awaited durability acknowledgement, transaction, entry ID, or atomic batch API. Therefore one mutation MUST be encoded as one fully self-contained operation envelope (including all ranges), and IDs/request keys MUST be generated before append. Update the in-memory reducer immediately after the synchronous call returns, while treating durable crash consistency as host-dependent and best-effort. On replay, an entry present in the branch is authoritative; a crash before Pi persists it may lose that mutation, and a retry may duplicate it. Deterministic request keys (`sessionId + toolCallId + snapshotHash`) and `opId` make observed duplicates idempotent, but cannot promise exactly-once persistence. Conflicting duplicate IDs mark state corrupt and disable pruning. Tool-result `details` remains an audit receipt, not a second commit log.

For in-memory sessions, append entries still provide branch-local state for the process, but shutdown loses it by host definition. The UI MUST label stats “ephemeral.” No sidecar may silently make an in-memory Pi session persistent.

### 9.4 Reducer invariants

- A block ID is created once.
- Active blocks have non-empty, valid summaries and all effective coverage is in the current `buildContextEntries()` projection.
- Active block effective coverage cannot partially overlap another active block; nesting consumes the enclosed block.
- Decompress may reveal consumed children only if their coverage is still available and they were not user-decompressed.
- Recompress applies only to blocks explicitly user-decompressed and still available.
- Orphaned blocks remain inactive until a future explicit migration; ordinary replay MUST NOT resurrect them.
- Tool pruning is a set keyed by tool-call ID; repeated reasons are idempotent.
- Unknown future operation versions are not ignored silently: stop replay at that point, disable mutation, and show a migration error.

## 10. Context pipeline and protocol invariants

### 10.1 Exact proposed pipeline

Under the session mutex for each `context` event:

```text
0. Deep-clone incoming AgentMessage[]; set a no-op fallback.
1. Replay/reconcile branch if leaf or custom-op suffix changed.
2. Project buildContextEntries() and uniquely join it to incoming messages.
3. Build complete protocol units; validate provider-neutral call/result invariants.
4. Reconcile/orphan active blocks against visible canonical IDs.
5. Apply active range blocks, oldest anchor first; insert summaries.
6. Apply persisted tool-output/input redactions (dedup, purge errors, sweep).
7. Compute token/category estimate on the would-send base context.
8. Choose ephemeral nudge anchors and reminder content.
9. Build immutable snapshot and ephemeral mNNNN/bNNNN metadata.
10. Inject metadata only at protocol-safe boundaries.
11. Run final protocol validator and size/role validator.
12. Return cloned messages; on any error return the untouched clone.
```

Compression decisions are not persisted on every context build. Only mutation events/checkpoints are journaled.

### 10.2 Summary insertion

An active block replaces its effective units with one ephemeral, complete Pi `CustomMessage` at the first covered unit's anchor:

```ts
{
  role: "custom",
  customType: "pi-dcp.summary",
  content: boundedSummaryText,
  display: false,
  details: { snapshotBlockRef }, // not provider-visible after Pi conversion
  timestamp: deterministicAnchorTimestamp
}
```

It is returned only from `context`; it is never created with `pi.appendEntry()` (which creates a context-invisible `CustomEntry`) and is not persisted with `pi.sendMessage()`. Content contains a bounded header, topic, summary, and durable-in-snapshot block alias, with no host-executable interpretation.

Pi's `convertToLlm()` normally converts custom messages to provider-compatible messages. If a supported provider requires a user-text representation, the tested compatibility adapter MAY produce that representation only at a complete protocol boundary; this semantic role change must have provider golden tests. It MUST NOT insert between a tool-calling assistant and its results. Adjacent summaries may be coalesced only for serialization, while retaining separate block refs.

### 10.3 Tool protocol rules

For each **settled historical** outgoing assistant tool call `{id,name}`, exactly one corresponding outgoing tool result is REQUIRED whenever DCP transforms that unit. Result `toolCallId` and `toolName` must match. Ordering remains assistant call before results, and sibling results from one assistant call batch remain together and in source order. Pi/provider-supported pending, streaming, aborted, or otherwise incomplete forms are preserved byte-for-structure and are uncompressible/unprunable; DCP does not reject an otherwise valid host request merely because such a current form exists.

A transform may redact content but MUST retain:

- assistant tool-call block ID, name, and a valid argument object;
- tool result role, `toolCallId`, `toolName`, `isError`, timestamp, and a non-empty text marker;
- image/type shape acceptable to the provider.

No transform may drop only the assistant or only a result. Effective coverage expands to the full protocol unit. If expansion causes two requested ranges to overlap, reject the whole compression call.

### 10.4 Safe content handling

- Text is cloned. Thinking blocks are retained unless their entire assistant protocol unit is compressed; DCP does not selectively redact thinking in MVP.
- Images are retained by default. Compression of a unit containing images requires the summary to pass normal validation, but raw image data may then be omitted with the unit; `protectUserMessages` keeps user image blocks verbatim as well as text.
- Unknown/custom roles or unknown content block types are preserved and marked uncompressible. Never cast-and-drop.
- Bash execution and branch/compaction/custom messages are supported through the projection adapter and conservative role handling.
- Empty content after redaction receives a plain text marker.

### 10.5 Redaction forms

Completed stale output:

```ts
content = [{type:"text", text:"[Old tool result content cleared by pi-dcp]"}]
// retain toolCallId, toolName, isError=false, details omitted from outgoing clone
```

Errored input: only replace **string-valued fields in a valid plain-object argument map**. Arrays, numbers, booleans, null, unknown prototypes, and the argument object itself are retained. The error result text is retained. If arguments are a serialized string or malformed, do not edit them; skip and diagnose. This avoids turning valid tool-call JSON into an invalid provider payload.

Question tool: replace a recognized `questions` string/array input with a bounded marker only after a result exists; preserve the result containing user answers. Unknown question schemas are not modified.

Write/edit/path protection: effective baseline always protects `write` and `edit` from sweep/dedup output pruning and protects any tool whose normalized path argument matches configured globs. Recognized path keys include `path`, `filePath`, `filepath`, `target`, and nested edit items; path extraction is tool-specific, never arbitrary recursive string matching. Relative paths are normalized against `ctx.cwd` for matching but raw values are not logged.

### 10.6 Extension ordering and cache tension

Pi runs context handlers in extension load order. Earlier extensions may make identity joining impossible; later extensions may undo DCP, insert content, or break protocol. pi-dcp can only guarantee its own returned array. Documentation SHOULD recommend loading pi-dcp late and a diagnostic SHOULD fingerprint its output for comparison at the next turn where possible. There is no host “final transform” hook.

Any replacement invalidates provider prefix caches from the first changed message. Stable summary text, deterministic ordering, no timestamps in outgoing summaries, and nudges anchored only when needed reduce churn. Snapshot aliases/IDs SHOULD be placed as late and sparsely as possible; they still create a cache trade-off. DCP values token reduction over perfect prefix caching, and metrics must report estimated changed-prefix position.

## 11. Compression algorithm

### 11.1 TypeBox tool schema (range MVP)

```ts
const CompressRangeSchema = Type.Object({
  snapshotId: Type.String({ minLength: 16, maxLength: 128 }),
  topic: Type.String({ minLength: 1, maxLength: 120 }),
  content: Type.Array(Type.Object({
    startId: Type.String({ pattern: "^(m\\d{4}|b\\d{4})$" }),
    endId: Type.String({ pattern: "^(m\\d{4}|b\\d{4})$" }),
    summary: Type.String({ minLength: 1, maxLength: 100000 })
  }, { additionalProperties: false }), { minItems: 1, maxItems: 16 })
}, { additionalProperties: false });
```

The registered tool has `name: "compress"`, a clear model-facing description, `executionMode: "sequential"`, and no file mutation. TypeBox is used directly; string enums, if introduced, use Pi's Google-compatible `StringEnum`.

Message mode's future schema replaces each range with `{messageId, topic, summary}`. It remains experimental and out of MVP because independent message removal complicates protocol grouping, overlap, summary placement, and readability.

### 11.2 Validation order

Under the mutex:

1. validate TypeBox shape and configured permission/manual nonce;
2. validate snapshot and recompute its projection hash;
3. resolve every alias to protocol unit/block, never persisted aliases;
4. validate start precedes end and direct ranges are contiguous and non-overlapping;
5. expand boundaries to effective protocol units;
6. enforce turn protection (last N user turns), latest active user intent, protected tools/files, optional user protection, and unresolved/pending tool exclusion;
7. derive nested blocks whose effective coverage is wholly inside the range;
8. reject partial block intersection;
9. parse `(bNNNN)` placeholders and require exactly one for each nested selected block and none outside it;
10. validate summary safety and limits;
11. expand placeholders in chronological order and append missing protected content according to policy;
12. calculate effective coverage, anchor, token estimates, and resulting active-set invariants;
13. append one self-contained operation entry; update memory best-effort; invalidate snapshot; notify; return receipt.

### 11.3 Range, coverage, and anchors

A range is contiguous in snapshot protocol-unit order, inclusive. If boundaries are block aliases, start/end resolve to that block's first/last effective unit. Direct coverage is the explicit unit span before nested inheritance. Effective coverage is:

```text
direct units
∪ complete call/result partners
∪ effective coverage of every consumed active nested block
```

The replacement anchor is the gap before the first effective unit, represented by neighboring canonical entry IDs. Both neighbors are stored when available so deletion/compaction can be detected. The anchor is valid only if those neighbors still bracket the coverage during transform.

### 11.4 Nested blocks

Each active block in the selected span is required once as `(bNNNN)`. Placeholder expansion substitutes the full stored wrapped summary, not raw history. The new block records consumed durable block IDs, and consumed blocks become inactive with a parent relation. Expansion MUST be bounded by `summary.maxExpandedChars` and `summary.maxNestedDepth`; default 200,000 characters and depth 8. Cycles, duplicate placeholders, missing placeholders, out-of-range placeholders, or expansion overflow reject the operation.

Unlike repeated free-form resummarization, expansion preserves the earlier model-authored record verbatim inside the new authoritative record. The outer summary must read coherently after replacement. If a protected-output appendix would duplicate an inherited appendix, deduplicate by canonical tool-call ID, not text.

### 11.5 Decompression/reactivation/recompression

- **Decompress:** target an active block/run; append one `block.activation(active:false,cause:user-decompress)` operation. Recompute active descendants: reveal a consumed child only if it is available, not user-decompressed, and no other active ancestor covers it. Report raw messages/tokens newly visible.
- **Recompress:** only blocks with a user-decompress event and available origin/effective coverage qualify. Append activation true; deactivate descendants it consumes. Report the delta.
- **Nested target:** if it is inside an active ancestor, instruct the user to decompress the ancestor first.
- **Orphan:** if any effective entry is outside current `buildContextEntries()`, neither command may reactivate it.

### 11.6 Manual mode and permission checks

Manual mode permits one compress call only after a valid pending nonce is delivered in the current model-visible instruction. The call consumes the nonce regardless of success after argument validation, preventing parallel/retry amplification. On completion the prompt asks the model to stop. Automatic dedup/purge follow `manualMode.automaticStrategies`.

Ask permission happens after cheap schema/snapshot checks but before summary/state processing. TUI/RPC confirmation names topic, approximate coverage, and token estimate without dumping raw content. Cancellation writes nothing.

## 12. Automatic pruning strategies

### 12.1 Deduplication

At an explicit mutation opportunity (compress execution) and optionally at settled turns if configured, group completed, unpruned tool protocol units by:

```ts
signature = toolName + "::" + canonicalJson(removeUndefinedRecursively(arguments))
```

Preserve array order; sort plain-object keys recursively; distinguish null; reject cyclic/non-JSON input. Keep newest by canonical branch order and add older tool-call IDs to one `tools.pruned(reason:"dedup")` operation. Skip baseline/config protected tools, protected paths, errors, pending calls, and last-N turn protection. Recalculate against the current branch, so stale sidecars cannot prune.

### 12.2 Old errored-input purge

Track a tool's turn from canonical branch user-turn numbering, not hook counters. When `currentTurn - toolTurn >= turns`, append `tools.pruned(reason:"old-error")`. Outgoing transformation preserves the error result and redacts only valid string input fields as section 10.5 specifies. Protected tools/paths and turn-protected calls are skipped.

### 12.3 Sweep

Sweep is explicit and operates on completed protocol units:

- no argument: all eligible tools after the most recent non-DCP user message;
- positive integer N: newest N eligible tools globally on the active built branch;
- invalid/non-positive/multiple arguments: usage error, no fallback.

It respects command protected tools, baseline write/edit protections, protected paths, pending/error special policy, and turn protection. It persists one `tools.pruned(reason:"sweep")` operation.

## 13. Prompting and nudges

### 13.1 System guidance

`before_agent_start` appends concise DCP guidance to the already-chained `event.systemPrompt`: semantic closure criteria, high-fidelity summary requirements, current range schema, protocol-unit meaning, protected content, snapshot/reference rules, and manual/subagent mode. It MUST name `compress` in each flat Pi prompt guideline. It MUST not overwrite another extension's prompt.

Custom prompt keys mirror DCP's six names. Overrides are loaded only when `experimental.customPrompts` is true, are plain UTF-8 text, and have size/NUL/control-character validation. Managed defaults are never overwritten by project content.

### 13.2 Nudge anchors

Nudges are ephemeral custom messages inserted only at safe protocol-unit gaps after identity mapping. Anchor identity is the canonical unit key plus nudge kind and configuration generation. The set exists in memory/snapshot only; it is reconstructed rather than persisted.

- Below minimum limit: no context-limit or periodic reminder.
- At/above minimum: every `nudgeFrequency` eligible context builds may add a soft turn reminder.
- At/above maximum: add max warning at the latest safe anchor on every eligible build until compression, subject to stable dedup.
- Iteration nudge: after `iterationNudgeThreshold` assistant/tool iterations since the last real user turn.
- Turn nudge: after a user turn according to `nudgeForce` (`soft` recommends, `strong` directs).

Never inject between call/result halves. Never count DCP metadata/custom summaries as user turns. Nudges contain no persisted `m` references from another snapshot.

### 13.3 `/dcp compress` model-visible request

The command MUST use `pi.sendUserMessage()` to send a real user-visible instruction, such as “Perform exactly one DCP compression now; focus: …”. It sets a pending nonce immediately before sending; `before_agent_start` consumes that nonce for the resulting turn. It does **not** use `sendMessage`, invoke `execute`, append a synthetic assistant tool call, or author a summary. If sending throws, clear the nonce and report failure; a nonce expires if no matching turn starts.

- Idle TUI/RPC: call `pi.sendUserMessage(text)`; it immediately starts a turn.
- Streaming: call `pi.sendUserMessage(text, { deliverAs: "followUp" })`; `deliverAs` is required while streaming, and follow-up avoids steering into a running protocol batch.
- Command handler can call the captured `pi.sendUserMessage`; if using a replacement-session context, use only that new context.
- Print/JSON: command invocation is generally not an interactive built-in flow; if an extension command is received through the host prompt path, it may send a turn, but ask permission without UI denies. Emit machine-readable/log-safe feedback.
- If another manual request is pending, reject rather than queue multiple grants.

## 14. Configuration and permissions

### 14.1 Layering and trust

Proposed search/merge order, lowest to highest:

1. compiled defaults;
2. global `${PI_CODING_AGENT_DIR or ~/.pi/agent}/dcp.jsonc` then `dcp.json` (JSONC wins if both exist);
3. project `join(ctx.cwd, CONFIG_DIR_NAME, "dcp.jsonc")` then `.json`, **only when `ctx.isProjectTrusted()` is true**;
4. future CLI flags, if added.

Merge is deep by known schema keys; arrays replace rather than concatenate. Built-in protected baselines are unioned after merge. Unknown keys generate a warning. Parse/type/range failure rejects that whole layer and retains the previous valid layer; it never partially applies malformed security settings. Config contains no executable commands or environment interpolation.

Pi settings are not modified. The extension MUST import `CONFIG_DIR_NAME`, not hardcode `.pi`. Config is loaded at `session_start`. `/dcp reload` calls `await ctx.reload(); return`; reload does not replace the currently executing handler frame, so no old runtime state may be touched after the await. Pi supports dynamic `registerTool()` and `setActiveTools()` without reload; this design uses reload for clean config/runtime reconstruction, not because the host requires it.

### 14.2 Full proposed defaults

The proposal intentionally starts with the observed DCP values unless noted.

| Key | Default | Validation/meaning |
|---|---|---|
| `enabled` | true | master outgoing transform |
| `debug` | false | metadata-only debug logs |
| `pruneNotification` | `detailed` | `off|minimal|detailed` |
| `pruneNotificationType` | `chat` | mapped to Pi notify/custom entry; no literal toast API |
| `commands.enabled` | true | register `/dcp` |
| `commands.protectedTools` | `[]` | additions to baseline |
| `manualMode.enabled` | false | autonomous model compress allowed |
| `manualMode.automaticStrategies` | true | dedup/purge still run |
| `turnProtection.enabled` | false | protect recent turns |
| `turnProtection.turns` | 4 | integer 1..100 |
| `experimental.allowSubAgents` | false | future protocol only |
| `experimental.customPrompts` | false | prompt files ignored |
| `experimental.messageMode` | false | required in addition to mode `message` |
| `protectedFilePatterns` | `[]` | bounded glob strings |
| `compress.mode` | `range` | `range|message`; message gated |
| `compress.permission` | `allow` | `allow|ask|deny` |
| `compress.showCompression` | false | avoid leaking summary in notifications |
| `compress.summaryBuffer` | true | active summary tokens extend soft max calculation |
| `compress.maxContextLimit` | 100000 | positive integer or `N%` |
| `compress.minContextLimit` | 50000 | positive integer or `N%`, <= max |
| `compress.modelMaxLimits` | absent | `provider/model -> limit` |
| `compress.modelMinLimits` | absent | same |
| `compress.nudgeFrequency` | 5 | integer 1..1000 |
| `compress.iterationNudgeThreshold` | 15 | integer 1..1000 |
| `compress.nudgeForce` | `soft` | `soft|strong` |
| `compress.protectedTools` | `[]` | additions; baseline adaptation below |
| `compress.protectUserMessages` | false | preserve text/images verbatim |
| `strategies.deduplication.enabled` | true | persisted decisions |
| `strategies.deduplication.protectedTools` | `[]` | additions |
| `strategies.purgeErrors.enabled` | true | old error input only |
| `strategies.purgeErrors.turns` | 4 | integer 1..100 |
| `strategies.purgeErrors.protectedTools` | `[]` | additions |
| `snapshot.ttlMs` | 600000 | proposed Pi-only, 10s..1h |
| `summary.maxChars` | 100000 | proposed safety bound |
| `summary.maxExpandedChars` | 200000 | proposed nested bound |
| `summary.maxNestedDepth` | 8 | proposed bound |
| `state.checkpointEvery` | 0 | disabled in MVP |

Effective always-protected baseline retains the DCP names even when currently absent (`task`, `skill`, `todowrite`, `todoread`, `compress`, `batch`, `plan_enter`, `plan_exit`, `write`, `edit`). On Pi, `write`, `edit`, and `compress` are immediately relevant. Compression-summary appendix baseline is `task`, `skill`, `todowrite`, `todoread`; unknown tools are harmless names. Feature-specific arrays add to, not replace, baselines.

### 14.3 Permission behavior

- **allow:** keep registered `compress` active and execute after validations without UI.
- **ask:** keep it active; each compression calls `await ctx.ui.confirm(...)` only when `ctx.hasUI` is true. TUI/RPC use the supported UI request; false, timeout, cancellation, disconnect, or thrown UI error denies. JSON/print have `hasUI=false` and deny immediately. After waiting, reacquire the mutation mutex and revalidate the snapshot/policy.
- **deny:** remove `compress` from the active tool set with `pi.setActiveTools()` and reject defensively inside `execute` in case a queued/stale call arrives. The definition may remain visible through `pi.getAllTools()` because Pi has no tool-unregister API; it MUST NOT be callable or included among active tools.

Pi has no extension API for mutating a general host permission configuration, so pi-dcp MUST NOT emulate OpenCode by editing settings. Project config cannot surprise an untrusted project. Tool registration and active-set changes can happen dynamically; `/dcp reload` is the chosen clean configuration refresh boundary, not a host necessity. Active-set updates MUST preserve every unrelated currently active tool and avoid disabling another extension's same-named tool; a detected `compress` name collision is a startup error that disables pi-dcp mutation.

## 15. Commands and UI

Register exactly one Pi command name, `dcp`; every operation below is an argument subcommand such as `/dcp context`. Standalone `/context`, `/stats`, or `/sweep` aliases are not registered in the proposed MVP and would require separate `pi.registerCommand()` calls. Parse the first argument token strictly.

| Command | Proposed semantics |
|---|---|
| `/dcp` or `/dcp help` | concise help, current enabled/manual/permission/mode, config paths |
| `/dcp context` | current transformed estimate by system/user/assistant/thinking/tools/images/summaries, active blocks, estimated savings, confidence |
| `/dcp stats` | current branch/session counters; optional aggregate only when explicitly enabled later |
| `/dcp sweep [N]` | section 12.3; mutation under mutex |
| `/dcp manual [on|off]` | no arg toggles; explicit values set; append canonical operation |
| `/dcp compress [focus]` | queue exactly one model-visible request as section 13.3 |
| `/dcp decompress [N|bNNNN]` | no arg lists active blocks; arg deactivates durable target resolved from current display list |
| `/dcp recompress [N|bNNNN]` | no arg lists eligible user-decompressed blocks; arg reactivates |
| `/dcp reload` | reload configuration/extensions; after `await ctx.reload()`, return immediately |

Command `N`/`bNNNN` IDs are ephemeral to the command's freshly generated immutable block-list snapshot. For mutating block commands, the command handler resolves immediately under mutex and displays topic/token estimate before confirmation if needed; it does not persist display IDs.

UI behavior:

- detailed notification: action, block topic, count, estimated before/after/saved, duration, and confidence; summary text only when `showCompression` is true;
- minimal: action and estimated tokens;
- off: no UI, but diagnostics remain available;
- TUI may use `notify` and a status key, not a bespoke component in MVP;
- RPC uses supported notify/status/dialog methods;
- JSON/print never write decorative UI to stdout from the extension; diagnostics use Pi extension errors or stderr logger as appropriate;
- optional custom-entry renderer may show audit operations in TUI without placing them in model context.

## 16. Pi native compaction interaction

### 16.1 Observed host facts

Pi emits `session_before_compact` and `session_compact` for exact reasons `manual`, `threshold`, and `overflow`; `willRetry` identifies overflow recovery that will retry. Pi's threshold is based on persisted agent state and assistant usage/estimation. An outgoing `context` replacement does not rewrite that state, so DCP pruning alone does not necessarily prevent a threshold trigger.

### 16.2 Cancellation policy

```ts
onSessionBeforeCompact(event):
  invalidateSnapshot()
  if event.reason in {"manual", "overflow"}: return undefined // never cancel
  if event.signal.aborted: return undefined
  transformed = safelyBuildFreshTransformedEstimate({
    branchEntries: event.branchEntries,
    preparation: event.preparation, // messagesToSummarize + turnPrefixMessages + retained boundary
    currentBuiltContext: sessionManager.buildContextEntries()
  })
  if transformed.failed || preparationNoLongerMatchesBranch: return undefined
  safeLimit = contextWindow - event.preparation.settings.reserveTokens - configuredSafetyMargin
  if transformed.fullWouldSendContextTokens < safeLimit
     && transformed.includesRetainedTailAndTurnPrefix
     && transformed.confidence === "high"
     && noPendingProtocol
     && snapshot/reducer are current:
       return { cancel: true }
  return undefined
```

Threshold is the only cancellable reason, and cancellation is advisory. It requires a **fresh**, high-confidence estimate of the complete would-send request derived from the event's actual `preparation` and current branch—not prior context metrics or only `messagesToSummarize`. It must account for `turnPrefixMessages`, the retained tail after `firstKeptEntryId`, system/tool-schema overhead where measurable, and response reserve. An aborted signal, stale preparation, omitted retained segment, or uncertain estimate allows compaction. Default safety margin SHOULD be max(4,096 tokens, 5% of context window). Repeated cancellation MUST be rate-limited by branch/config/transformed hash; if the same persisted threshold re-fires without a meaningful context change, allow native compaction to prevent a loop.

Manual compaction expresses user intent and is never cancelled. Overflow compaction is recovery and is never cancelled, especially when `willRetry` is true.

### 16.3 Rebase after compaction

On `session_compact`:

1. acquire mutex and invalidate all snapshots;
2. replay canonical operations from `getBranch()`;
3. project the new `buildContextEntries()`;
4. mark every active block whose effective coverage/anchor is no longer fully projectable as orphaned by appending or deriving `orphan-rebase` deactivation (persist only if not already represented);
5. retain orphan history for audit/stats but never inject its summary and never reactivate it;
6. clear nudge anchors and recalculate token limits;
7. allow Pi's retry to use the newly compacted context without DCP resurrecting pre-compaction raw entries.

A native compaction summary is new context and may be selected in a later DCP block. Old DCP summaries outside `buildContextEntries()` must not be carried forward automatically; Pi's native summary is authoritative for that compacted prefix. Overflow retry safety takes precedence over preserving DCP savings.

## 17. Subagents

There is **no universal Pi subagent relationship**. The documented Pi subagent example starts independent processes/sessions; third-party tools may use different protocols. Therefore MVP treats each Pi session as independent and ignores `allowSubAgents` beyond warning that no bridge is installed.

A future opt-in protocol MAY define:

- a parent tool that passes a signed parent session/operation reference;
- child-local DCP state and snapshot namespace;
- a bounded, explicit final-result import into the parent;
- no direct parent custom-entry writes from a child;
- consent/config at both ends and cycle/depth limits.

Heuristics based on tool name `task`, filesystem session directories, or parent process IDs MUST NOT establish trust or lineage. Subagent prompts and results remain protected by baseline tool policy where such a tool exists.

## 18. Tokens, statistics, notifications, and observability

### 18.1 Estimation

Use Pi `ctx.getContextUsage()` as a reported anchor when current, plus local estimates for transformed deltas. Local estimator order:

1. model/provider tokenizer adapter when available and licensed;
2. conservative UTF-8/text heuristic plus fixed message/tool/schema overhead;
3. image cost reported as unknown/model-dependent, not zero.

Track confidence `reported|tokenizer|heuristic`. Count system prompt, user text, assistant text, thinking, tool arguments, tool result text, image placeholders, custom/branch/compaction summaries, active DCP summaries, and ephemeral nudges/metadata. `summaryBuffer: true` adds active DCP summary tokens to the effective soft max limit, matching the reference intent, but clamps at model context window minus response reserve.

Model-specific min/max entries use exact `provider/model`. Percentage values resolve against current `contextWindow`; invalid/unknown windows disable that nudge rather than guess. Model changes invalidate estimates and snapshots.

### 18.2 Statistics

Canonical per-branch stats derive from operations and current projection: created/decompressed/orphaned blocks, currently hidden raw estimate, summary estimate, net estimate, pruned tools by reason, duration, failed/stale/ambiguous attempts. Session totals may also show cumulative operation deltas, clearly labeled so overlapping/nested blocks are not double-counted.

Cross-session stats are optional, disabled in MVP unless implemented by scanning Pi session files with explicit user request. Never infer all session directories from a mutable DCP sidecar. Concurrent processes may append to different sessions; same-session multi-process access is a host-level risk and caches use file locks/atomic rename if introduced.

### 18.3 Logging

Structured events: `config_loaded`, `replay_complete`, `join_failed`, `snapshot_created`, `compression_rejected`, `operation_appended`, `transform_complete`, `protocol_fallback`, `native_compaction_policy`, `block_orphaned`. Fields include session hash, branch hash, counts, durations, token estimates/confidence, and reason codes. No raw text, summary, file path, image, tool arguments/output, auth, or full session file path.

Debug context dumps are not allowed by default. If a future diagnostic export includes content, it requires an explicit one-shot command, restrictive permissions, redaction warning, and output path confirmation.

## 19. Threat model and summary validation

### 19.1 Threats

- Malicious conversation/tool output instructs the model to compress active requirements or forge refs/placeholders.
- A model invents IDs, omits nested placeholders, changes user intent, or emits enormous summaries.
- Untrusted project config weakens protections or supplies prompt injection.
- Another extension reorders/transforms messages and causes identity confusion.
- Malformed JSONL/custom operations trigger unsafe reducer behavior.
- Crafted tool arguments exploit path globbing/prototypes/serialization.
- Notifications/logs/sidecars leak secrets.
- Provider rejects unusual role/content/protocol ordering.

### 19.2 Controls

- References are environment metadata, resolved only through a current signed/opaque snapshot.
- User/tool content can never create a canonical ID.
- Project config requires Pi trust; prompt overrides are disabled by default and bounded.
- Summaries are treated as untrusted data, never parsed as operations except reserved placeholder tokens.
- Validate Unicode, reject NUL and disallowed controls, normalize line endings, bound chars/tokens/depth/ranges, and escape metadata delimiters.
- Summary MUST NOT be empty or consist only of placeholders. It MUST include all required placeholders exactly once and no unknown placeholder.
- Optional quality checks compare protected terms: short user requirements, paths, tool names, explicit numbers/constraints. Failure requests model retry but does not auto-rewrite the summary. This is heuristic, not proof.
- Never execute summary text, expand shell/env syntax, or use it as a file path.
- Plain-object checks and canonical JSON avoid prototype traversal.
- Final protocol validation and provider compatibility fixtures gate release.
- Fail closed returns the untouched clone; DCP failure must not block the user's ordinary task except the failing compress tool call itself.

There is no reliable automatic proof that a model summary is faithful. User-visible decompression, protected content, conservative selection, and raw-history retention are the recovery mechanisms.

## 20. Risk and design-tension matrix

| # | Risk/tension | Impact | Decision/mitigation |
|---:|---|---|---|
| 1 | Context lacks entry IDs | Wrong content removed | Deterministic projection, tool IDs, fingerprints+occurrence+position; fail closed |
| 2 | Branch tree vs append order | State leaks across branches | Replay `getBranch()` only |
| 3 | Earlier/later context transforms | Mapping failure or post-DCP corruption | Tolerant unique join; recommend late load; final self-validator; cannot guarantee later handlers |
| 4 | Separate tool call/results | Provider protocol failure | Protocol units and effective coverage; never half-drop |
| 5 | Native compaction trigger ignores transformed context | Unexpected compaction | Fresh threshold-only cancellation; never manual/overflow; anti-loop |
| 6 | Permission parity with OpenCode | Ask/deny semantic gap | Own UI policy; no Pi config mutation; deny means no registration per runtime |
| 7 | Commands cannot fake model authorship | Low-quality/non-model summary | `/dcp compress` queues real user turn and nonce |
| 8 | No universal subagent API | Cross-session corruption/privacy | Independent sessions; future signed opt-in protocol |
| 9 | Session dirs/concurrent stats | Races/double counts | Branch-derived stats; aggregate later with locks and explicit scan |
| 10 | Tokenizer/model variance | Bad nudges/cancellation | Confidence levels, safety margin, provider adapter, model invalidation |
| 11 | Prefix cache churn | Higher cost/latency | Stable summaries/order; sparse metadata; report changed-prefix estimate |
| 12 | Malformed summary/state/config | Loss or unsafe pruning | Strict schemas, bounds, stop replay, layer fallback, no mutation |
| 13 | Overflow recovery and retry | Retry loop/resurrected history | Never cancel overflow; rebase/orphan before retry; one host recovery attempt |
| 14 | Reload/model change | Stale closures/snapshots | Shutdown/reconstruct, generation increment; return after reload |
| 15 | Provider strictness | Request rejection | Provider-neutral final validator and golden serialization tests |
| 16 | Thinking/images/custom roles | Silent loss | Preserve unknowns/images by default; unit-level compression only |
| 17 | No UI in JSON/print | Ask deadlock | Ask denies immediately; commands emit nondecorative feedback |
| 18 | Optional sidecar | Canonical divergence | Cache only; content-free where possible; delete-and-rebuild |
| 19 | Security of project prompts/config | Prompt injection | Pi trust, overrides off, bounded plain text, show provenance |
| 20 | License provenance | Distribution obligations | Legal route chosen before implementation; isolate clean-room work |
| 21 | Immutable aliases vs model usability | More metadata and stale calls | snapshot ID+TTL; clear retry error; aliases never durable |
| 22 | Nested expansion vs summary size | Exponential growth | depth/char/token limits; exact placeholders; reject cycles |
| 23 | Protection vs token savings | Large unprunable context | explicit stats/warnings; user controls, safe defaults |
| 24 | Automatic strategies need persistence | Context changes without model call | persist decisions, not each transformed context; deterministic recompute |
| 25 | Tool result receipt vs journal timing | Crash between state and receipt | one self-contained custom op; receipt audit-only; best-effort durability and idempotency key |
| 26 | Pi API evolution/retained tails | Projection mismatch | adapter module, peer `*` but tested version matrix, startup capability check |
| 27 | Summary itself contains instructions | Future model manipulation | wrap as untrusted historical summary; validate delimiters; cannot eliminate semantic injection |
| 28 | Privacy in protected appendices | Secrets retained in model context | protection is explicit; no logs; optional path/user controls documented |

## 21. Delivery phases

### Phase 0 — provenance and feasibility

- Choose license route and record reviewed source set.
- Pin tested Pi versions and capture provider protocol fixtures.
- Build a throwaway projection/join spike, no package release.
- Exit: identity tests pass on ordinary, tool, compaction, branch, and duplicate-message fixtures.

### Phase 1 — safe outgoing redaction foundation

- Package manifest/module skeleton, JSONC config/trust, logger.
- Branch operation journal/reducer and session lifecycle.
- Identity projection, protocol units, immutable snapshots, clone/fail-closed transform.
- Sweep, dedup, purge-errors, protections, context/stats/help/manual commands.
- No model compression yet.
- Exit: all protocol/property tests and branch replay tests pass.

### Phase 2 — range compression MVP

- Sequential TypeBox `compress` tool, permissions, prompts.
- Range validation, model summaries, direct/effective coverage, insertion, journal/receipts.
- `/dcp compress`, notifications, snapshot stale rejection.
- Decompress/recompress without nesting first.
- Exit: end-to-end TUI/RPC range compression is reversible.

### Phase 3 — nested blocks and native compaction

- Placeholder parser/expansion, parent/child reducer, grouped runs.
- Compaction threshold policy, rebase/orphan logic, retry tests.
- Prompt override store and fuller stats.
- Exit: nested golden tests and manual/threshold/overflow integration pass.

### Phase 4 — hardening and compatibility

- Provider serialization matrix, fuzz/property suites, performance profiling.
- Migrations/checkpoints, optional cache, security review, documentation.
- Test Pi updates and extension ordering scenarios.
- Exit: acceptance criteria and rollback drill pass.

### Phase 5 — experimental message mode/future subagent protocol

- Feature flag only after range stability.
- Independent-message grouping still expands full protocol units.
- Design and separately review a signed subagent bridge; not implied by the flag alone.

## 22. Test matrix

### 22.1 Unit tests

- Config: each layer, JSONC comments, unknown keys, wrong types/ranges, arrays replace, trust false, `CONFIG_DIR_NAME`, fallback, model limits.
- Fingerprints: line endings, duplicate text, images, thinking, custom roles, canonical JSON, undefined/null/array order.
- Projection: every `SessionEntry` type; zero/one/many projections; compaction and branch summaries.
- Join: exact, transformed text, unique tool IDs, duplicate occurrence, insertion/deletion/reorder, ambiguous fail closed.
- Protocol: one/many/parallel calls, name mismatch, duplicate/missing result, pending/error/aborted.
- Snapshot: hash components, expiry, supersession, leaf/model/config/reload changes, forged refs, max refs.
- Reducer: all operations, duplicate op, conflicting op, unknown version, checkpoints, nested activation, orphan permanence.
- Range: boundary order, contiguity, overlap before/after protocol expansion, protected turns/users/tools/paths.
- Placeholder: exact set, duplicates, unknown/missing, chronological expansion, cycles/depth/size.
- Redaction: ordinary output, question input, old-error strings only, malformed arguments, write/edit, path keys, images/details.
- Commands: strict parsing, lists, N behavior, pending manual nonce, reload terminal return.
- Tokens: categories, percentages, summary buffer, unknown images/window, confidence and clamps.
- Summary validation: controls, NUL, delimiter escaping, limits, empty/placeholder-only.

### 22.2 Property/fuzz tests

1. Generate valid conversations with arbitrary assistant call batches/results; after any transform, every call/result invariant still holds.
2. Generate append-only trees and random leaf switches; reducer state equals replay of only that branch.
3. Any operation sequence replayed twice yields the same reduced state (idempotency).
4. Compression then decompression restores an outgoing context structurally equivalent to the pre-compression base, excluding independently persisted tool redactions/ephemeral metadata.
5. Recompression after decompression restores the prior active block set when coverage remains.
6. Non-overlapping direct ranges never produce overlapping effective active coverage; otherwise validation rejects.
7. Placeholder parse/format round-trips and never expands an unselected block.
8. Transform never mutates frozen input/session fixtures.
9. Ambiguous joins always return untouched clones and append no operation.
10. Random malformed custom entries/config/summaries never execute code, escape bounds, or crash the host.

### 22.3 Golden tests

- Exact outgoing message JSON for Anthropic, OpenAI responses/completions, Google, and a strict proxy fixture.
- Single range, tool-heavy range, nested range, protected user/images, question, error, dedup, sweep.
- Pi compaction/branch-summary messages before and after DCP.
- Notifications/help/context/stats in detailed/minimal/off and TUI/RPC/non-UI modes.
- Default and custom prompts with metadata escaped.
- Operation JSONL fixtures for every schema version and migration.

### 22.4 Integration tests with Pi

| Scenario | Required assertion |
|---|---|
| persisted session restart | state reconstructs from branch custom entries only |
| in-memory session | works until shutdown; no disk state created |
| `/tree` alternate branches | compression on A absent on B unless operation is shared ancestor |
| `/fork` and `/clone` | only entries copied by Pi define child state; no old runtime objects used |
| `/resume`, `/new`, `/reload` | shutdown/start ordering leaves no stale snapshot or UI |
| streaming `/dcp compress` | one follow-up user request, no fabricated invocation |
| ask in TUI | allow/cancel/timeout produce expected writes |
| ask in RPC | request/response works; disconnect denies |
| ask in JSON/print | immediate deny, no hang |
| parallel tool calls | compress runs sequentially; sibling protocol remains valid |
| native manual compact | never cancelled; blocks rebase/orphan |
| threshold compact | cancel only with fresh safe estimate; anti-loop allows later host compaction |
| overflow `willRetry=true` | never cancelled; no old block resurrection on retry |
| model switch | snapshot rejected and limits recomputed |
| extension before DCP modifies text | unique join succeeds or safe no-op |
| extension before DCP reorders duplicates | safe no-op |
| extension after DCP modifies output | diagnostic limitation documented; host/provider fixture catches protocol failures where observable |
| malformed operation tail | pruning disabled, raw task continues |
| provider strict fixture | no tool protocol/role serialization errors |

### 22.5 Crash tests

Inject process termination: before `appendEntry`; during the host append path; after its synchronous return/before memory swap; after swap/before tool result; during optional cache write; during compaction rebase. Because Pi offers no durability acknowledgement, reopen and assert only documented best-effort outcomes: any fully present operation replays wholly and idempotently; an absent operation leaves raw context; duplicates reduce once; malformed/truncated host entries disable DCP safely. Do not assert exactly-once persistence or that `appendEntry` was an atomic durable commit. Truncated final JSONL handling follows Pi host behavior; pi-dcp must not repair host files itself.

### 22.6 Security/privacy tests

- Malicious refs/placeholders in user/tool text cannot resolve.
- Untrusted project config/prompt files are not read (instrument filesystem access).
- Traversal/glob/prototype payloads do not bypass path protection.
- Logs and aggregate cache pass secret canary scans.
- Summary/control-character and expansion bombs are rejected within time/memory bounds.
- Symlink/path normalization behavior is explicit and conservative; matching protection may over-protect, never under-protect known write/edit paths.

## 23. Performance goals

Measured on a 2,000-message/1,000-tool-result context, excluding provider latency:

- replay from operations: p95 < 50 ms without checkpoint, target < 15 ms with a validated checkpoint;
- projection/join/transform: p95 < 100 ms, O(messages + content bytes), no quadratic duplicate matching;
- incremental unchanged context transform: p95 < 25 ms using immutable projection cache;
- peak additional memory < 2.5x serialized incoming context and < 256 MB for the fixture;
- operation entry < 256 KB under default summary bounds;
- no synchronous filesystem I/O in per-provider `context` path;
- permission UI and commands never hold the transform mutex while waiting except the compression mutation's deliberate serialized section; perform confirmation before final revalidation, then reacquire/revalidate.

Benchmarks must report Node/Pi/model adapter and content sizes. Performance optimizations may cache fingerprints/projections, but cache invalidation cannot weaken snapshot validation.

## 24. Migrations, rollback, and compatibility

- Every operation has envelope schema and extension version; reducer migrations are pure old-op-to-current transformations.
- Unknown newer schema disables DCP writes/transforms for that branch and instructs upgrade; raw context remains available.
- A checkpoint is ignored if version/prefix hash fails; full replay remains the fallback.
- Optional sidecar cache contains session/branch hashes and reduced indexes only; it can always be deleted. Use mode 0600, atomic rename, and no raw content where possible.
- Rollback means disable/uninstall extension or set `enabled:false`; Pi raw session remains intact. Custom entries remain harmless and out of model context.
- A downgrade unable to read newer ops must fail open to raw context, not apply a partial old interpretation.
- Capability checks at startup verify required APIs/events (`context`, custom entries, session IDs/branch/build entries, sequential tools). Missing capabilities disable mutation with one diagnostic.

## 25. Open decisions

1. **License route (release blocker):** compatible AGPL implementation using/deriving from DCP, or clean-room behavioral implementation with separated specification/implementation teams.
2. Exact package scope/name and whether npm ships TypeScript source or compiled output.
3. Tested minimum Pi version and policy for peer `*` versus explicit runtime capability range.
4. Whether sparse alias metadata provides enough model usability without harming caches, and its provider-specific representation.
5. Whether threshold cancellation should ship enabled or opt-in after telemetry; conservative recommendation is opt-in initially.
6. Tokenizer dependency versus heuristic-only MVP.
7. Whether aggregate cross-session stats justify session-file scanning/privacy complexity.
8. Whether operation batches need an explicit multi-range batch schema rather than one entry per block.
9. How to identify “question” tools across third-party names/schemas without unsafe guessing.
10. Whether protected user messages include images by default when `protectUserMessages=true` (this design says yes).
11. Whether prompt overrides are appropriate in the first public release.
12. A future Pi core request for entry IDs on `context` messages or a projection API; this would remove the largest risk.

## 26. Acceptance criteria

Implementation is acceptable only when all are true:

1. The package is discoverable through `pi.extensions`, has `pi-package`, and uses Pi peer dependencies at `*`.
2. It passes the complete unit/property/golden/integration matrix for the supported Pi/provider versions.
3. Raw Pi message history is byte-for-byte unmodified by DCP; only new custom operation entries/tool receipts are appended.
4. State after restart/tree/fork/clone/reload equals replay over `getBranch()` and never leaks an abandoned branch.
5. All mutating model calls validate a current snapshot; aliases are absent from persisted canonical state.
6. Ambiguous identity mapping appends nothing and sends an untouched clone.
7. Every outgoing transformed context passes protocol validation; DCP never creates half a settled tool exchange and preserves host-supported incomplete/current forms untouched.
8. Range compression, nested consumption, decompression, and recompression are reversible while coverage remains available.
9. Old blocks outside post-compaction `buildContextEntries()` are orphaned and never resurrected, including overflow retry.
10. Manual and overflow native compaction are never cancelled; threshold cancellation meets fresh-estimate/safety/anti-loop policy.
11. `/dcp compress` produces a real model-visible user/follow-up turn and exactly one permitted model-authored tool call, not a forged call.
12. `allow|ask|deny` behavior is correct in TUI/RPC/JSON/print; deny removes `compress` from active tools and execution rejects defensively (the registered definition may remain in `getAllTools()`).
13. Untrusted project config is not read; malformed layers/state fail safely; Pi settings are never changed.
14. Effective defaults and protection unions match the tables, including the documented DCP default-list discrepancy.
15. Logs/caches/notifications meet privacy rules and secret-canary tests.
16. Performance goals pass on the reference fixture without quadratic behavior.
17. Disable/uninstall rollback exposes normal raw Pi context without a state repair step.
18. The license/provenance decision is recorded and approved before any production implementation is distributed.

## 27. Exact analysis-time source references

Paths below are exact local paths inspected for this design. Line numbers refer to the installed/checked-out artifacts at analysis time and may change on upgrade.

### 27.1 DCP 3.1.9

- Package/version/license/dependencies: `/home/vflores/.cache/opencode/packages/@tarquinen/opencode-dcp@latest/node_modules/@tarquinen/opencode-dcp/package.json:1-65`.
- User behavior/defaults/commands/prompts/protections/cache/license: `/home/vflores/.cache/opencode/packages/@tarquinen/opencode-dcp@latest/node_modules/@tarquinen/opencode-dcp/README.md:1-231`.
- Plugin hook and registration assembly: `.../dist/index.js:1-91`.
- Transform order and command routing: `.../dist/lib/hooks.js:1-244`, especially `56-91` and `93-174`.
- Message/block alias parsing/allocation: `.../dist/lib/message-ids.js:1-127`.
- Range tool schema/execution/journal flow: `.../dist/lib/compress/range.js:1-103`.
- Permission, session preparation, dedup/purge, persistence/notification: `.../dist/lib/compress/pipeline.js:1-46`.
- Nested/effective coverage and block activation: `.../dist/lib/compress/state.js:1-196`.
- Range placeholder contracts: `.../dist/lib/compress/range-utils.d.ts:1-10` and prompt text in `.../dist/lib/prompts/compress-range.d.ts:1`.
- Message mode contract: `.../dist/lib/compress/message-utils.d.ts:1-8`, `.../dist/lib/compress/message.d.ts:1-4`, and `.../dist/lib/prompts/compress-message.d.ts:1`.
- Protected users/tools/subagent result append: `.../dist/lib/compress/protected-content.js:1-104`.
- Outgoing compressed-range insertion and tool/question/error redaction: `.../dist/lib/messages/prune.js:1-164`.
- Dedup normalization/protections: `.../dist/lib/strategies/deduplication.js:1-108`.
- Old-error strategy: `.../dist/lib/strategies/purge-errors.js:1-71`.
- Decompression/reactivation: `.../dist/lib/commands/decompress.js:1-180`.
- Recompression/origin availability: `.../dist/lib/commands/recompress.js:1-155`.
- Sweep semantics/protections: `.../dist/lib/commands/sweep.js:1-216`.
- Context accounting method: `.../dist/lib/commands/context.js:1-242`.
- State shapes: `.../dist/lib/state/types.d.ts:1-102`.
- Full config type surface: `.../dist/lib/config.d.ts:1-69`.
- Prompt keys/system/manual/subagent/nudges: `.../dist/lib/prompts/store.d.ts:1-14`, `system.d.ts:1`, `extensions/system.d.ts:1-3`, `context-limit-nudge.d.ts:1`, `turn-nudge.d.ts:1`, `iteration-nudge.d.ts:1`.

The installed DCP compiled JavaScript inventory was validated with `find .../dist -type f -name '*.js'` and totals **6,981 lines** (`wc -l` across 64 files). The top-level `dist/index.js` alone is 91 lines; “compiled-only” refers to the published package lacking source `.ts`, not to it being a single bundle.

### 27.2 OpenCode

- Model request transform hook: `/home/vflores/repos/opencode/packages/opencode/src/session/prompt.ts:1255`.
- Compaction transform hook: `/home/vflores/repos/opencode/packages/opencode/src/session/compaction.ts:386`.
- Chat message and tool hook call sites: `/home/vflores/repos/opencode/packages/opencode/src/session/prompt.ts:308-390,1000,1255` and `/home/vflores/repos/opencode/packages/opencode/src/session/tools.ts:52-421`.
- Permission ask in processing: `/home/vflores/repos/opencode/packages/opencode/src/session/processor.ts:372`.
- Legacy/core plugin/session/permission comparison surfaces: `/home/vflores/repos/opencode/packages/core/src/plugin.ts`, `session.ts`, and `permission.ts`.

OpenCode is a moving checkout and is architecturally broader than the plugin version's minimum host. These references establish hook/lifecycle assumptions, not a claim that every checkout API exactly matches DCP 3.1.9's build-time SDK.

### 27.3 Pi

Installed root: `/home/vflores/.local/share/fnm/node-versions/v24.15.0/installation/lib/node_modules/@earendil-works/pi-coding-agent`.

- Extension lifecycle, context copies, session hooks, commands/tools, modes, custom entries: `docs/extensions.md:1-2989`.
- Package manifest, `pi-package`, production dependencies, Pi peers `*`: `docs/packages.md:1-184`.
- Session entry/message/tree/build semantics: `docs/session-format.md:1-425`.
- Native compaction triggers/cut points/hooks: `docs/compaction.md:1-330`.
- Tree/fork/clone behavior: `docs/sessions.md:1-139`.
- TUI constraints/components: `docs/tui.md:1-668`.
- RPC prompt/streaming/compaction/UI behavior: `docs/rpc.md:1-1135`.
- Exact extension event/tool types including sequential mode, dynamic active tools, `appendEntry(): void`, and compaction reasons: `dist/core/extensions/types.d.ts:193-524,866-1010,1120-1240`.
- Session entry IDs/read-only API/projection methods: `dist/core/session-manager.d.ts:1-300`.
- Agent prompt/command/send-user-message behavior: `dist/core/agent-session.js:790-1110`.
- Native compaction reason/retry/threshold implementation: `dist/core/agent-session.js:1363-1725`.
- Host context estimation and threshold predicate: `dist/core/compaction/compaction.js:76-163`.

### 27.4 License/provenance decision

DCP declares **AGPL-3.0-or-later**. Direct copying, close translation, or derivative use likely brings AGPL obligations; a compatible route should preserve license, notices, source availability, and credit. A clean-room behavioral route should keep this design/specification and implementation provenance separated and avoid copying prompts/code beyond facts and interfaces legally cleared for use. Either route should credit the behavioral inspiration. This document is not legal advice and offers no legal certainty; counsel/project owners must decide before production code is written or distributed.
