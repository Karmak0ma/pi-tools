# CONTEXT.md — pi-tools glossary

## Terms

- **Claude subscription**: the claude.ai consumer account (Pro/Max plan) the user logs into via OAuth. Distinct from Anthropic Console API-key billing.
- **Claude OAuth credential**: the `sk-ant-oat01-…` access token (plus refresh token) Pi stores for the `anthropic` provider in `~/.pi/agent/auth.json`.
- **Utilization window**: a rolling quota window on the Claude subscription (5-hour, 7-day). Each window reports `utilization` (percentage used, 0–100) and `resets_at` (when the window resets). The API has no monthly window anymore; monthly lives in extra-usage credits.
- **Remaining percentage**: `100 − utilization` for a window. This extension's headline number.
- **Usage extension**: the pi extension in this repo (`pi-usage-vflo`). It reports Claude subscription usage (`anthropic` provider), ChatGPT subscription usage (`openai-codex` provider), and GitHub Copilot subscription usage (`github-copilot` provider).
- **Statusline item**: a compact pi-statusline segment (e.g. `claude 5h 38% · wk 62%` for Claude, `codex 5h 59% · wk 41%` for Codex, or `copilot premium 67%` for Copilot) refreshed periodically.
- **Fail closed**: when the needed credential is missing or the account can't be verified, show an explicit error instead of guessing.
- **Codex usage**: ChatGPT subscription usage for the `openai-codex` provider, from the undocumented `wham/usage` endpoint. Windows: primary (5-hour) and secondary (weekly); plus a credits metric.
- **Copilot premium-request quota**: the monthly allowance of premium model requests for a GitHub Copilot subscription. It is distinct from token usage and from an unlimited standard-chat entitlement.
- **Usage report**: the provider-agnostic normalized shape (`UsageReport`: semantics, buckets with used/remaining/limit, metrics) that the extension exposes as its library API — the same contract `@narumitw/pi-usage` defined, which sidebar-vflo consumes.
- **Provider-bound**: the statusline shows usage only for the current model's provider — `anthropic` → Claude subscription, `openai-codex` → Codex, `github-copilot` → Copilot premium requests. Unsupported providers (e.g. `opencode-cli`) show nothing.
- **Resets at**: when a utilization window resets (from the provider's `resets_at` field).