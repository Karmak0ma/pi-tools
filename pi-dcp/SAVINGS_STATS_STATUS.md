# pi-dcp Savings Statistics — Status

## Current request

Add token-savings statistics to `pi-dcp` with:

- cumulative statistics for the current session/branch;
- cumulative totals across all sessions;
- `/dcp stats` displayed as a table;
- separate `Session` and `Total` tabs switchable with the Tab key;
- separate rows for every DCP savings source.

The user explicitly requested that the broken `compress` tool not be used for context management. Continue this work normally and use this file as the handoff summary.

## Savings sources identified

DCP performs five distinct token-reducing operation types:

1. **Range compression** — replacing a contiguous historical range with a model-authored summary.
2. **Duplicate outputs** — deduplicating older repeated successful tool results.
3. **Swept outputs** — pruning eligible completed tool results through `/dcp sweep`.
4. **Old error inputs** — redacting arguments from sufficiently old failed tool calls.
5. **Question inputs** — redacting old `question` / `ask_user_question` inputs after their result exists.

Savings are intentionally counted at the persisted operation level, not for every outgoing provider request. Counting every transformed request would repeatedly count the same active compressed block or redaction.

## Implementation already present

### `src/stats.ts`

Added a statistics module containing:

- `SAVINGS_SOURCES` and `SavingsSource`.
- `SavingsBucket { events, tokens }`.
- `SavingsTotals`.
- `SavingsRecord` schema 1.
- `emptySavingsTotals`, `cloneSavingsTotals`, `addSavingsTotals`.
- `savingsFromOperation`, which maps compression and pruning operations into source buckets.
- `savingsRecordFromEnvelope`.
- `statsPath`, using:
  - `$PI_CODING_AGENT_DIR/dcp_stats.jsonl`, or
  - `~/.pi/agent/dcp_stats.jsonl`.
- `appendSavingsRecord`, using an append-only JSONL ledger and private file permissions.
- `readSavingsLedger`, which ignores malformed lines and deduplicates operation IDs while aggregating totals.
- `persistSavingsBestEffort`, which prevents statistics failures from failing DCP operations.
- `persistMissingSavingsBestEffort`, used for startup repair/backfill.

The ledger stores only operation/session metadata and source totals. It does not store summaries, paths, arguments, tool results, images, or credentials.

### Operation and reducer accounting

#### `src/state/operations.ts`

`CreatedBlock` now has backward-compatible optional fields:

- `estimatedSourceTokens` — estimated tokens represented before replacement.
- `estimatedSavingsTokens` — estimated source representation minus summary representation.

Validation accepts old blocks without these fields and validates new values as finite, non-negative numbers.

#### `src/state/reducer.ts`

`ReducedState` now contains `savings: SavingsTotals`.

- `emptyState()` initializes it.
- `cloneState()` copies it safely and supports older state objects without the field.
- Applying `compression.created` or `tools.pruned` adds source-specific totals exactly once.
- Manual-mode and block-activation operations do not add savings.

The current-session display therefore follows DCP’s existing branch-local state model: operations on the active branch and its ancestors are included; abandoned branches are not.

### Compression accounting

#### `src/compression/service.ts`

Compression now estimates the representation replaced by a new summary:

- direct selected messages are estimated from the canonical index;
- raw entries covered by consumed nested blocks are excluded;
- consumed child summary estimates are added once to avoid nested double-counting;
- `estimatedSavingsTokens = max(0, estimatedSourceTokens - estimatedSummaryTokens)`.

Normal runtime compression passes `runtime.index`, so these values are populated during real operations. Tests that do not pass an index produce zero source/savings estimates by design.

### Ledger persistence

Savings records are persisted after the corresponding session operation is appended:

- `src/compression/tool.ts` — model-authored compression.
- `src/commands/sweep.ts` — manual sweep pruning.
- `src/lifecycle.ts` — automatic settled-strategy pruning.

`src/lifecycle.ts` also backfills missing savings records from the current branch during `session_start`.

### `/dcp stats` UI

#### `src/commands/stats.ts`

The command now:

- reads current-session totals from `runtime.reduced.savings`;
- reads all-session totals from the global ledger;
- opens a TUI custom overlay in TUI mode;
- provides `Session` and `Total` tabs;
- switches tabs with Tab / Shift+Tab;
- closes with Escape;
- renders rows for:
  - Range compression
  - Duplicate outputs
  - Swept outputs
  - Old error inputs
  - Question inputs
  - Total
- displays event counts and estimated tokens saved;
- falls back to a text notification in non-TUI/RPC/print contexts.

Exported pure helpers:

- `formatStatsTable`.
- `formatStatsReport`.

### Package and documentation

- `package.json` and `package-lock.json` now include `@earendil-works/pi-tui` as a peer/dev dependency.
- `README.md` documents the tabs, ledger path, sources, cumulative estimate semantics, and privacy behavior.

## Tests currently present

Added `test/unit/stats.test.ts` covering:

- all four pruning-source classifications;
- reducer accumulation of pruning totals;
- compression source/savings estimation using an older range and a newer latest-user message;
- ledger aggregation across two sessions;
- logical deduplication of repeated operation IDs;
- rendering all source rows and the total row.

Latest observed test results:

- `npm run typecheck` passed after the lifecycle/import fixes.
- `npm run test:unit` passed: 5 files, 16 tests.
- A previous `npm run check` passed all suites before the final compression fixture was added; the full check still needs to be rerun after the latest changes.

## Important unrelated existing changes

`pi-dcp/src/compression/tool.ts` already contained unrelated hardening changes from another workstream. Preserve them:

- `isSnapshotFresh` instead of the older snapshot check;
- `ContextSnapshot` import;
- current-history validation through `validateCurrentHistory`;
- richer stale-snapshot failure stages;
- the current `failure(reason, extra)` helper.

Our feature only added savings persistence and changed the compression notification to report estimated savings instead of summary size. Do not revert the snapshot-integrity changes.

The repository also contains unrelated existing modifications under:

- `subagents-vflo/`;
- `tool-expansion/`.

Do not touch or revert those files.

## Review findings and decisions still needed

### 1. Fork/session identity behavior

Existing `src/state/reconstruct.ts` rejects an operation whose envelope `sessionId` differs from the current session ID. Forked/copied sessions may inherit operation entries from the source session, so this can mark the new session corrupt and disable DCP.

This is broader than the statistics feature, but it matters to the meaning of “per session.” Decide whether to fix it now or explicitly leave it out of scope. If fixing, add fork/branch tests and distinguish inherited operation provenance from the current session identity.

### 2. Zero-token event counts

The current implementation counts an event even when its estimated token saving is zero. This yields rows such as `1 event, 0 tokens saved`.

Choose one:

- keep this behavior and relabel the column/field as operation/event count;
- count only positive-token savings as events.

The safer minimal change is likely to retain operation counts and clarify the label/documentation.

### 3. Global ledger concurrency

Startup repair uses read → check operation ID → append. Two Pi processes can race and physically append the same operation. Reader-side operation-ID deduplication prevents inflated totals, so this is not currently an accounting error, but the JSONL file can accumulate duplicates.

Possible follow-up options:

- accept logical exactly-once behavior and document it;
- add a cross-process lock;
- add a ledger compaction/repair command.

Avoid overengineering unless needed for this feature.

### 4. Session vs branch wording

The requested tab is named `Session`, but DCP state is deliberately branch-local. The implementation currently shows the active branch’s cumulative values and the README says “current branch/session.” Consider adding an explicit footnote such as “Session tab reflects the active branch” while keeping the requested `Session` tab name.

### 5. Tab navigation implementation

With exactly two tabs, Tab and Shift+Tab currently produce the same visual toggle. This is mathematically correct for two tabs, but the handler could be written as a signed delta to remain correct if another tab is added later.

### 6. Compatibility range

The package advertises Pi packages as `>=0.84.1`, while the tested environment is Pi 0.84.1. This is pre-existing and not specific to savings statistics. Do not broaden this feature into a compatibility overhaul without a concrete failure.

## Recommended next steps

1. Inspect the current versions of:
   - `src/compression/tool.ts`;
   - `src/lifecycle.ts`;
   - `src/commands/stats.ts`;
   - `src/stats.ts`.
2. Run:

   ```bash
   cd /home/vflores/repos/pi-tools/pi-dcp
   npm run check
   ```

3. If the full check passes, run a focused live Pi command/session check to verify:
   - `/dcp stats` loads without extension errors;
   - non-TUI fallback renders both scopes;
   - a newly created pruning/compression operation updates the Session tab;
   - a second session operation appears in Total.
4. Make only narrow cleanup changes if needed:
   - clarify “active branch” wording;
   - simplify signed Tab navigation;
   - optionally rename Events to Operations if zero-value rows are retained.
5. Re-run `npm run check` after any cleanup.
6. Report changed paths and exact verification results.
