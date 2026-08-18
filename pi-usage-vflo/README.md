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

## Library API

`adapterForProvider`, `resolveUsageAuth`, `queryProviderUsage`, `providerIsConfigured`, `SUPPORTED_ADAPTERS`, `normalizeAnthropicOauthUsagePayload`, `normalizeCodexBackendPayload`, `formatUsageReport`, `formatUsageStatusline`, `formatProviderStates`, `UsageCache`, plus error/redaction helpers — importable from `pi-usage-vflo/src/index.js`. Types: `UsageReport`, `UsageBucket`, `UsageMetric`, `UsageProviderAdapter`, `ProviderUsageState`, `ResolvedUsageAuth`.

See [CONTEXT.md](../CONTEXT.md) for the domain vocabulary and [ADR-0001](../docs/adr/0001-claude-oauth-usage-endpoint.md) for why the undocumented Claude endpoint is used.