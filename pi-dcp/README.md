# pi-dcp

`pi-dcp` is a private Pi extension that provides non-destructive, outgoing-context compression and conservative tool-output pruning. Pi session entries are never edited or deleted; only the context sent to a provider is transformed.

## Installation

Load this source package from Pi with `./src/index.ts` (or install it as a local Pi package).

**Enable Pi automatic compaction once in Pi's settings (`~/.pi/agent/settings.json`, or through `/settings`):**

```json
{
  "compaction": {
    "enabled": true
  }
}
```

This replaces the older instruction to disable Pi automatic compaction. Keep `compaction.enabled: true` in the effective Pi settings; a project setting can override the global setting. pi-dcp does not write Pi settings or toggle them when you switch models.

After changing Pi settings or updating the extension, run `/reload`. `/dcp reload` reloads DCP configuration only; it does not reload Pi settings.

### Which compaction runs?

| Current DCP state | Native threshold compaction | Manual `/compact` | Overflow recovery |
| --- | --- | --- | --- |
| Enabled and healthy for the selected model | Blocked by DCP | Allowed | Allowed |
| Model excluded, globally disabled, or unhealthy | Allowed | Allowed | Allowed |

This table requires Pi's effective `compaction.enabled: true`. DCP does not turn that setting on for you.

pi-dcp is an outgoing-context lens and does not change Pi's persisted token accounting. It cancels native **threshold** compaction only while DCP is healthy, not blocked by a session transition, and enabled for the current model. When DCP is globally disabled, excluded by `disabledModels`, unhealthy, or unable to identify the model, Pi's normal threshold compaction is allowed. Manual `/compact` and **overflow recovery** are always allowed. No extra DCP setting is needed.

Overflow recovery lets Pi summarize older history and retry a request that exceeds the model's context limit. Pi's `compaction.enabled: false` also disables this automatic recovery, so leaving the old setting in place prevents the fallback. DCP rebases after native compaction; switching back to an enabled model cannot restore a prefix that Pi has already replaced with a native summary.

Pi may display “Auto-compaction cancelled” when DCP blocks a threshold attempt. Later threshold checks can show this notice again because DCP does not rewrite Pi's token accounting. Cancellation skips the native summary request; it does not trigger an immediate retry loop. If DCP cannot keep the outgoing request within the model's limit, overflow recovery remains the fallback.

## Compatibility

Pi package dependencies use `"*"` so host updates are not blocked by an extension version range. The lockfile records the development versions used for repeatable tests, not a required host version. After updating Pi, update the four Pi development packages together with `npm update @earendil-works/pi-coding-agent @earendil-works/pi-agent-core @earendil-works/pi-ai @earendil-works/pi-tui`, then rerun `npm run check`. No previous-version compatibility matrix is maintained; compatibility depends on the required host APIs, not a version pin. Hosts without Pi 0.87's required projection API fail closed at startup and are unsupported. On Pi 0.87.1, stable compression guidance is installed in the owned structured system section `pi_dcp_context_compression`; transient nudge text remains request-local context and is not persisted as prompt state. DCP validates Pi's provenance-preserving `buildSessionProjection()`, applies host `context_edit` results without making edits part of DCP's range model, and joins the system-free `context` event against a provider-visible view while retaining system messages as non-compressible canonical barriers. If a host event lacks structured prompt sections, pi-dcp records one metadata-only `capability_missing` diagnostic, disables its compression path, and can recover when a later normalized event provides the sections. The OpenCode DCP reference package has no published authoring TypeScript sources; generated `.d.ts` declarations are present. OpenAI conversion paths and the four vendored `opencode-cli` model fixtures (`opencode/deepseek-v4-flash-free`, `opencode/mimo-v2.5-free`, `opencode/nemotron-3-super-free`, and `opencode/big-pickle`) are deterministic compatibility gates. Optional live checks are never part of `npm run check`.

## Commands

Use `/dcp` (or `/dcp menu`) to open the interactive settings menu. If the extension was already running when it was updated, run `/reload` once before testing the command. In print/JSON mode there is no interactive menu; edit the settings file directly or use `/dcp status`. The menu edits and saves `~/.pi/agent/dcp_settings.json` (or the directory selected by `PI_CODING_AGENT_DIR`). Changes are kept as a draft until you pick "Save and close" or press Ctrl+S on the main menu. Use `/dcp status` for status and help, `/dcp context` for compact context and nudge status, `/dcp debug` for nudge troubleshooting details, `/dcp stats`, `/dcp sweep [N]`, `/dcp manual [on|off]`, `/dcp compress [focus]`, `/dcp decompress [N|bNNNN]`, `/dcp recompress [N|bNNNN]`, or `/dcp reload`.

`/dcp stats` opens a two-tab savings table in TUI mode. The **Session** tab shows cumulative estimated savings for the current branch/session; the **Total** tab aggregates the append-only `~/.pi/agent/dcp_stats.jsonl` ledger across sessions (or the directory selected by `PI_CODING_AGENT_DIR`). Press Tab or Shift+Tab to switch tabs and Escape to close. Sources are reported separately for range compression, duplicate-output pruning, sweep-output pruning, old-error-input pruning, and question-input pruning. These are operation-level estimates: a saved block or pruned item is counted once, not once per provider request. Decompression does not erase historical savings.

Defaults follow the proven OpenCode DCP baseline where it maps cleanly: enabled compression, `allow` permission, detailed chat notifications, automatic deduplication and error-input purging, soft nudges beginning at 35% context, an imperative nudge at 70% context, a critical recovery nudge at 90% context, a five-turn context reminder interval, semantic turn nudges every five user turns, semantic iteration nudges after fifteen assistant/tool iterations, and a 32,000-token estimated-savings floor for semantic nudges. Pi 0.84.1 provides the built-in tools `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls`. The default protected tool set is Pi-native: `compress`, `write`, `edit`, and the configured `@juicesharp/rpiv-todo` extension's `todo` tool. The `todo` tool is protected both from ordinary pruning and from compression ranges. Read-only tools and `bash` remain eligible for pruning/compression by default; add any tool to the protected list when its output must remain intact. Recent-turn protection and complete-user-message protection remain opt-in.

The menu exposes minimum, maximum, and critical context percentages, context reminder cadence, semantic turn and iteration thresholds, the minimum estimated savings floor, extension enablement, compression permission, automatic pruning, recent-turn and complete-user-message protection, notification settings, and protected tools/path patterns. Nudge severity is automatic: below the minimum threshold no context-pressure nudges are sent; from 35% to below 70%, pi-dcp sends soft reminders at the configured interval; at or above 70%, it sends an imperative nudge every turn; and at or above 90%, it sends a critical recovery nudge that instructs the model to compress immediately, finishing only the current atomic operation first. Turn and iteration reminders are also soft, but only run when enough eligible closed context exists to meet the 32,000-token estimated-savings floor. pi-dcp estimates removable source tokens from complete eligible units, subtracts configured protected tool output, and reserves 25% for the model-authored summary before applying the floor. Context-pressure nudges take priority over semantic reminders, but soft and imperative context nudges are only scheduled when the settled context still offers compressible content (nonzero estimated savings): a nudge whose own request tags show every unit BLOCKED or user-protected would contradict itself. The critical band is exempt and always fires, because at 90% recovery pressure matters more than eligibility bookkeeping (the only exception is the turn in which a nudge was delivered or a compression just happened, which already served as the pressure response; critical resumes from the next settle).

### Nudge severity and provider-facing roles

Threshold decisions are persisted as `nudge.requested` v2 operations. On the next successful context transformation, pi-dcp appends one stable, hidden `pi-dcp.v2.nudge` custom message to that provider request only. The nudge is transient and is not persisted as an ordinary conversation message; the `nudge.requested` operation remains the audit record. A pending nudge is dropped when the snapshot is invalidated (model switch, compaction, or branch change) and is re-derived from the next settle, so a request never ships a nudge tagged with a stale generation. A successful compression arms the same reminder interval a delivered nudge does, so the model is not asked to compress again immediately after it just did. Nudge text uses only the `soft`, `imperative`, or `critical` band; exact token counts, timestamps, IDs, and expirations stay in diagnostics. Keeping the model-visible nudge at the request tail prevents a threshold crossing from rewriting earlier provider history. Nudge, tool, and system guidance also instruct the model never to compress to prepare the final answer: when the task is complete and only the final user-facing summary remains, it delivers that summary first, because compression only pays off when more work will follow in the session.

### Nudge troubleshooting

`/dcp context` reports the last nudge evaluation and the turn on which a nudge was last inserted. `/dcp debug` adds the non-sensitive inputs used for that decision: reported token usage, context window, resolved minimum/maximum/critical token thresholds, turns since the last nudge, whether the current turn was already nudged, the selected severity, and the last transform result. Reasons include `usage_unavailable`, `below_minimum`, `interval_not_elapsed`, `nothing_compressible`, `potential_savings_below_minimum`, `semantic_interval_not_elapsed`, `already_nudged_this_turn`, and `ready`. No nudge text, summaries, tool arguments, paths, or provider credentials are logged.

`/dcp debug` also counts raw requests for the current session: how many requests were sent uncompressed, grouped by reason, plus the last join result. `missing session messages` above zero means session messages did not reach pi-dcp unchanged, usually because another extension's `context` handler changed them; pi-dcp then fails closed and sends that request raw. `/dcp context` shows the short raw-request count.

Nudges are scheduled after an agent settles and delivered through the next successful context transformation. A debug command run before any context transformation reports that no context transform has been recorded; run it after an agent request when diagnosing a missing nudge.

### Notification channels

Notification level controls how much detail is shown (`off`, `minimal`, `summary`, or `detailed`). The notification channel is independent and can be `chat`, `toast`, or `both`:

- `chat` keeps the feedback visible in the transcript without triggering an agent turn. Detailed compression feedback is rendered as a four-line context-reclamation receipt in the compression tool result.
- `toast` uses Pi's transient UI notification.
- `both` does both.

The compress tool draws its own card in the TUI. Collapsed, it shows the range, the topic, and one bar line. Expanded (Ctrl+O), it shows each summary rendered as Markdown, the recall cues, and the full receipt: compression number, bar, and a table with tokens, tools, and messages for this call and the session total. The bar style is set with `receiptStyle`, or in `/dcp settings`, where the style list shows a live preview of the highlighted style next to it (under it on terminals narrower than 124 columns). It only applies to `detailed` notifications:

- `simple`: the share of the context window this call reclaimed.
- `before-after`: context usage before and after the call, each colored by level like the sidebar (above 60% red, above 40% yellow, else accent).
- `regained` (default): one bar with what is still used plus what this call gave back.
- `full`: the context in order (system prompt and tools in grey, raw history, each pi-dcp summary in purple), this call's savings in green, and a per-compression history.

`before-after`, `regained`, and `full` need Pi's context usage. When Pi has no measurement (for example right after a native compaction), the receipt falls back to `simple`. All sizes except Pi's usage are character-based estimates. Colors come from Pi's supplied `Theme` on every render, so changing the theme or the style updates existing receipts. Print/RPC output and the model-visible tool result stay plain text without ANSI escapes. Chat notifications are not compression nudges and do not request model action.

The editable file uses the same shape as the menu. For example:

```json
{
  "enabled": true,
  "nudge": {
    "minContextPercent": 35,
    "maxContextPercent": 70,
    "criticalContextPercent": 90,
    "turnsBetweenNudges": 5,
    "turnNudgeFrequency": 5,
    "iterationNudgeThreshold": 15,
    "minPotentialSavingsTokens": 32000
  },
  "compress": { "permission": "allow", "protectUserMessages": false },
  "manualMode": { "automaticStrategies": true },
  "turnProtection": { "enabled": true, "turns": 4 },
  "pruneNotification": "summary",
  "pruneNotificationType": "both",
  "receiptStyle": "full"
}
```

Compression summaries are authored by the model through the v2 `compress` tool. The schema contains no model-supplied snapshot ID. Deterministic `m0001` and `b0001` aliases are attached locally to protocol units and active summaries; they are resolved against the producing assistant response's retained internal baseline. A missing or changed baseline fails closed and writes no operation. Version-1 operation entries remain in raw history but are ignored by v2 so raw context can be restored safely.

**Merging blocks.** A compress range may include existing `bNNNN` blocks. Those blocks are replaced by one new block. The model writes one fresh, higher-level summary for the whole range and does not paste the child summaries in, so a merged block stays small as older work is compressed again. Protected tool output from the merged blocks is carried over verbatim. The replaced blocks stay in the session record as inactive blocks and are not deleted. No placeholders are needed. Each merge adds one nesting level above its deepest child. The limit is 64 levels. It is a fixed bound of the stored format, not a setting. A merge that would exceed the limit is refused before anything is saved.

**Walls and merge quality.** A range never crosses a BLOCKED unit, even to merge blocks. Blocks lie between the walls, never inside them, so blocks on opposite sides of a wall cannot merge into one range. System messages and `!` shell commands are permanent walls. A range that is exactly one block with no raw unit is refused (`single_block_rewrite`): a merge needs two or more blocks, or a block plus raw units, and the error says to merge the block or leave it. The guidance asks the model to keep, for each phase, the goal, outcome, decisions with their main reasons, open issues, and key artifacts. These rules are static text, so the cached system prompt does not change.

**Per-range topics.** Each range may carry its own `topic` (1 to 120 characters). A range topic overrides the call topic, and a blank one counts as absent. A block with neither takes `Compressed context`. The receipt names the stored topics, capped at 120 characters.

**Stored-block list.** A successful call returns one line per stored block: its label as the next request shows it, its topic, and its summary length in characters. The tool result is never redacted, so a past call shown without its summaries was complete. A split of a rejected range never offers a run that is one block alone.

**Recall cues.** A range may also list up to six `recall` strings: details that its summary leaves out but that remain in the original history. Each is one short line with concrete, searchable terms, for example `SQLite rejection reasons: concurrent writers`. A block with cues lists them after its summary, under "Details omitted here but searchable with search_compressed", so the model knows the details exist. Cues are searchable with their block. A merged block does not inherit its children's cues; the model writes new ones, and the children's summaries and cues stay searchable. Blocks without cues are rendered exactly as before.

## When pruning takes effect

Automatic pruning (duplicate outputs, old error inputs, and question inputs) is recorded when the agent settles, but it does not change the next request. It takes effect with the next successful compression. Anthropic binds each signed thinking block to the exact bytes before it. Changing an earlier message therefore drops the thinking of every later assistant turn, and the provider prompt cache misses from that point. A compression already rewrites history from its range start, so pruning that joins the same request adds no extra cache break. A pruned output that lies before the compressed range moves the change point back to that output. Automatic pruning never touches the current turn.

`/dcp sweep [N]` applies at once, because you asked for it. It can drop the thinking of the current turn and miss the prompt cache. Statistics count each pruning decision when it is recorded, so a decision that never reaches a compression is still counted. A session recorded before this change follows the same rule: pruning recorded after its last compression is held back on resume, so those outputs are sent raw again until the next compression (one cache miss).

## Searching compressed context

A summary is not a complete record. The model-facing `search_compressed` tool searches the original messages behind compressed blocks, and the stored summaries of blocks that a later block merged. It can then read a match back in full. The result is a new tool result. It is read-only: it writes no operation entry, changes no block activation, and does not bump the context generation.

- **Scope.** Only the current branch is searched. Entries covered by any block are searchable, including entries whose block is inactive or unavailable after native compaction. Summaries of active blocks are not searched, because they are already in context.
- **Withheld content.** Thinking, system messages, and pi-dcp's own messages are never returned. Images appear only as a placeholder, and a `compress` call is indexed by its topic only, because its summaries are stored in the block. Entries that a host `context_edit` changed or removed are withheld, and so is any summary whose block covers such an entry, so the search cannot bypass that redaction.
- **Matching.** Matching is deterministic keyword search with no embeddings or model calls. Results are ranked by BM25, so a rare word counts more than a common one. Exact identifiers such as paths, symbols, numbers, and error text match exactly. A path also finds the `path:line:col` locations that error output prints. Plain words (letters only, five or more) also match their word forms (`migrate` finds `migration`) and typos of one letter edit (`conection` finds `connection`; a swapped pair of letters counts as two edits). Those approximate hits rank below exact ones and are marked `matched approximately`. Identifiers and short words never match approximately. Different words for the same idea are not matched, so retry with other terms. A `"quoted phrase"` must appear exactly, and the other words then rank the sources that contain it. A search with no match does not prove that the detail is absent.
- **Identical copies.** Sources whose text is identical after trimming count as one result. The shown hit is the highest-ranked copy (on a tie, the most recent). It names the other copies with `(+N identical copies: <refs>)`, listing up to five refs, most recent first. Counts and paging count distinct texts, so repeated tool output does not fill a page.
- **Size.** A result is capped at about 12,000 characters and pages with `next offset`. A read returns 8,000 characters per page.
- **Guidance.** The system prompt tells the model when to search: before it revisits or changes a recorded decision, when it needs an exact command, error, number, or wording that a summary omits, and when a summary conflicts with current evidence. It also says not to search every turn.
- **Availability.** The tool is active exactly when `compress` is active: DCP is enabled and healthy, and the model is not excluded. Like `compress`, it is removed when `compress.permission` is `deny`.

## Compressible and blocked units

Every message in the provider request carries a label: `mNNNN` for a unit the model may compress, `bNNNN` for an active summary block, or `BLOCKED` for a unit that can never be part of a compress range. A unit is `BLOCKED` for one of two reasons:

- **Unfinished tool exchange**: an assistant tool call that does not yet have all its results directly after it.
- **Protected message**: a `system` message (pi records one when the system prompt, rules, or tool list change mid-session; summarizing it could make the model call a tool that no longer exists), a `bashExecution` message (a command the user ran with `!`; it has no content array to carry a label), or a `custom` message whose `customType` is in the blocklist. The blocklist currently contains only `pi-dcp.v2.summary`, pi-dcp's own rendered block.

All other extension `custom` messages (sent with `pi.sendMessage`, for example `subagent-background-result`) are ordinary, compressible history. A blocklist is used instead of an allowlist because extension messages are normal transcript content; content that must persist verbatim belongs in the system prompt.

When a compress call is rejected with `content_protected`, the error lists every blocked unit in the request with its reason, and gives the exact replacement ranges that split each rejected range around its blockers (for example `range 0 (m0001-m0005) -> m0001, m0003, m0005`). When a rejected range starts or ends on a block, the error also says that the BLOCKED units lie between the selected blocks, not inside them. The model is instructed to retry immediately with those ranges. Nothing is compressed by a rejected call.

## Configuration

Configuration is read from trusted global and project `dcp.jsonc`/`dcp.json` layers, followed by the personal `~/.pi/agent/dcp_settings.json` file. The personal settings file is the menu's editable source and takes precedence for overlapping keys; untrusted project files are not opened. The complete supported schema is implemented in `src/config`; unknown and excluded settings are rejected or warned. Arrays extend protection baselines. See `IMPLEMENTATION_PLAN.md` for the frozen behavior contract.

### Disable DCP for specific models

Add `disabledModels` to `~/.pi/agent/dcp.jsonc` (or `dcp.json`):

```json
{
  "disabledModels": [
    "anthropic/claude-sonnet-4-5",
    "openai-codex/gpt-5.4"
  ]
}
```

Use the exact, case-sensitive `provider/model-id` from Pi's model selector, not the display name. These are examples; use your installed model IDs. Model IDs may contain `/`. No wildcard or prefix matching is used, so the same model ID from another provider is not affected. The default is `[]`, which excludes no models. Global `enabled: false` still disables DCP for every model.

The same key works in trusted project `.pi/dcp.jsonc` / `.pi/dcp.json` files and in the personal `dcp_settings.json` file. Higher-priority lists **replace** lower-priority lists; `[]` clears an inherited list. This option is file-only, not a menu control. Saving or resetting the menu does not change the file's model exclusion list. Run `/reload` (or `/dcp reload`) after editing a file. Once loaded, the policy applies immediately when you switch models; no reload is needed for a model switch.

For an excluded model, DCP sends the incoming context unchanged: no saved summaries, pruning, labels, system guidance, or nudges are applied. The `compress` tool is removed from the active tool set, direct calls are rejected, and manual mutation commands are blocked. Settings, status, diagnostics, statistics, and reload remain available. Existing summaries and pruning operations remain saved and can apply again after switching to an enabled model. With Pi automatic compaction enabled as described above, excluded models use Pi's normal threshold compaction and overflow recovery. Restoring full active history can increase context size. A native compaction changes that active history for all later models; switching back does not undo it.

## Privacy and rollback

Logs, notifications, and statistics contain metadata and reason codes only; they never include summaries, paths, arguments, results, images, or credentials. The cross-session statistics ledger stores only operation IDs, session IDs, timestamps, source categories, event counts, and estimated token totals. Removing or disabling pi-dcp immediately restores ordinary Pi context. Existing journal entries are inert without the extension and are not repaired.

## License

AGPL-3.0-or-later. Distribution must include corresponding source, this license notice, and attribution for the Pi/OpenCode compatibility fixtures where applicable.
