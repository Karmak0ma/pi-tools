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

The certified runtime is Pi `0.84.1`. The package requires Pi `>=0.84.1`; later versions are accepted only when their versioned projection adapter and fixtures are supported. The OpenCode DCP reference package has no published authoring TypeScript sources; generated `.d.ts` declarations are present. OpenAI conversion paths and the four vendored `opencode-cli` model fixtures (`opencode/deepseek-v4-flash-free`, `opencode/mimo-v2.5-free`, `opencode/nemotron-3-super-free`, and `opencode/big-pickle`) are deterministic compatibility gates. Optional live checks are never part of `npm run check`.

## Commands

Use `/dcp` (or `/dcp menu`) to open the interactive settings menu. If the extension was already running when it was updated, run `/reload` once before testing the command. In print/JSON mode there is no interactive menu; edit the settings file directly or use `/dcp status`. The menu edits and saves `~/.pi/agent/dcp_settings.json` (or the directory selected by `PI_CODING_AGENT_DIR`). Use `/dcp status` for status and help, `/dcp context` for compact context and nudge status, `/dcp debug` for nudge troubleshooting details, `/dcp stats`, `/dcp sweep [N]`, `/dcp manual [on|off]`, `/dcp compress [focus]`, `/dcp decompress [N|bNNNN]`, `/dcp recompress [N|bNNNN]`, or `/dcp reload`.

Defaults follow the proven OpenCode DCP baseline where it maps cleanly: enabled compression, `allow` permission, detailed chat notifications, automatic deduplication and error-input purging, soft nudges beginning at 35% context, an imperative nudge at 70% context, a critical recovery nudge at 90% context, and a five-turn reminder interval. Pi 0.84.1 provides the built-in tools `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls`. The default protected tool set is Pi-native: `compress`, `write`, `edit`, and the configured `@juicesharp/rpiv-todo` extension's `todo` tool. The `todo` tool is protected both from ordinary pruning and from compression ranges. Read-only tools and `bash` remain eligible for pruning/compression by default; add any tool to the protected list when its output must remain intact. Recent-turn protection and complete-user-message protection remain opt-in.

The menu exposes minimum, maximum, and critical context percentages, turns between nudges, extension enablement, compression permission, automatic pruning, recent-turn and complete-user-message protection, notification settings, and protected tools/path patterns. Nudge severity is automatic: below the minimum threshold no context nudges are sent; from 35% to below 70%, pi-dcp sends soft reminders at the configured interval; at or above 70%, it sends an imperative nudge every turn; and at or above 90%, it sends a critical recovery nudge that instructs the model to compress immediately, finishing only the current atomic operation first.

### Nudge severity and provider-facing roles

Nudges are created as Pi `custom` messages with `display: false`. This means they are transient outgoing-context instructions: they are included in the provider request but are not intended to appear as visible chat output or alter the persisted conversation history. Pi's `custom` message type is an extension/session representation, not a standard role understood by language-model APIs. Before sending, Pi converts a custom message to a provider-facing `user` message containing the nudge text. The `customType` and `details` metadata are for Pi and extensions; the model does not receive them as separate authority or role signals.

Consequently, pi-dcp's current soft, imperative, and critical nudges all reach the model as user-role content. Their severity is selected automatically from context usage:

- `soft` — optional reminder from the minimum threshold until the normal maximum threshold, subject to the configured interval.
- `imperative` — mandatory-sounding request at the normal maximum threshold, sent every turn.
- `critical` — emergency recovery wording at the critical threshold, sent every turn; it tells the model to finish only the current atomic operation before compressing.

There is no user-configurable nudge severity setting. This avoids conflicting controls: percentages determine severity, while the interval only controls normal soft reminders.

This differs from OpenCode DCP, where soft turn/iteration nudges are injected into an assistant-role message and strong nudges into a user-role message. OpenCode uses that distinction because its context path does not expose Pi's extension-defined custom-message representation. pi-dcp deliberately leaves all nudges as transient Pi custom messages for now, which preserves one implementation path and avoids changing the apparent speaker in persisted history. A future experiment may map soft nudges to assistant-role content to make them less authoritative, but that could also make them easier for the model to ignore and may require provider-specific ordering and compatibility tests. System-role injection is intentionally not used: it could give a runtime reminder higher authority than intended and blur the boundary with Pi's actual system instructions.

The role described here is the role the provider receives, not the internal Pi message shape. `display: false` does not make a nudge invisible to the model; it only suppresses normal UI display.

### Nudge troubleshooting

`/dcp context` reports the last nudge evaluation and the turn on which a nudge was last inserted. `/dcp debug` adds the non-sensitive inputs used for that decision: reported token usage, context window, resolved minimum/maximum/critical token thresholds, turns since the last nudge, whether the current turn was already nudged, the selected severity, and the last transform result. Reasons include `usage_unavailable`, `below_minimum`, `interval_not_elapsed`, `already_nudged_this_turn`, and `ready`. No nudge text, summaries, tool arguments, paths, or provider credentials are logged.

Nudges are evaluated during the outgoing context hook. A debug command run before any context transformation reports that no context transform has been recorded; run it after an agent request when diagnosing a missing nudge.

### Notification channels

Notification level controls how much detail is shown (`off`, `minimal`, `summary`, or `detailed`). The notification channel is independent and can be `chat`, `toast`, or `both`:

- `chat` adds a visible `pi-dcp.notification` message to the transcript without triggering an agent turn.
- `toast` uses Pi's transient UI notification.
- `both` does both.

Chat notifications are session messages and therefore may contribute to future context; they are not compression nudges and do not request model action.

The editable file uses the same shape as the menu. For example:

```json
{
  "enabled": true,
  "nudge": {
    "minContextPercent": 35,
    "maxContextPercent": 70,
    "criticalContextPercent": 90,
    "turnsBetweenNudges": 5
  },
  "compress": { "permission": "allow", "protectUserMessages": false },
  "manualMode": { "automaticStrategies": true },
  "turnProtection": { "enabled": true, "turns": 4 },
  "pruneNotification": "summary",
  "pruneNotificationType": "both"
}
```

Compression summaries are authored by the model through the `compress` tool. References such as `m0001` and `b0001` are ephemeral snapshot aliases and are never persisted as state. A stale or ambiguous snapshot fails closed and sends the untouched context.

## Configuration

Configuration is read from trusted global and project `dcp.jsonc`/`dcp.json` layers, followed by the personal `~/.pi/agent/dcp_settings.json` file. The personal settings file is the menu's editable source and takes precedence for overlapping keys; untrusted project files are not opened. The complete supported schema is implemented in `src/config`; unknown and excluded settings are rejected or warned. Arrays extend protection baselines. See `IMPLEMENTATION_PLAN.md` for the frozen behavior contract.

## Privacy and rollback

Logs, notifications, and statistics contain metadata and reason codes only; they never include summaries, paths, arguments, results, images, or credentials. Removing or disabling pi-dcp immediately restores ordinary Pi context. Existing journal entries are inert without the extension and are not repaired.

## License

AGPL-3.0-or-later. Distribution must include corresponding source, this license notice, and attribution for the Pi/OpenCode compatibility fixtures where applicable.
