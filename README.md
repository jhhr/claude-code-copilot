# Claude Code via GitHub Copilot

<p align="center">
<img alt="pipeline" src="https://github.com/user-attachments/assets/bdc80db2-97b2-4515-ae13-ef220ba3b21c" width="full"/>
</p>

Use **Claude Code for free** by routing it through your existing GitHub Copilot subscription.

This project runs a lightweight local proxy that translates between Anthropic's Messages API (which Claude Code speaks) and OpenAI's Chat Completions API (which GitHub Copilot speaks). No Anthropic API key needed — just your Copilot subscription.

> **Fork notice** — this is an enhanced fork of [samarth777/claude-code-copilot](https://github.com/samarth777/claude-code-copilot). The upstream proxy is ~600 lines; this fork has roughly tripled the proxy code to add production-grade resilience, extended thinking, dynamic model discovery, optional auth, and config-file support. See [What's different in this fork](#whats-different-in-this-fork) for the full list.

<p align="center">
  <img src="assets/claude-copilot.png" alt="Claude Code via GitHub Copilot" width="full" />
</p>

## What's different in this fork

| Area | Upstream | This fork |
|---|---|---|
| Model list | Hardcoded array of 13 IDs | Live `GET /models` from Copilot (cached 1h) + Anthropic-style aliases; static fallback on outage |
| Extended thinking | Not forwarded | `reasoning_content` → Anthropic `thinking` blocks (streaming + non-streaming); auto-sets `reasoning_effort` per model with caps (Opus 4.7 → medium, Haiku → off) |
| Streaming usage | Reported 0 tokens | Defers `message_delta` until Copilot's final usage chunk arrives; falls back to estimation if omitted |
| Long outputs | Single `max_tokens` default | Per-model defaults (16K Opus/Sonnet 4.6+, 8K Haiku/Sonnet 4.5), tunable |
| Prompt overflow | None | Auto-truncates large tool results, recompacts on `prompt_too_long`, configurable target window |
| Retries | None | 429/503 with `Retry-After` honored + exponential backoff |
| Error mapping | Generic | Maps 503 → `overloaded_error`, 400 → `invalid_request_error`, etc. |
| Stream keepalive | None | 10s SSE pings to prevent idle proxies / load balancers from killing the connection |
| Auth | Open | Optional `COPILOT_PROXY_API_KEY` shared secret — safe to expose beyond localhost |
| Configuration | Env vars only | Env vars + optional `~/.claude-copilot-config.json` (env > file > default) |
| `cache_control` blocks | Passed through (Copilot rejects) | Stripped before forwarding |
| Cap unknown `reasoning_effort` | n/a | New values like `xhigh` clamped to per-model cap instead of 400ing |
| Copilot quota visibility | None | `GET /v1/copilot/usage` returns plan + premium-request quota + reset date (proxies GitHub's `/copilot_internal/user`); includes `/copilot-usage` slash command for Claude Code |

## Features

- **Full API Translation** — Anthropic Messages API ↔ OpenAI Chat Completions, including streaming
- **Live Model Catalog** — `/v1/models` proxies GitHub Copilot's real model list (cached 1h) so new Claude rollouts appear without a proxy update
- **Extended Thinking** — Forwards `reasoning_content` from Opus 4.7 as Anthropic `thinking` blocks
- **Long Outputs** — Per-model `max_tokens` defaults (16K for Opus/Sonnet 4.6+, 8K for Haiku/Sonnet 4.5)
- **Resilient** — Automatic retries on 429/503 with `Retry-After`, aggressive recompaction on prompt overflow, SSE keepalive pings
- **Web Search** — Emulates Anthropic's `web_search_20250305` tool using DuckDuckGo Lite (free) or Brave Search API
- **Docker Support** — Run the proxy as an always-on container that survives reboots
- **Zero Dependencies** — Pure Node.js, no npm install needed

## Prerequisites

- GitHub account with an **active Copilot subscription** (Individual, Business, or Enterprise)
- [Node.js](https://nodejs.org/) 18+ (or [Docker](https://www.docker.com/))
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed (`npm install -g @anthropic-ai/claude-code`)

## Quick Start

### 1. Clone and authenticate
```bash
git clone https://github.com/jhhr/claude-code-copilot.git
cd claude-code-copilot
node scripts/auth.mjs
```

The auth script opens a GitHub device code flow in your browser. Your token is saved to `.config/auth.json` inside the repo (legacy `~/.claude-copilot-auth.json` is honored if it already exists).

### 2. Start Claude Code

**One-command launcher (recommended):**
```bash
./scripts/launch.sh
```

This auto-starts the proxy (via Docker if available, otherwise as a background process) and launches Claude Code.

**Or use Docker directly:**
```bash
docker compose up -d
ANTHROPIC_BASE_URL=http://localhost:18080 ANTHROPIC_AUTH_TOKEN=copilot-proxy claude
```

The proxy runs with `restart: always` — it stays running across reboots.

**Securing a public deployment:** if you expose the proxy beyond localhost, copy `.env.example` to `.env` and set `COPILOT_PROXY_API_KEY` to a long random secret. `docker compose` picks it up automatically; clients must send the same value as `ANTHROPIC_AUTH_TOKEN`. Without this, any caller can use your Copilot quota.

### 3. Select your model

Inside Claude Code, use `/model` to switch between available models. The list is pulled live from your Copilot subscription's `/models` endpoint (cached 1h) — whatever Claude variants Copilot has rolled out to your account will appear automatically.

## Web Search

The proxy emulates Anthropic's web search tool so Claude Code's WebSearch works automatically.

**Search providers:**
- **Brave Search API** — Best results. Set `BRAVE_API_KEY` env var (free tier: 2000 queries/month at [api.search.brave.com](https://api.search.brave.com/))
- **DuckDuckGo Lite** — Free, no API key needed (default)

## How It Works

Claude Code sends requests in Anthropic format → proxy translates to OpenAI format → forwarded to GitHub Copilot → responses translated back. No data is stored or logged.

## Troubleshooting

**"401 Unauthorized" from Copilot**
```bash
rm ~/.claude-copilot-auth.json
node scripts/auth.mjs
```

**"EADDRINUSE: address already in use"**
```bash
lsof -ti:18080 | xargs kill -9
```

**Proxy running but Claude Code shows errors**

Make sure both environment variables are set:
```bash
ANTHROPIC_BASE_URL=http://localhost:18080 ANTHROPIC_AUTH_TOKEN=copilot-proxy claude
```

> Use `ANTHROPIC_AUTH_TOKEN` rather than `ANTHROPIC_API_KEY` — the latter triggers a conflict warning in Claude Code when a Pro/Max plan is signed in.

## Configuration

All settings can be passed as environment variables or as keys in a JSON config file. Precedence: **env var > config file > built-in default**.

**Config file lookup order:**

1. `$COPILOT_CONFIG_FILE` if set
2. `./.config/config.json` (repo-local — the recommended location, mounted into the Docker container automatically)
3. `~/.claude-copilot-config.json` (legacy, kept for back-compat)

A full template is in [`.config/config.example.json`](.config/config.example.json) — copy it to `.config/config.json`, delete the `_comment` key, edit to taste. The auth token follows the same lookup (`.config/auth.json` first, falling back to `~/.claude-copilot-auth.json`).

```json
{
  "max_prompt_tokens": 100000,
  "tool_result_max_chars": 25000,
  "default_max_output": 16384,
  "brave_api_key": "..."
}
```

| Variable | Config key | Default | Description |
|---|---|---|---|
| `COPILOT_PROXY_PORT` | `proxy_port` | `18080` | Port for the local proxy |
| `COPILOT_AUTH_FILE` | `auth_file` | `.config/auth.json` *(repo)* → `~/.claude-copilot-auth.json` *(legacy)* | Path to saved OAuth token |
| `COPILOT_PROXY_API_KEY` | `proxy_api_key` | *(none)* | Shared secret required from clients; leave unset for loopback-only |
| `COPILOT_MAX_PROMPT_TOKENS` | `max_prompt_tokens` | `115000` | Compaction target (Copilot's hard cap is 128K) |
| `COPILOT_TOOL_RESULT_MAX_CHARS` | `tool_result_max_chars` | `25000` | Max chars per tool_result block before truncation |
| `COPILOT_KEEP_RECENT_TOOL_RESULTS` | `keep_recent_tool_results` | `2` | Never-truncate this many most-recent tool results |
| `COPILOT_DEFAULT_MAX_OUTPUT` | `default_max_output` | *(model-aware)* | Override per-model `max_tokens` default |
| `BRAVE_API_KEY` | `brave_api_key` | *(none)* | Brave Search API key for web search |
| `WEB_SEARCH_MAX_RESULTS` | `web_search_max_results` | `5` | Max search results per query |
| `COPILOT_PREMIUM_REQUEST_OVERAGE_USD` | `premium_request_overage_usd` | `0.04` | Per-request overage rate used by `/v1/copilot/usage` cost estimate |
| `COPILOT_CONFIG_FILE` | — | *(see lookup order above)* | Override config file path |

## Checking your Copilot quota

The proxy exposes `GET /v1/copilot/usage` which returns your current GitHub Copilot plan, premium-request entitlement, remaining quota, and reset date. It proxies GitHub's undocumented `/copilot_internal/user` endpoint (the same one VS Code's Copilot extension uses) and caches for 5 minutes.

```bash
curl -s http://localhost:18080/v1/copilot/usage | jq '.summary, .overage_cost_usd, .projected_overage_cost_usd'
# "Copilot business · premium: 1500/300 (500% · $48.00 · billable) · resets 2026-01-01"
# 48.00
# 72.00
```

When the user is over quota and `overage_permitted` is true, the response includes a cost estimate (`overage_cost_usd`) at the current rate (`premium_request_overage_rate_usd`, default `$0.04`/request) and a linear month-end projection (`projected_overage_cost_usd`) extrapolated from the elapsed-period burn rate.

If `COPILOT_PROXY_API_KEY` is set, pass it as `x-api-key`, `Authorization: Bearer ...`, or — when headers are awkward (browsers, simple link-clicks) — as a `?api_key=...` (or `?key=...`) query parameter. The query value is stripped from request logs. For a formatted summary inside Claude Code, use the [`/copilot-usage`](commands/copilot-usage.md) slash command (see below).

## Slash commands

Drop any of these into your Claude Code commands directory (`~/.claude/commands/` or a plugin's `commands/` dir) and invoke with `/<name>`.

| Command | Purpose |
|---|---|
| [`/copilot-usage`](commands/copilot-usage.md) | Print your current Copilot plan, premium-request quota, overage cost, and reset date. Pinned to Haiku to keep the cost negligible. |
| [`/setup-copilot`](commands/setup-copilot.md) | Walk through first-time setup: checks auth state, runs the device-code flow if needed, and shows how to start the proxy. |

## License

MIT
