---
description: Show GitHub Copilot quota and usage (premium requests, plan, reset date)
allowed-tools: Bash
model: haiku
---

Show the user their current GitHub Copilot usage and quota.

1. Use `ANTHROPIC_BASE_URL` as the proxy base — Claude Code already has it set to the Copilot proxy (may be `http://localhost:18080` for a local proxy or a remote URL like `https://clproxy.example.com`). Do not hardcode localhost.

2. Fetch the usage endpoint. Claude Code already has `ANTHROPIC_AUTH_TOKEN` (or `ANTHROPIC_API_KEY`) set — pass it as a `Authorization: Bearer` header. The proxy treats that value as the shared secret when `COPILOT_PROXY_API_KEY` is enforced; if it isn't enforced, any value passes (or no header at all).
   ```bash
   key="${ANTHROPIC_AUTH_TOKEN:-${ANTHROPIC_API_KEY:-}}"
   curl -s "$ANTHROPIC_BASE_URL/v1/copilot/usage" \
     -H "Authorization: Bearer ${key}"
   ```

   Note: do NOT wrap the `-H` flag inside a `${var:+...}` expansion — quotes inside that expansion are literal characters, and word-splitting will mangle the header so the proxy sees an invalid bearer. Always pass the header directly; the proxy ignores it when `COPILOT_PROXY_API_KEY` isn't enforced.

3. Parse the JSON response and present a concise summary. The most useful fields:
   - `summary` — one-line human-readable summary (use this as the headline)
   - `copilot_plan` — `free` / `individual` / `business` / `enterprise`
   - `quota_snapshots.premium_interactions` — `entitlement` (monthly limit), `remaining`, `percent_remaining`, `overage_permitted`. Negative `remaining` means they've gone over and are accruing overage charges (only billed if `overage_permitted` is true).
   - `overage_cost_usd` — current overage cost in USD (0 if under quota or overage blocked)
   - `projected_overage_cost_usd` — linear projection of month-end overage cost based on current burn rate (`null` if too early to project or overage not billable)
   - `premium_request_overage_rate_usd` — per-request overage rate (default `0.04`)
   - `quota_snapshots.chat` / `completions` — usually `unlimited: true` on paid plans
   - `quota_reset_date` — when premium counter rolls over (YYYY-MM-DD)
   - `organization_list` — which orgs are paying for the seat (if any)

4. Format example (when over quota):
   ```
   GitHub Copilot · business plan
   Premium requests: 1500 / 300 (500% · $48.00 · billable)
   Projected month-end: ~$72.00
   Chat / completions: unlimited
   Resets: 2026-01-01
   Org: your-org
   ```

   When over quota: numerator is total used (entitlement + overage), denominator is entitlement, `X%` is `(used / entitlement) × 100` — matching GitHub's dashboard, where 100% = at quota and anything higher = over. Dollar figure is `overage_cost_usd`. Append `· billable` when `overage_permitted` is true, `· blocked` (no dollar figure) when false. Show the projected line only when `projected_overage_cost_usd` is present and greater than the current cost. When under quota, just show `{used} / {entitlement}` with no percent / cost suffix.

5. If the proxy returns 502 or the request fails, the proxy is likely not running or the OAuth token expired. Suggest:
   - Check the proxy is up: `curl "$ANTHROPIC_BASE_URL/health"`
   - Re-authenticate: `node scripts/auth.mjs`

Be concise — usually the user just wants the summary line plus the reset date.
