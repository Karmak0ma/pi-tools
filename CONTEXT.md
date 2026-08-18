# CONTEXT.md — pi-tools glossary

## Terms

- **Claude subscription**: the claude.ai consumer account (Pro/Max plan) the user logs into via OAuth. Distinct from Anthropic Console API-key billing.
- **Claude OAuth credential**: the `sk-ant-oat01-…` access token (plus refresh token) Pi stores for the `anthropic` provider in `~/.pi/agent/auth.json`.
- **Utilization window**: a rolling quota window on the Claude subscription (5-hour, 7-day). Each window reports `utilization` (percentage used, 0–100) and `resets_at` (when the window resets). The API has no monthly window anymore; monthly lives in extra-usage credits.
- **Remaining percentage**: `100 − utilization` for a window. This extension's headline number.
- **Usage extension**: the pi extension in this repo (`pi-usage-vflo`). It reports Claude subscription usage (`anthropic` provider) and ChatGPT subscription usage (`openai-codex` provider), and may later absorb the remaining `@narumitw/pi-usage` providers (Copilot, OpenRouter, Zen).
- **Statusline item**: a compact pi-statusline segment (e.g. `claude 5h 38% · wk 62%` for Claude, `codex 5h 59% · wk 41%` for Codex) refreshed periodically.
- **Fail closed**: when the needed credential is missing or the account can't be verified, show an explicit error instead of guessing.
- **Codex usage**: ChatGPT subscription usage for the `openai-codex` provider, from the undocumented `wham/usage` endpoint. Windows: primary (5-hour) and secondary (weekly); plus a credits metric.
- **Usage report**: the provider-agnostic normalized shape (`UsageReport`: semantics, buckets with used/remaining/limit, metrics) that the extension exposes as its library API — the same contract `@narumitw/pi-usage` defined, which sidebar-vflo consumes.
- **Provider-bound**: the statusline shows usage only for the current model's provider — `anthropic` → Claude subscription, `openai-codex` → Codex. Unsupported providers (e.g. `opencode-cli`) show nothing.
- **Resets at**: when a utilization window resets (from the provider's `resets_at` field).