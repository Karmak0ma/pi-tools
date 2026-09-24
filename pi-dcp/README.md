# pi-dcp

`pi-dcp` is a private Pi extension that provides non-destructive, outgoing-context compression and conservative tool-output pruning. Pi session entries are never edited or deleted; only the context sent to a provider is transformed.

## Installation

Load this source package from Pi with `./src/index.ts` (or install it as a local Pi package).

**Immediately after installation, disable Pi automatic compaction:**

```json
{
  "compaction": {
    "enabled": false
  }
}
```

pi-dcp is an outgoing-context lens and does not change Pi's persisted token accounting or settings. If automatic Pi compaction remains enabled, Pi can replace history independently of DCP. Manual `/compact`, overflow recovery, old sessions, and imported sessions may still contain native compactions; pi-dcp supports rebasing around them and never cancels native compaction.

## Compatibility

The current lockfile and deterministic test suite certify Pi `0.87.0`. This is an internal extension: the supported host is exactly Pi `0.87.0`, and the peer dependencies require that exact version. When Pi updates, update the four pinned Pi packages and peer dependencies together, then rerun `npm ci` plus `npm run check`; no previous-version compatibility matrix is maintained. Hosts without Pi 0.87's required projection API fail closed at startup and are unsupported. On Pi 0.87.0, stable compression guidance is installed in the owned structured system section `pi_dcp_context_compression`; transient nudge text remains request-local context and is not persisted as prompt state. DCP validates Pi's provenance-preserving `buildSessionProjection()`, applies host `context_edit` results without making edits part of DCP's range model, and joins the system-free `context` event against a provider-visible view while retaining system messages as non-compressible canonical barriers. If a host event lacks structured prompt sections, pi-dcp records one metadata-only `capability_missing` diagnostic, disables its compression path, and can recover when a later normalized event provides the sections. The OpenCode DCP reference package has no published authoring TypeScript sources; generated `.d.ts` declarations are present. OpenAI conversion paths and the four vendored `opencode-cli` model fixtures (`opencode/deepseek-v4-flash-free`, `opencode/mimo-v2.5-free`, `opencode/nemotron-3-super-free`, and `opencode/big-pickle`) are deterministic compatibility gates. Optional live checks are never part of `npm run check`.

## Commands

Use `/dcp` (or `/dcp menu`) to open the interactive settings menu. If the extension was already running when it was updated, run `/reload` once before testing the command. In print/JSON mode there is no interactive menu; edit the settings file directly or use `/dcp status`. The menu edits and saves `~/.pi/agent/dcp_settings.json` (or the directory selected by `PI_CODING_AGENT_DIR`). Use `/dcp status` for status and help, `/dcp context` for compact context and nudge status, `/dcp debug` for nudge troubleshooting details, `/dcp stats`, `/dcp sweep [N]`, `/dcp manual [on|off]`, `/dcp compress [focus]`, `/dcp decompress [N|bNNNN]`, `/dcp recompress [N|bNNNN]`, or `/dcp reload`.

`/dcp stats` opens a two-tab savings table in TUI mode. The **Session** tab shows cumulative estimated savings for the current branch/session; the **Total** tab aggregates the append-only `~/.pi/agent/dcp_stats.jsonl` ledger across sessions (or the directory selected by `PI_CODING_AGENT_DIR`). Press Tab or Shift+Tab to switch tabs and Escape to close. Sources are reported separately for range compression, duplicate-output pruning, sweep-output pruning, old-error-input pruning, and question-input pruning. These are operation-level estimates: a saved block or pruned item is counted once, not once per provider request. Decompression does not erase historical savings.

Defaults follow the proven OpenCode DCP baseline where it maps cleanly: enabled compression, `allow` permission, detailed chat notifications, automatic deduplication and error-input purging, soft nudges beginning at 35% context, an imperative nudge at 70% context, a critical recovery nudge at 90% context, a five-turn context reminder interval, semantic turn nudges every five user turns, semantic iteration nudges after fifteen assistant/tool iterations, and a 12,000-token estimated-savings floor for semantic nudges. Pi 0.84.1 provides the built-in tools `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls`. The default protected tool set is Pi-native: `compress`, `write`, `edit`, and the configured `@juicesharp/rpiv-todo` extension's `todo` tool. The `todo` tool is protected both from ordinary pruning and from compression ranges. Read-only tools and `bash` remain eligible for pruning/compression by default; add any tool to the protected list when its output must remain intact. Recent-turn protection and complete-user-message protection remain opt-in.

The menu exposes minimum, maximum, and critical context percentages, context reminder cadence, semantic turn and iteration thresholds, the minimum estimated savings floor, extension enablement, compression permission, automatic pruning, recent-turn and complete-user-message protection, notification settings, and protected tools/path patterns. Nudge severity is automatic: below the minimum threshold no context-pressure nudges are sent; from 35% to below 70%, pi-dcp sends soft reminders at the configured interval; at or above 70%, it sends an imperative nudge every turn; and at or above 90%, it sends a critical recovery nudge that instructs the model to compress immediately, finishing only the current atomic operation first. Turn and iteration reminders are also soft, but only run when enough eligible closed context exists to meet the 12,000-token estimated-savings floor. pi-dcp estimates removable source tokens from complete eligible units, subtracts configured protected tool output, and reserves 25% for the model-authored summary before applying the floor. Context-pressure nudges take priority over semantic reminders, but soft and imperative context nudges are only scheduled when the settled context still offers compressible content (nonzero estimated savings): a nudge whose own request tags show every unit BLOCKED or user-protected would contradict itself. The critical band is exempt and always fires, because at 90% recovery pressure matters more than eligibility bookkeeping (the only exception is the turn in which a nudge was delivered or a compression just happened, which already served as the pressure response; critical resumes from the next settle).

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

The detailed TUI receipt shows the compression number, a before/after context strip, tokens reclaimed and the percentage of the context window reclaimed, tools/messages covered by the call, the topic, and cumulative session savings. Its colors come from Pi's supplied `Theme` on every render, so changing the active theme updates existing receipts. Print/RPC output uses the same layout without ANSI color escapes. Chat notifications are not compression nudges and do not request model action.

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
  "pruneNotificationType": "both"
}
```

Compression summaries are authored by the model through the v2 `compress` tool. The schema contains no model-supplied snapshot ID. Deterministic `m0001` and `b0001` aliases are attached locally to protocol units and active summaries; they are resolved against the producing assistant response's retained internal baseline. A missing or changed baseline fails closed and writes no operation. Version-1 operation entries remain in raw history but are ignored by v2 so raw context can be restored safely.

## Configuration

Configuration is read from trusted global and project `dcp.jsonc`/`dcp.json` layers, followed by the personal `~/.pi/agent/dcp_settings.json` file. The personal settings file is the menu's editable source and takes precedence for overlapping keys; untrusted project files are not opened. The complete supported schema is implemented in `src/config`; unknown and excluded settings are rejected or warned. Arrays extend protection baselines. See `IMPLEMENTATION_PLAN.md` for the frozen behavior contract.

## Privacy and rollback

Logs, notifications, and statistics contain metadata and reason codes only; they never include summaries, paths, arguments, results, images, or credentials. The cross-session statistics ledger stores only operation IDs, session IDs, timestamps, source categories, event counts, and estimated token totals. Removing or disabling pi-dcp immediately restores ordinary Pi context. Existing journal entries are inert without the extension and are not repaired.

## License

AGPL-3.0-or-later. Distribution must include corresponding source, this license notice, and attribution for the Pi/OpenCode compatibility fixtures where applicable.
