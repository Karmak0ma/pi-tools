# pi-usage-vflo

Pi extension showing subscription usage for Claude (claude.ai OAuth) and OpenAI Codex (ChatGPT), as a statusline item and a `/usage` menu.

Replaces `@narumitw/pi-usage` for these two providers: it exposes the same `UsageReport` library API, which `sidebar-vflo` consumes for its Model panel subscription row.

## What it shows

- **Statusline** (provider-bound): `claude 5h 38% · wk 62%` when the current model is `anthropic`, `codex 5h 41% · wk 39%` when it is `openai-codex`. Unsupported providers (e.g. `opencode-cli`) show nothing. Refreshed every 5 minutes while a session is active.
- **`/usage` menu**: both providers' reports at once — remaining percentage per window, resets-at times, and Codex credits. `Refresh` re-queries both; `Close` exits.
- **Fail closed**: missing credential or unverifiable account shows an explicit error (`auth unavailable` / `usage error`), never a guess.

## Data sources

| Provider | Endpoint | Auth |
|---|---|---|
| `anthropic` | `GET https://api.anthropic.com/api/oauth/usage` (undocumented, same as Claude Code `/usage`) | `Bearer sk-ant-oat01-…` OAuth token; API keys are rejected — they cannot report subscription usage |
| `openai-codex` | `GET https://chatgpt.com/backend-api/wham/usage` (undocumented) | ChatGPT OAuth access token |

Both are queried only when the resolved credential's base URL is the official origin; custom/proxy origins fail closed. Responses are cached 5 minutes per account fingerprint; errors are redacted and back off 30 seconds.

## Shared result file

These endpoints rate limit hard: a second call a few seconds after the first answers `429`, and the lockout then lasts minutes. A second poller therefore does not get its own copy of the data, it makes **both** pollers fail at random. So this extension is the single owner of the network call and publishes every result to:

```text
~/.pi/agent/usage-vflo-shared.json
```

Shape: `{ version: 1, providers: { <providerId>: { report?, capturedAt?, failure? } } }`. Successes replace the entry; failures are stored next to the last good report, so a reader can keep showing the last known numbers while telling the user that the newest refresh failed. Writes are atomic (temp file + rename) and merge per provider, so several pi processes can publish concurrently. Publication failures are ignored on purpose — the file is a cache, never a source of truth.

Other extensions (for example `sidebar-vflo`) must read this file instead of querying the provider again.

This extension also reads its own file before calling the network: if the file already has a report or a failure for this provider from the last 5 minutes (respectively 30 seconds), it reuses that instead of making its own call. This is what keeps several concurrently running pi sessions from each polling the endpoint on their own schedule — without it, a 5-minute per-process cache still lets N sessions make N calls. It is a best-effort guard, not a lock: two sessions can still race if they check the file in the same instant (e.g. several sessions launched together); when that happens one call still succeeds and republishes fresh data for everyone, so the race is rare and cheap rather than a lock file's added complexity (acquisition, staleness timeout, crash cleanup).

## Library API

`adapterForProvider`, `resolveUsageAuth`, `queryProviderUsage`, `providerIsConfigured`, `SUPPORTED_ADAPTERS`, `normalizeAnthropicOauthUsagePayload`, `normalizeCodexBackendPayload`, `formatUsageReport`, `formatUsageStatusline`, `formatProviderStates`, `UsageCache`, `readSharedReportFile`, `readSharedProviderEntry`, `publishSharedReport`, `publishSharedFailure`, `SHARED_REPORT_PATH`, plus error/redaction helpers — importable from `pi-usage-vflo/src/index.js`. Types: `UsageReport`, `UsageBucket`, `UsageMetric`, `UsageProviderAdapter`, `ProviderUsageState`, `ResolvedUsageAuth`, `SharedReportFile`, `SharedProviderEntry`.

See [CONTEXT.md](../CONTEXT.md) for the domain vocabulary and [ADR-0001](../docs/adr/0001-claude-oauth-usage-endpoint.md) for why the undocumented Claude endpoint is used.