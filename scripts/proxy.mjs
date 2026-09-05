#!/usr/bin/env node

/**
 * Anthropic → GitHub Copilot Proxy Server
 *
 * Accepts requests in Anthropic Messages API format, translates them to
 * OpenAI Chat Completions format, forwards to api.githubcopilot.com,
 * and translates responses back to Anthropic format.
 *
 * This allows Claude Code to use GitHub Copilot as its model provider.
 */

import { createServer } from "node:http"
import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// ─── Config ──────────────────────────────────────────────────────────────────
// Optional JSON config file. Lookup order:
//   1. $COPILOT_CONFIG_FILE if set
//   2. ./.config/config.json (relative to cwd — works for repo-local + Docker
//      bind-mount of /app/.config)
//   3. ~/.claude-copilot-config.json (legacy location, kept for back-compat)
// Same lookup applies to the auth token file (auth.json / .claude-copilot-auth.json).
// Keys match env var names lowercased with the COPILOT_ prefix stripped.
// Precedence: env var > config file > built-in default.
// File is read once at startup; malformed JSON is logged and ignored (we
// fall back to env-only so a typo never bricks the proxy).
function defaultConfigLocation(repoRelative, legacyHomeFile) {
  const repoLocal = join(process.cwd(), ".config", repoRelative)
  if (existsSync(repoLocal)) return repoLocal
  return join(homedir(), legacyHomeFile)
}
const CONFIG_PATH =
  process.env.COPILOT_CONFIG_FILE ||
  defaultConfigLocation("config.json", ".claude-copilot-config.json")
let FILE_CONFIG = {}
try {
  if (existsSync(CONFIG_PATH)) {
    FILE_CONFIG = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) || {}
    console.log(`✓ Loaded config from ${CONFIG_PATH}`)
  }
} catch (err) {
  console.warn(`⚠ Ignoring malformed config at ${CONFIG_PATH}: ${err.message}`)
  FILE_CONFIG = {}
}
function cfgString(envName, fileKey, fallback) {
  if (process.env[envName] !== undefined && process.env[envName] !== "") {
    return process.env[envName]
  }
  if (FILE_CONFIG[fileKey] !== undefined && FILE_CONFIG[fileKey] !== null) {
    return String(FILE_CONFIG[fileKey])
  }
  return fallback
}
function cfgInt(envName, fileKey, fallback) {
  const raw = cfgString(envName, fileKey, String(fallback))
  const n = parseInt(raw, 10)
  return Number.isFinite(n) ? n : fallback
}
function cfgFloat(envName, fileKey, fallback) {
  const raw = cfgString(envName, fileKey, String(fallback))
  const n = parseFloat(raw)
  return Number.isFinite(n) ? n : fallback
}

const PORT = cfgInt("COPILOT_PROXY_PORT", "proxy_port", 18080)
const AUTH_FILE = cfgString(
  "COPILOT_AUTH_FILE",
  "auth_file",
  defaultConfigLocation("auth.json", ".claude-copilot-auth.json")
)
const COPILOT_API_BASE = "https://api.githubcopilot.com"
const USER_AGENT = "claude-code-copilot-provider/1.0.0"
const BRAVE_API_KEY = cfgString("BRAVE_API_KEY", "brave_api_key", "")
const WEB_SEARCH_MAX_RESULTS = cfgInt("WEB_SEARCH_MAX_RESULTS", "web_search_max_results", 5)

// Copilot enforces a hard 128K input cap for Claude models regardless of the
// model's native context window. Leave headroom for system prompt + tools.
const MAX_PROMPT_TOKENS = cfgInt("COPILOT_MAX_PROMPT_TOKENS", "max_prompt_tokens", 115000)
const TOOL_RESULT_MAX_CHARS = cfgInt("COPILOT_TOOL_RESULT_MAX_CHARS", "tool_result_max_chars", 25000)
const KEEP_RECENT_TOOL_RESULTS = cfgInt("COPILOT_KEEP_RECENT_TOOL_RESULTS", "keep_recent_tool_results", 2)
// JSON-heavy MCP payloads tokenize closer to ~3 chars/token. Optimistic
// estimates here cause us to ship requests Copilot will then 400.
const CHARS_PER_TOKEN = 3.0
const PROXY_API_KEY = cfgString("COPILOT_PROXY_API_KEY", "proxy_api_key", "")
// GitHub's public pricing for premium-request overage is $0.04/request (post-
// multiplier — the `remaining` count from /copilot_internal/user already has
// the per-model multiplier applied, so this rate is uniform regardless of
// which Claude/GPT model the user actually called). Configurable in case
// GitHub changes the price or the user's org has a custom rate.
const PREMIUM_REQUEST_OVERAGE_USD = cfgFloat(
  "COPILOT_PREMIUM_REQUEST_OVERAGE_USD",
  "premium_request_overage_usd",
  0.04
)

// ─── Context Compaction ──────────────────────────────────────────────────────

// Map Copilot HTTP status → Anthropic error type. Mirrors the official
// Anthropic API error vocabulary so Claude Code's retry/banner logic behaves
// the way it would against api.anthropic.com.
function anthropicErrorType(status) {
  if (status === 401) return "authentication_error"
  if (status === 403) return "permission_error"
  if (status === 429) return "rate_limit_error"
  if (status === 400) return "invalid_request_error"
  if (status === 404) return "not_found_error"
  if (status === 413) return "request_too_large"
  if (status === 503) return "overloaded_error"
  if (status >= 500) return "api_error"
  return "api_error"
}

// Strip Anthropic `cache_control` markers from the request before forwarding.
// Copilot ignores them; removing keeps payloads cleaner and avoids leaking
// internal markers into Copilot logs.
function stripCacheControl(req) {
  if (!req || typeof req !== "object") return req
  const clean = (parts) => {
    if (!Array.isArray(parts)) return parts
    return parts.map((p) => {
      if (p && typeof p === "object" && "cache_control" in p) {
        const { cache_control: _drop, ...rest } = p
        return rest
      }
      return p
    })
  }
  const out = { ...req }
  if (Array.isArray(out.system)) out.system = clean(out.system)
  if (Array.isArray(out.tools)) out.tools = clean(out.tools)
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((msg) => {
      if (!msg || !Array.isArray(msg.content)) return msg
      return { ...msg, content: clean(msg.content) }
    })
  }
  return out
}

// Parse tool-call arguments emitted by Copilot. Copilot occasionally ships
// malformed JSON (truncated mid-stream, escaping bugs, etc.). We default to
// `{}` to keep the conversation alive — the model usually self-corrects on
// the next turn — but log enough context to debug recurring failures.
function safeParseToolArgs(raw, toolName) {
  if (!raw) return {}
  if (typeof raw === "object") return raw
  try {
    return JSON.parse(raw)
  } catch (err) {
    const preview = String(raw).slice(0, 200).replace(/\n/g, "\\n")
    console.warn(
      `  ⚠ tool args parse failed: ${toolName || "<unknown>"} — ${err.message} | preview: ${preview}`
    )
    return {}
  }
}

function truncateToolResultBlock(block, maxChars = TOOL_RESULT_MAX_CHARS) {
  const tag = (n) => `\n\n…[truncated ${n} chars by proxy to fit Copilot's 128K prompt cap]`
  if (typeof block.content === "string") {
    if (block.content.length <= maxChars) return block
    const cut = block.content.length - maxChars
    return { ...block, content: block.content.slice(0, maxChars) + tag(cut) }
  }
  if (Array.isArray(block.content)) {
    let changed = false
    const newContent = block.content.map((p) => {
      if (p.type === "text" && typeof p.text === "string" && p.text.length > maxChars) {
        changed = true
        const cut = p.text.length - maxChars
        return { ...p, text: p.text.slice(0, maxChars) + tag(cut) }
      }
      return p
    })
    return changed ? { ...block, content: newContent } : block
  }
  return block
}

function isOrphanToolResult(msg) {
  return (
    msg?.role === "user" &&
    Array.isArray(msg.content) &&
    msg.content.length > 0 &&
    msg.content.every((p) => p.type === "tool_result")
  )
}

function estimateTokens(req) {
  const text =
    JSON.stringify(req.messages || []) +
    JSON.stringify(req.system || "") +
    JSON.stringify(req.tools || [])
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

function compactRequest(req, opts = {}) {
  if (!Array.isArray(req.messages) || req.messages.length === 0) return req

  const keepRecent = opts.keepRecent ?? KEEP_RECENT_TOOL_RESULTS
  const maxChars = opts.maxChars ?? TOOL_RESULT_MAX_CHARS
  const budget = opts.maxPromptTokens ?? MAX_PROMPT_TOKENS

  // Fast path: already under budget — nothing to do, no mutations.
  let estimate = estimateTokens(req)
  if (estimate <= budget) return req

  let newMessages = req.messages
  let truncatedCount = 0
  let droppedCount = 0

  // Step 1: drop oldest message pairs (lossless) until under budget.
  // Prefer this over lossy truncation — dropped pairs leave the remaining
  // history intact. We drop in increments of one message at a time so we
  // can stop as soon as we're under the budget.
  if (estimate > budget) {
    let trimmed = [...newMessages]
    while (estimate > budget && trimmed.length > 2) {
      trimmed.shift()
      droppedCount++
      // Clean up the front in a loop until stable: dropping an assistant
      // message can expose an orphan tool_result user message, and dropping
      // that can expose another leading assistant, so we alternate until
      // neither condition fires.
      //
      // Without the loop the sequencing bug is:
      //   [user-A] [asst-B: tool_use X] [user-C: tool_result X] ...
      //   shift user-A → front is asst-B → isOrphanToolResult=false, skip
      //   drop asst-B (leading assistant) → front is user-C: tool_result X
      //   → orphan NOT caught because we already passed that check
      //   → Copilot 400: "unexpected tool_use_id … no corresponding tool_use"
      let cleaning = true
      while (cleaning && trimmed.length > 0) {
        cleaning = false
        // Drop orphan tool_result-only user messages at the front (their
        // paired assistant tool_use was already dropped).
        while (trimmed.length > 0 && isOrphanToolResult(trimmed[0])) {
          trimmed.shift()
          droppedCount++
          cleaning = true
        }
        // Drop leading assistant messages — the Anthropic API requires the
        // first message to be a user message.
        while (trimmed.length > 0 && trimmed[0].role === "assistant") {
          trimmed.shift()
          droppedCount++
          cleaning = true
        }
      }
      estimate = estimateTokens({ ...req, messages: trimmed })
    }
    newMessages = trimmed
  }

  // Step 2: still over budget — truncate old tool results (lossy, targeted).
  // Only touch results older than the `keepRecent` most recent ones.
  if (estimate > budget) {
    const locations = []
    newMessages.forEach((msg, mi) => {
      if (msg.role !== "user" || !Array.isArray(msg.content)) return
      msg.content.forEach((part, pi) => {
        if (part.type === "tool_result") locations.push({ mi, pi })
      })
    })
    const toTruncate = locations.slice(0, Math.max(0, locations.length - keepRecent))
    if (toTruncate.length > 0) {
      const keyed = new Set(toTruncate.map((l) => `${l.mi}:${l.pi}`))
      newMessages = newMessages.map((msg, mi) => {
        if (msg.role !== "user" || !Array.isArray(msg.content)) return msg
        let changed = false
        const newContent = msg.content.map((part, pi) => {
          if (part.type !== "tool_result" || !keyed.has(`${mi}:${pi}`)) return part
          const next = truncateToolResultBlock(part, maxChars)
          if (next !== part) {
            changed = true
            truncatedCount++
          }
          return next
        })
        return changed ? { ...msg, content: newContent } : msg
      })
      estimate = estimateTokens({ ...req, messages: newMessages })
    }
  }

  // Step 3: last resort — truncate even the most recent tool results
  // (e.g. a single oversized MCP response is itself the offender).
  if (estimate > budget) {
    newMessages = newMessages.map((msg) => {
      if (msg.role !== "user" || !Array.isArray(msg.content)) return msg
      let changed = false
      const newContent = msg.content.map((part) => {
        if (part.type !== "tool_result") return part
        const next = truncateToolResultBlock(part, maxChars)
        if (next !== part) {
          changed = true
          truncatedCount++
        }
        return next
      })
      return changed ? { ...msg, content: newContent } : msg
    })
    estimate = estimateTokens({ ...req, messages: newMessages })
  }

  if (truncatedCount > 0 || droppedCount > 0) {
    console.log(
      `  ✂ Compaction: truncated ${truncatedCount} old tool_result(s), dropped ${droppedCount} message(s), est ~${estimate} tokens`
    )
  }

  return truncatedCount > 0 || droppedCount > 0 ? { ...req, messages: newMessages } : req
}

// Detect Copilot's prompt-overflow error so we can recompact + retry rather
// than killing the session.
function isPromptOverflowError(status, text) {
  if (status !== 400 && status !== 413) return false
  const s = (text || "").toLowerCase()
  return (
    s.includes("model_max_prompt_tokens_exceeded") ||
    s.includes("max_prompt_tokens") ||
    s.includes("prompt is too long") ||
    s.includes("context length") ||
    s.includes("too many tokens")
  )
}

// Aggressive recompaction for retry-on-overflow: drop the "keep recent"
// guarantee and halve per-result budget so the current oversized MCP
// response is also trimmed.
function aggressiveCompact(anthropicReq) {
  return compactRequest(anthropicReq, {
    keepRecent: 0,
    maxChars: Math.max(2000, Math.floor(TOOL_RESULT_MAX_CHARS / 2)),
    maxPromptTokens: Math.floor(MAX_PROMPT_TOKENS * 0.85),
  })
}

// ─── Web Search ──────────────────────────────────────────────────────────────

/**
 * Execute a web search using available providers.
 * Priority: Brave Search API > DuckDuckGo HTML > DuckDuckGo Instant Answer API
 */
async function executeWebSearch(query) {
  console.log(`  🔍 Executing web search: "${query}"`)

  if (BRAVE_API_KEY) {
    const results = await braveSearch(query)
    if (results && results.length > 0) return results
    console.log(`  ⚠ Brave Search failed, trying DuckDuckGo Lite...`)
  }

  const ddgLiteResults = await duckDuckGoLiteSearch(query)
  if (ddgLiteResults && ddgLiteResults.length > 0) return ddgLiteResults

  console.log(`  ⚠ DuckDuckGo Lite failed, trying instant answer API...`)
  const instantResults = await duckDuckGoInstantAnswer(query)
  if (instantResults && instantResults.length > 0) return instantResults

  console.log(`  ⚠ All search providers failed`)
  return []
}

async function braveSearch(query) {
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${WEB_SEARCH_MAX_RESULTS}`
    const res = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": BRAVE_API_KEY,
      },
    })
    if (!res.ok) {
      console.log(`  ⚠ Brave API error: ${res.status}`)
      return null
    }
    const data = await res.json()
    const results = (data.web?.results || []).slice(0, WEB_SEARCH_MAX_RESULTS)
    console.log(`  ✓ Brave Search returned ${results.length} results`)
    return results.map((r) => ({
      type: "web_search_result",
      url: r.url,
      title: r.title || "",
      encrypted_content: Buffer.from(r.description || "").toString("base64"),
      page_age: r.age || null,
    }))
  } catch (err) {
    console.log(`  ⚠ Brave Search error: ${err.message}`)
    return null
  }
}

async function duckDuckGoLiteSearch(query) {
  try {
    const res = await fetch("https://lite.duckduckgo.com/lite/", {
      method: "POST",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "text/html",
        "Accept-Language": "en-US,en;q=0.9",
      },
      body: `q=${encodeURIComponent(query)}&kl=us-en`,
      redirect: "follow",
    })
    if (!res.ok) {
      console.log(`  ⚠ DDG Lite HTTP error: ${res.status}`)
      return null
    }
    const html = await res.text()

    // Check for CAPTCHA
    if (html.includes("captcha") || html.includes("anomaly") || html.includes("challenge")) {
      console.log(`  ⚠ DDG Lite returned CAPTCHA`)
      return null
    }

    const results = []

    // Extract result-link elements: <a ... class='result-link'>Title</a>
    const linkRegex = /<a\s+rel="nofollow"\s+href="([^"]+)"\s+class='result-link'>([\s\S]*?)<\/a>/g
    let match
    const links = []
    while ((match = linkRegex.exec(html)) !== null) {
      links.push({
        url: match[1],
        title: match[2]
          .replace(/<\/?b>/g, "")
          .replace(/&#x27;/g, "'")
          .replace(/&#92;/g, "\\")
          .replace(/&amp;/g, "&")
          .replace(/&quot;/g, '"')
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .trim(),
      })
    }

    // Extract result-snippet elements: <td class='result-snippet'>...</td>
    const snippetRegex = /<td\s+class='result-snippet'>\s*([\s\S]*?)\s*<\/td>/g
    const snippets = []
    while ((match = snippetRegex.exec(html)) !== null) {
      snippets.push(
        match[1]
          .replace(/<\/?b>/g, "")
          .replace(/&#x27;/g, "'")
          .replace(/&#92;/g, "\\")
          .replace(/&amp;/g, "&")
          .replace(/&quot;/g, '"')
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/\s+/g, " ")
          .trim()
      )
    }

    // Combine links + snippets into results
    for (let i = 0; i < Math.min(links.length, WEB_SEARCH_MAX_RESULTS); i++) {
      const snippet = i < snippets.length ? snippets[i] : links[i].title
      results.push({
        type: "web_search_result",
        url: links[i].url,
        title: links[i].title,
        encrypted_content: Buffer.from(snippet).toString("base64"),
        page_age: null,
      })
    }

    console.log(`  ✓ DDG Lite returned ${results.length} results`)
    return results.length > 0 ? results : null
  } catch (err) {
    console.log(`  ⚠ DDG Lite error: ${err.message}`)
    return null
  }
}

async function duckDuckGoInstantAnswer(query) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
    })
    if (!res.ok) return null
    const data = await res.json()

    const results = []

    // Main abstract
    if (data.AbstractURL && data.AbstractText) {
      results.push({
        type: "web_search_result",
        url: data.AbstractURL,
        title: data.Heading || query,
        encrypted_content: Buffer.from(data.AbstractText).toString("base64"),
        page_age: null,
      })
    }

    // Related topics
    for (const topic of (data.RelatedTopics || []).slice(0, WEB_SEARCH_MAX_RESULTS - results.length)) {
      if (topic.FirstURL && topic.Text) {
        results.push({
          type: "web_search_result",
          url: topic.FirstURL,
          title: topic.Text.substring(0, 100),
          encrypted_content: Buffer.from(topic.Text).toString("base64"),
          page_age: null,
        })
      }
    }

    console.log(`  ✓ DuckDuckGo Instant Answer returned ${results.length} results`)
    return results.length > 0 ? results : null
  } catch (err) {
    console.log(`  ⚠ DDG Instant Answer error: ${err.message}`)
    return null
  }
}

/**
 * fetch wrapper that retries on transient errors (429, 503) up to twice.
 * Honors `Retry-After` (seconds or HTTP-date) when present; otherwise uses
 * exponential backoff (1s, 2s, 4s). Never retries client errors other than
 * 429 — those are caller bugs and should bubble up. Prompt-overflow 400s are
 * also not retried here; they have a dedicated recompaction path.
 */
async function fetchWithRetry(url, opts, { retries = 2, label = "copilot" } = {}) {
  const RETRY_STATUSES = new Set([429, 503])
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, opts)
    if (res.ok || !RETRY_STATUSES.has(res.status) || attempt === retries) {
      return res
    }
    const ra = res.headers.get("retry-after")
    let waitMs
    if (ra) {
      const asInt = parseInt(ra, 10)
      if (!Number.isNaN(asInt)) {
        waitMs = asInt * 1000
      } else {
        const asDate = Date.parse(ra)
        waitMs = Number.isNaN(asDate) ? null : Math.max(0, asDate - Date.now())
      }
    }
    if (waitMs == null) waitMs = 1000 * Math.pow(2, attempt) // 1s, 2s, 4s
    // Cap individual wait at 30s to avoid hanging sessions on broken servers.
    waitMs = Math.min(waitMs, 30_000)
    console.log(
      `  ↻ ${label} ${res.status} — retrying in ${Math.round(waitMs)}ms (attempt ${attempt + 1}/${retries})`
    )
    // Drain body so the socket can be reused.
    try { await res.text() } catch {}
    await new Promise((r) => setTimeout(r, waitMs))
  }
  // Unreachable — loop always returns by attempt === retries branch.
  throw new Error(`fetchWithRetry: exhausted retries without response (${label})`)
}

/**
 * Lazy-fetch Copilot's real model catalog. The hardcoded /v1/models list we
 * ship works as a fallback, but the live catalog tracks new Copilot rollouts
 * (and respects what the user's subscription tier actually exposes).
 *
 * Cached in-memory for 1h. Fetch failures fall back to the static list — we
 * never block /v1/models on a Copilot outage.
 */
const MODEL_CACHE_TTL_MS = 60 * 60 * 1000
let modelCache = { fetchedAt: 0, models: null }

// Hardcoded fallback — also used by the synthetic /v1/models when we want to
// surface Anthropic-style aliases that Copilot's catalog doesn't list
// verbatim (e.g. dated suffixes Claude Code sends).
const STATIC_MODEL_FALLBACK = [
  "claude-opus-4-7",
  "claude-opus-4-7-latest",
  "claude-opus-4-6",
  "claude-opus-4-6-latest",
  "claude-opus-4-5",
  "claude-opus-4-5-20251101",
  "claude-sonnet-4-6",
  "claude-sonnet-4-6-latest",
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-20250929",
  "claude-sonnet-4-20250514",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
]

async function fetchCopilotModels(token) {
  const now = Date.now()
  if (modelCache.models && now - modelCache.fetchedAt < MODEL_CACHE_TTL_MS) {
    return modelCache.models
  }
  try {
    const res = await fetch(`${COPILOT_API_BASE}/models`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": USER_AGENT,
      },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    // Copilot wraps the list under `data` like OpenAI does. Be liberal in
    // what we accept in case the wire shape shifts.
    const raw = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : []
    // Only keep Claude entries — Copilot returns GPT models too, which CC
    // can't use. Each entry has at least `{ id }`; preserve passthrough
    // fields so CC's model picker has full metadata.
    const claudeModels = raw.filter((m) => typeof m?.id === "string" && m.id.includes("claude"))
    if (claudeModels.length === 0) throw new Error("no claude models in response")
    modelCache = { fetchedAt: now, models: claudeModels }
    console.log(`  ⚡ Cached ${claudeModels.length} Copilot Claude models for 1h`)
    return claudeModels
  } catch (err) {
    console.warn(`  ⚠ Copilot /models fetch failed (${err.message}) — using static fallback`)
    return null
  }
}

// ─── Copilot Usage / Quota ──────────────────────────────────────────────────
// GitHub's undocumented /copilot_internal/user endpoint returns the same payload
// VS Code's Copilot extension fetches: plan tier, quota snapshots (chat,
// completions, premium_interactions), reset date, and per-org endpoints. It's
// "internal" — shape can change without notice — but it's also what every
// third-party Copilot dashboard (Copilot Insights, etc.) relies on, so it's
// been stable in practice.
//
// We cache for 5 minutes: long enough to absorb a CC statusline refresh loop,
// short enough that "remaining" feels live after a heavy session.
const USAGE_CACHE_TTL_MS = 5 * 60 * 1000
let usageCache = { fetchedAt: 0, payload: null }
async function fetchCopilotUsage(githubOAuthToken) {
  const now = Date.now()
  if (usageCache.payload && now - usageCache.fetchedAt < USAGE_CACHE_TTL_MS) {
    return usageCache.payload
  }
  const res = await fetch("https://api.github.com/copilot_internal/user", {
    headers: {
      // /copilot_internal/user takes the GitHub OAuth token directly (the same
      // gho_* token stored in auth.json), NOT the Copilot bearer used for
      // api.githubcopilot.com calls. Editor-Version is required — without it
      // the endpoint returns 404.
      Authorization: `token ${githubOAuthToken}`,
      "Editor-Version": "vscode/1.95.0",
      "User-Agent": USER_AGENT,
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  const data = await res.json()
  usageCache = { fetchedAt: now, payload: data }
  return data
}

// Compute overage cost (USD). When `remaining` is negative, every unit beyond
// entitlement bills at PREMIUM_REQUEST_OVERAGE_USD — but only if
// overage_permitted is true (otherwise GitHub blocks the request instead of
// charging). Returns 0 when under quota or when overage is blocked.
function computeOverageCost(pi) {
  if (!pi || !pi.overage_permitted) return 0
  const overage = Math.max(0, -(pi.remaining ?? 0))
  return overage * PREMIUM_REQUEST_OVERAGE_USD
}

// Linearly project month-end cost from current burn rate. Heuristic — assumes
// the rest of the period continues at the same daily pace as the elapsed
// period. Useful as an early warning, not a precise forecast. Returns null
// when we can't compute (missing dates, period not started, etc.).
function projectMonthEndCost(usage) {
  const pi = usage?.quota_snapshots?.premium_interactions
  if (!pi || pi.unlimited || !pi.overage_permitted) return null
  const resetDateStr = (usage?.quota_reset_date || "").slice(0, 10)
  const assignedStr = usage?.assigned_date
  if (!resetDateStr || !assignedStr) return null
  const resetDate = new Date(`${resetDateStr}T00:00:00Z`)
  // Period start is the first of the current cycle. Reset is the 1st of the
  // following month, so period start = reset - 1 month. (GitHub bills monthly.)
  const periodStart = new Date(resetDate)
  periodStart.setUTCMonth(periodStart.getUTCMonth() - 1)
  const now = new Date()
  const totalMs = resetDate - periodStart
  const elapsedMs = now - periodStart
  if (totalMs <= 0 || elapsedMs <= 0) return null
  const fractionElapsed = Math.min(1, elapsedMs / totalMs)
  if (fractionElapsed < 0.05) return null // too early to project meaningfully
  const entitlement = pi.entitlement || 0
  const used = Math.max(0, entitlement - (pi.remaining ?? entitlement))
  const overageSoFar = Math.max(0, -(pi.remaining ?? 0))
  const projectedTotalUsage = used / fractionElapsed
  const projectedOverage = Math.max(0, projectedTotalUsage - entitlement)
  return projectedOverage * PREMIUM_REQUEST_OVERAGE_USD
}

function fmtUSD(n) {
  if (!Number.isFinite(n) || n <= 0) return "$0.00"
  return `$${n.toFixed(2)}`
}

// Friendly one-line summary for human display (statusline, slash command, etc).
// When over quota, headline the percent of total quota consumed (matching
// GitHub's dashboard formula: (overage + entitlement) / entitlement × 100 —
// 100% = at quota, anything higher = over) plus the dollar cost so the
// magnitude of the breach is immediately visible in both relative and absolute
// terms:
//   "premium: 1500/300 (500% · $48.00 · billable)"
// Under quota, show the conventional used/entitlement with no cost suffix.
function summarizeUsage(u) {
  const plan = u?.copilot_plan || "unknown"
  const pi = u?.quota_snapshots?.premium_interactions
  const resetDate = (u?.quota_reset_date || "").slice(0, 10)
  if (!pi) return `Copilot ${plan} · no premium quota data`
  if (pi.unlimited) return `Copilot ${plan} · premium: unlimited · resets ${resetDate}`
  const entitlement = pi.entitlement || 0
  let premiumLine
  if (pi.remaining < 0 && entitlement > 0) {
    const used = entitlement - pi.remaining // remaining is negative here
    const pct = Math.round((used / entitlement) * 100)
    const billable = pi.overage_permitted ? "billable" : "blocked"
    const cost = computeOverageCost(pi)
    // Only show cost when billable — when blocked, no money is owed so the
    // dollar figure is misleading.
    const costSuffix = pi.overage_permitted ? ` · ${fmtUSD(cost)}` : ""
    premiumLine = `premium: ${used}/${entitlement} (${pct}%${costSuffix} · ${billable})`
  } else {
    const used = entitlement - Math.max(0, pi.remaining)
    premiumLine = `premium: ${used}/${entitlement}`
  }
  return `Copilot ${plan} · ${premiumLine} · resets ${resetDate}`
}



/**
 * Collect a full non-streaming response from Copilot.
 * Used internally for the web search tool call loop.
 */
async function collectCopilotResponse(openaiReq, token) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "User-Agent": USER_AGENT,
    "Openai-Intent": "conversation-edits",
    "x-initiator": "user",
  }
  const hasImages = JSON.stringify(openaiReq.messages).includes("image_url")
  if (hasImages) headers["Copilot-Vision-Request"] = "true"

  const reqBody = { ...openaiReq, stream: false }
  const copilotRes = await fetchWithRetry(
    `${COPILOT_API_BASE}/chat/completions`,
    { method: "POST", headers, body: JSON.stringify(reqBody) },
    { label: "copilot-collect" }
  )
  if (!copilotRes.ok) {
    const errorText = await copilotRes.text()
    throw new Error(`Copilot API error (${copilotRes.status}): ${errorText}`)
  }
  return copilotRes.json()
}

/**
 * Handle the web search tool call loop.
 *
 * When the model returns a web_search tool call, we:
 * 1. Execute the search ourselves
 * 2. Feed results back to the model
 * 3. Repeat until no more web_search calls
 * 4. Build up the content blocks for the Anthropic response
 *
 * Returns { contentBlocks, openaiResponse, searchCount }
 */
async function handleWebSearchLoop(openaiReq, token, maxSearches) {
  const contentBlocks = [] // Accumulated Anthropic content blocks
  let searchCount = 0
  let currentReq = { ...openaiReq }
  let lastResponse = null

  for (let iteration = 0; iteration < (maxSearches || 5) + 1; iteration++) {
    const response = await collectCopilotResponse(currentReq, token)
    lastResponse = response

    const choice = response.choices?.[0]
    if (!choice) break

    // Check if there's a web_search tool call
    const webSearchCall = choice.message?.tool_calls?.find(
      (tc) => tc.function?.name === "web_search"
    )

    if (!webSearchCall || searchCount >= (maxSearches || 5)) {
      // No web search — we're done. Add any text content.
      if (choice.message?.content) {
        contentBlocks.push({ type: "text", text: choice.message.content })
      }
      // Add non-web-search tool calls if any
      if (choice.message?.tool_calls) {
        for (const tc of choice.message.tool_calls) {
          contentBlocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: safeParseToolArgs(tc.function?.arguments, tc.function?.name),
          })
        }
      }
      break
    }

    // We have a web_search tool call
    searchCount++
    let searchQuery = ""
    try {
      searchQuery = JSON.parse(webSearchCall.function.arguments)?.query || ""
    } catch {
      searchQuery = webSearchCall.function.arguments || ""
    }

    // Add any text before the search
    if (choice.message?.content) {
      contentBlocks.push({ type: "text", text: choice.message.content })
    }

    // Add server_tool_use block (Anthropic format)
    const toolUseId = `srvtoolu_${Date.now()}_${searchCount}`
    contentBlocks.push({
      type: "server_tool_use",
      id: toolUseId,
      name: "web_search",
      input: { query: searchQuery },
    })

    // Execute the search
    const searchResults = await executeWebSearch(searchQuery)

    // Add web_search_tool_result block
    contentBlocks.push({
      type: "web_search_tool_result",
      tool_use_id: toolUseId,
      content: searchResults.length > 0 ? searchResults : {
        type: "web_search_tool_result_error",
        error_code: "unavailable",
      },
    })

    // Build search results text for the model
    let searchResultsText = ""
    if (searchResults.length > 0) {
      searchResultsText = "Web search results:\n\n"
      for (const r of searchResults) {
        const content = Buffer.from(r.encrypted_content, "base64").toString("utf-8")
        searchResultsText += `Title: ${r.title}\nURL: ${r.url}\nSnippet: ${content}\n\n`
      }
    } else {
      searchResultsText = "Web search returned no results."
    }

    // Build follow-up messages: original + assistant's tool call + tool result
    const followUpMessages = [
      ...currentReq.messages,
      {
        role: "assistant",
        content: choice.message?.content || null,
        tool_calls: [webSearchCall],
      },
      {
        role: "tool",
        tool_call_id: webSearchCall.id,
        content: searchResultsText,
      },
    ]

    // Also add any other tool calls from this response (non-web-search)
    const otherToolCalls = (choice.message?.tool_calls || []).filter(
      (tc) => tc.function?.name !== "web_search"
    )
    // We'll handle these in the next iteration or final response

    currentReq = { ...openaiReq, messages: followUpMessages }
  }

  return { contentBlocks, lastResponse: lastResponse, searchCount }
}

// ─── Model Mapping ──────────────────────────────────────────────────────────

const MODEL_MAP = {
  // Opus 4.7
  "claude-opus-4-7": "claude-opus-4.7",
  "claude-opus-4-7-latest": "claude-opus-4.7",
  // Opus 4.6
  "claude-opus-4-6": "claude-opus-4.6",
  "claude-opus-4-6-20260214": "claude-opus-4.6",
  "claude-opus-4-6-latest": "claude-opus-4.6",
  // Sonnet 4.6
  "claude-sonnet-4-6": "claude-sonnet-4.6",
  "claude-sonnet-4-6-latest": "claude-sonnet-4.6",
  // Sonnet 4.5
  "claude-sonnet-4-5-20250929": "claude-sonnet-4.5",
  "claude-sonnet-4-5": "claude-sonnet-4.5",
  "claude-sonnet-4-5-latest": "claude-sonnet-4.5",
  // Sonnet 4 (no native copilot model — route to 4.5)
  "claude-sonnet-4-20250514": "claude-sonnet-4.5",
  "claude-sonnet-4": "claude-sonnet-4.5",
  "claude-3-5-sonnet-20241022": "claude-sonnet-4.5",
  "claude-3-5-sonnet-latest": "claude-sonnet-4.5",
  // Opus 4.5
  "claude-opus-4-5": "claude-opus-4.5",
  "claude-opus-4-5-20251101": "claude-opus-4.5",
  "claude-opus-4-5-latest": "claude-opus-4.5",
  // Opus 4.1 (no native copilot model — route to 4.5)
  "claude-opus-4-1": "claude-opus-4.5",
  "claude-opus-4-1-latest": "claude-opus-4.5",
  // Haiku 4.5
  "claude-haiku-4-5": "claude-haiku-4.5",
  "claude-haiku-4-5-20251001": "claude-haiku-4.5",
  "claude-haiku-4-5-latest": "claude-haiku-4.5",
  "claude-haiku-4-20250414": "claude-haiku-4.5",
  "claude-3-5-haiku-20241022": "claude-haiku-4.5",
  "claude-3-haiku-20240307": "claude-haiku-4.5",
  // Legacy opus
  "claude-opus-4-20250514": "claude-opus-4.5",
  "claude-opus-4-20250918": "claude-opus-4.5",
  "claude-3-opus-20240229": "claude-opus-4.5",
  "claude-3-5-opus-latest": "claude-opus-4.5",
}

// Fallback: try to intelligently map unknown model names
function mapModel(anthropicModel) {
  if (MODEL_MAP[anthropicModel]) return MODEL_MAP[anthropicModel]

  // Try pattern matching for unknown dated versions
  const m = anthropicModel.toLowerCase()
  if (m.includes("opus") && (m.includes("4.7") || m.includes("4-7"))) return "claude-opus-4.7"
  if (m.includes("opus") && (m.includes("4.6") || m.includes("4-6"))) return "claude-opus-4.6"
  if (m.includes("opus") && (m.includes("4.5") || m.includes("4-5"))) return "claude-opus-4.5"
  if (m.includes("sonnet") && (m.includes("4.6") || m.includes("4-6"))) return "claude-sonnet-4.6"
  if (m.includes("sonnet") && (m.includes("4.5") || m.includes("4-5"))) return "claude-sonnet-4.5"
  if (m.includes("sonnet")) return "claude-sonnet-4.5"
  if (m.includes("haiku")) return "claude-haiku-4.5"
  if (m.includes("opus")) return "claude-opus-4.6"

  // Pass through as-is
  return anthropicModel
}

// Generous-but-safe default output cap per model. Anthropic's CC defaults to
// model max; Copilot still honors smaller values cleanly (`finish_reason:
// "length"`) so over-cap is non-fatal — but it does truncate code. Pick a
// value large enough that "write a long file" tasks complete in one turn.
const MODEL_MAX_OUTPUT = {
  "claude-opus-4.7": 16384,
  "claude-opus-4.6": 16384,
  "claude-opus-4.5": 16384,
  "claude-sonnet-4.6": 16384,
  "claude-sonnet-4.5": 8192,
  "claude-haiku-4.5": 8192,
}
const DEFAULT_MAX_OUTPUT_OVERRIDE = cfgInt(
  "COPILOT_DEFAULT_MAX_OUTPUT",
  "default_max_output",
  0
)

function defaultMaxOutput(copilotModel) {
  if (DEFAULT_MAX_OUTPUT_OVERRIDE > 0) return DEFAULT_MAX_OUTPUT_OVERRIDE
  return MODEL_MAX_OUTPUT[copilotModel] || 4096
}

// ─── Auth ────────────────────────────────────────────────────────────────────

function loadAuth() {
  if (!existsSync(AUTH_FILE)) {
    console.error(`✗ Auth file not found: ${AUTH_FILE}`)
    console.error("  Run 'node scripts/auth.mjs' first to authenticate.")
    process.exit(1)
  }

  try {
    const data = JSON.parse(readFileSync(AUTH_FILE, "utf-8"))
    if (!data.access_token) {
      throw new Error("No access_token in auth file")
    }
    return data.access_token
  } catch (err) {
    console.error(`✗ Failed to read auth file: ${err.message}`)
    process.exit(1)
  }
}

// ─── Message Translation (Anthropic → OpenAI) ───────────────────────────────

function translateContentPart(part) {
  if (typeof part === "string") {
    return { type: "text", text: part }
  }

  switch (part.type) {
    case "text":
      return { type: "text", text: part.text }
    case "image":
      return {
        type: "image_url",
        image_url: {
          url: `data:${part.source.media_type};base64,${part.source.data}`,
        },
      }
    case "tool_use":
      return null // Handled separately
    case "tool_result":
      return null // Handled separately
    default:
      return { type: "text", text: JSON.stringify(part) }
  }
}

function translateMessages(anthropicMessages, system) {
  const openaiMessages = []

  // System message
  if (system) {
    if (typeof system === "string") {
      openaiMessages.push({ role: "system", content: system })
    } else if (Array.isArray(system)) {
      const systemText = system
        .map((s) => {
          if (typeof s === "string") return s
          if (s.type === "text") return s.text
          return JSON.stringify(s)
        })
        .join("\n\n")
      openaiMessages.push({ role: "system", content: systemText })
    }
  }

  for (const msg of anthropicMessages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        openaiMessages.push({ role: "user", content: msg.content })
      } else if (Array.isArray(msg.content)) {
        // Check for tool_result blocks
        const toolResults = msg.content.filter((p) => p.type === "tool_result")
        const otherParts = msg.content.filter((p) => p.type !== "tool_result")

        // Tool results become separate tool messages
        for (const result of toolResults) {
          let content
          if (typeof result.content === "string") {
            content = result.content
          } else if (Array.isArray(result.content)) {
            content = result.content
              .map((p) => (p.type === "text" ? p.text : JSON.stringify(p)))
              .join("\n")
          } else {
            content = JSON.stringify(result.content)
          }

          openaiMessages.push({
            role: "tool",
            tool_call_id: result.tool_use_id,
            content: content || "",
          })
        }

        // Format remaining content parts
        if (otherParts.length > 0) {
          const parts = otherParts.map(translateContentPart).filter(Boolean)
          if (parts.length === 1 && parts[0].type === "text") {
            openaiMessages.push({ role: "user", content: parts[0].text })
          } else if (parts.length > 0) {
            openaiMessages.push({ role: "user", content: parts })
          }
        }
      }
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        openaiMessages.push({ role: "assistant", content: msg.content })
      } else if (Array.isArray(msg.content)) {
        const textParts = msg.content.filter((p) => p.type === "text")
        const toolUses = msg.content.filter((p) => p.type === "tool_use")
        // server_tool_use and web_search_tool_result are Anthropic web search blocks
        // We strip them for Copilot and inject their content as context text
        const serverToolUses = msg.content.filter((p) => p.type === "server_tool_use")
        const webSearchResults = msg.content.filter((p) => p.type === "web_search_tool_result")

        // Build text from regular text + web search context
        let textContent = textParts.map((p) => p.text).join("\n")

        // Include web search results as context for the model
        for (const wsResult of webSearchResults) {
          if (Array.isArray(wsResult.content)) {
            for (const r of wsResult.content) {
              if (r.type === "web_search_result" && r.title && r.url) {
                textContent += `\n[Search result: ${r.title} - ${r.url}]`
              }
            }
          }
        }

        const assistantMsg = {
          role: "assistant",
          content:
            textContent.length > 0
              ? textContent
              : toolUses.length > 0
                ? null
                : "",
        }

        if (toolUses.length > 0) {
          assistantMsg.tool_calls = toolUses.map((tu) => ({
            id: tu.id,
            type: "function",
            function: {
              name: tu.name,
              arguments: JSON.stringify(tu.input || {}),
            },
          }))
        }

        openaiMessages.push(assistantMsg)
      }
    }
  }

  return openaiMessages
}

// ─── Tool Translation ─────────────────────────────────────────────────────────

function translateTools(anthropicTools) {
  if (!anthropicTools || anthropicTools.length === 0) return undefined

  return anthropicTools
    .filter((tool) => tool.type !== "web_search_20250305") // Handled separately by proxy
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.input_schema || { type: "object", properties: {} },
      },
    }))
}

/**
 * Check if the request includes a web_search tool and extract its config.
 * Returns { hasWebSearch, maxUses, allowedDomains, blockedDomains, userLocation }
 */
function extractWebSearchConfig(anthropicTools) {
  if (!anthropicTools) return { hasWebSearch: false }
  const wsTool = anthropicTools.find((t) => t.type === "web_search_20250305")
  if (!wsTool) return { hasWebSearch: false }
  return {
    hasWebSearch: true,
    maxUses: wsTool.max_uses || 5,
    allowedDomains: wsTool.allowed_domains || null,
    blockedDomains: wsTool.blocked_domains || null,
    userLocation: wsTool.user_location || null,
  }
}

// ─── Response Translation (OpenAI → Anthropic) ──────────────────────────────

function translateResponseToAnthropic(openaiResponse, model) {
  const choice = openaiResponse.choices?.[0]
  if (!choice) {
    return {
      id: openaiResponse.id || `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      model: model,
      content: [],
      stop_reason: "end_turn",
      usage: {
        input_tokens: openaiResponse.usage?.prompt_tokens || 0,
        output_tokens: openaiResponse.usage?.completion_tokens || 0,
      },
    }
  }

  const content = []

  // Reasoning / thinking — Opus 4.7 with reasoning_effort returns this.
  // Surface as Anthropic's thinking block so CC's UI renders it. Must come
  // before text/tool_use blocks (matches Anthropic SDK ordering).
  const reasoning =
    (typeof choice.message?.reasoning_content === "string" && choice.message.reasoning_content) ||
    (typeof choice.message?.reasoning === "string" && choice.message.reasoning) ||
    ""
  if (reasoning) {
    content.push({ type: "thinking", thinking: reasoning, signature: "" })
  }

  // Text content
  if (choice.message?.content) {
    content.push({ type: "text", text: choice.message.content })
  }

  // Tool calls
  if (choice.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: safeParseToolArgs(tc.function?.arguments, tc.function?.name),
      })
    }
  }

  // Map finish reason
  let stopReason = "end_turn"
  if (choice.finish_reason === "tool_calls") stopReason = "tool_use"
  else if (choice.finish_reason === "length") stopReason = "max_tokens"
  else if (choice.finish_reason === "content_filter") stopReason = "end_turn"

  return {
    id: openaiResponse.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: model,
    content: content.length > 0 ? content : [{ type: "text", text: "" }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openaiResponse.usage?.prompt_tokens || 0,
      output_tokens: openaiResponse.usage?.completion_tokens || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  }
}

// ─── Streaming Translation ──────────────────────────────────────────────────

function createStreamTranslator(model, res, anthropicReq) {
  let messageId = `msg_${Date.now()}`
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let sentStart = false
  let toolCallBuffers = {} // id -> {name, arguments}
  // Char counter used to estimate output_tokens when Copilot omits usage
  // (some tool-call turns ship the final chunk without `usage`).
  let outputCharCount = 0

  function sendSSE(event, data) {
    const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    res.write(line)
  }

  // Debug: log raw Copilot chunks
  const DEBUG_STREAM = process.env.DEBUG_STREAM === "1"

  function sendStartIfNeeded() {
    if (!sentStart) {
      sentStart = true
      sendSSE("message_start", {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          model: model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })
    }
  }

  let contentBlockIndex = 0

  return {
    processChunk(chunk) {
      // Parse OpenAI SSE chunk
      if (!chunk || chunk === "[DONE]") {
        // Fall back to estimation when Copilot omits usage (happens on some
        // tool-call turns). Better an approximation than 0s in CC's /cost.
        if (inputTokens === 0 && anthropicReq) {
          inputTokens = estimateTokens(anthropicReq)
        }
        if (outputTokens === 0 && outputCharCount > 0) {
          outputTokens = Math.ceil(outputCharCount / CHARS_PER_TOKEN)
        }
        // Send message_stop
        sendSSE("message_delta", {
          type: "message_delta",
          delta: {
            stop_reason: this._stopReason || "end_turn",
            stop_sequence: null,
          },
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: cacheReadTokens,
          },
        })
        sendSSE("message_stop", { type: "message_stop" })
        // Stash for the request handler's summary log.
        this._finalInputTokens = inputTokens
        this._finalOutputTokens = outputTokens
        return true // done
      }

      let data
      try {
        data = typeof chunk === "string" ? JSON.parse(chunk) : chunk
      } catch {
        return false
      }

      sendStartIfNeeded()

      if (data.usage) {
        const cached = data.usage.prompt_tokens_details?.cached_tokens || 0
        // Anthropic's input_tokens excludes cached tokens; surface them
        // separately via cache_read_input_tokens.
        inputTokens =
          (data.usage.prompt_tokens || inputTokens + cached) - cached
        outputTokens = data.usage.completion_tokens || outputTokens
        cacheReadTokens = cached
      }

      const choice = data.choices?.[0]
      if (!choice) return false

      const delta = choice.delta
      if (DEBUG_STREAM) console.log(`  [stream] delta=${JSON.stringify(delta)?.substring(0, 120)} finish=${choice.finish_reason || ""}`)

      // Reasoning / thinking (Opus 4.7 with reasoning_effort). Copilot uses
      // `reasoning_content`; some providers emit `reasoning`. Surface as
      // Anthropic's thinking content block so CC's UI can render it.
      const reasoningChunk =
        (typeof delta?.reasoning_content === "string" && delta.reasoning_content) ||
        (typeof delta?.reasoning === "string" && delta.reasoning) ||
        ""
      if (reasoningChunk) {
        if (!this._inThinkingBlock) {
          sendSSE("content_block_start", {
            type: "content_block_start",
            index: contentBlockIndex,
            content_block: { type: "thinking", thinking: "" },
          })
          this._inThinkingBlock = true
        }
        sendSSE("content_block_delta", {
          type: "content_block_delta",
          index: contentBlockIndex,
          delta: { type: "thinking_delta", thinking: reasoningChunk },
        })
      }

      // Close thinking block when we transition to text or tool_use output
      const startingTextOrTool = (delta?.content && !this._inTextBlock) || delta?.tool_calls
      if (this._inThinkingBlock && startingTextOrTool) {
        // Anthropic's spec includes a signature_delta before closing thinking
        // (server-side cryptographic stamp). Copilot doesn't provide one, so
        // we emit a placeholder to keep CC's parser happy and close the block.
        sendSSE("content_block_delta", {
          type: "content_block_delta",
          index: contentBlockIndex,
          delta: { type: "signature_delta", signature: "" },
        })
        sendSSE("content_block_stop", {
          type: "content_block_stop",
          index: contentBlockIndex,
        })
        contentBlockIndex++
        this._inThinkingBlock = false
      }

      // Text content
      if (delta?.content) {
        outputCharCount += delta.content.length
        if (!this._inTextBlock) {
          sendSSE("content_block_start", {
            type: "content_block_start",
            index: contentBlockIndex,
            content_block: { type: "text", text: "" },
          })
          this._inTextBlock = true
        }

        sendSSE("content_block_delta", {
          type: "content_block_delta",
          index: contentBlockIndex,
          delta: { type: "text_delta", text: delta.content },
        })
      }

      // Tool calls
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const tcIndex = tc.index ?? 0
          const tcId = tc.id

          if (tcId) {
            // Close text block if open
            if (this._inTextBlock) {
              sendSSE("content_block_stop", {
                type: "content_block_stop",
                index: contentBlockIndex,
              })
              contentBlockIndex++
              this._inTextBlock = false
            }

            // New tool call
            toolCallBuffers[tcIndex] = {
              id: tcId,
              name: tc.function?.name || "",
              arguments: tc.function?.arguments || "",
            }

            sendSSE("content_block_start", {
              type: "content_block_start",
              index: contentBlockIndex + tcIndex,
              content_block: {
                type: "tool_use",
                id: tcId,
                name: tc.function?.name || "",
                input: {},
              },
            })
          } else if (tc.function?.arguments) {
            // Continuation of tool call arguments
            if (toolCallBuffers[tcIndex]) {
              toolCallBuffers[tcIndex].arguments += tc.function.arguments
            }

            sendSSE("content_block_delta", {
              type: "content_block_delta",
              index: contentBlockIndex + tcIndex,
              delta: {
                type: "input_json_delta",
                partial_json: tc.function.arguments,
              },
            })
          }
        }
      }

      // Handle finish — close content blocks now, but defer message_delta /
      // message_stop emission. With stream_options.include_usage, Copilot
      // sends a final chunk with usage AFTER the finish_reason chunk; if we
      // emit message_stop here we'd report 0 input/output tokens.
      if (choice.finish_reason) {
        if (this._inThinkingBlock) {
          sendSSE("content_block_delta", {
            type: "content_block_delta",
            index: contentBlockIndex,
            delta: { type: "signature_delta", signature: "" },
          })
          sendSSE("content_block_stop", {
            type: "content_block_stop",
            index: contentBlockIndex,
          })
          contentBlockIndex++
          this._inThinkingBlock = false
        }
        if (this._inTextBlock) {
          sendSSE("content_block_stop", {
            type: "content_block_stop",
            index: contentBlockIndex,
          })
          this._inTextBlock = false
        }

        for (const idx of Object.keys(toolCallBuffers)) {
          sendSSE("content_block_stop", {
            type: "content_block_stop",
            index: contentBlockIndex + parseInt(idx),
          })
        }

        let stopReason = "end_turn"
        if (choice.finish_reason === "tool_calls") stopReason = "tool_use"
        else if (choice.finish_reason === "length") stopReason = "max_tokens"
        this._stopReason = stopReason
      }

      return false
    },

    _inTextBlock: false,
    _inThinkingBlock: false,
    _stopReason: null,
  }
}

// ─── Request Handler ─────────────────────────────────────────────────────────

async function handleRequest(req, res, token) {
  const url = req.url || ""
  const method = req.method || "GET"

  // Parse query string once; used for query-string auth fallback below.
  // Strip the api_key param from the logged URL so secrets don't end up in logs.
  let queryApiKey = ""
  let loggedUrl = url
  const qIdx = url.indexOf("?")
  if (qIdx !== -1) {
    const params = new URLSearchParams(url.slice(qIdx + 1))
    queryApiKey = params.get("api_key") || params.get("key") || ""
    if (queryApiKey) {
      params.delete("api_key")
      params.delete("key")
      const rest = params.toString()
      loggedUrl = url.slice(0, qIdx) + (rest ? `?${rest}` : "") + " (api_key=***)"
    }
  }

  // Log every request for debugging
  console.log(`[${new Date().toISOString()}] ${method} ${loggedUrl}`)

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "*")

  if (method === "OPTIONS") {
    res.writeHead(204)
    res.end()
    return
  }

  // Health check (unauthenticated for liveness probes)
  if (url === "/health" || url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ status: "ok", provider: "github-copilot" }))
    return
  }

  // Optional shared-secret check. Set COPILOT_PROXY_API_KEY to enforce it;
  // leave unset for loopback-only deployments. Accepts the secret via header
  // (x-api-key / Authorization: Bearer) or — as a fallback for browsers and
  // anything that can't set headers — `?api_key=` / `?key=` on the query string.
  if (PROXY_API_KEY) {
    const provided =
      req.headers["x-api-key"] ||
      req.headers["authorization"]?.replace(/^Bearer\s+/i, "") ||
      queryApiKey ||
      ""
    if (provided !== PROXY_API_KEY) {
      console.log(`  ✗ Rejected: invalid API key`)
      res.writeHead(401, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          type: "error",
          error: { type: "authentication_error", message: "Invalid API key" },
        })
      )
      return
    }
  }

  // Handle messages endpoint - match any path ending in /messages or containing messages
  const isMessagesEndpoint = url.includes("/messages")

  // Handle token counting / tokenizer endpoints - Claude Code calls this to
  // populate the context-window meter. MUST include `tools` in the estimate:
  // with MCP servers loaded, tool schemas often dwarf the message payload
  // (20–50K tokens of JSON), and omitting them causes the meter to freeze at a
  // misleadingly low percentage. Use the same CHARS_PER_TOKEN constant the
  // rest of the proxy uses so all our estimates stay consistent.
  if (url.includes("/count_tokens") || url.includes("/token")) {
    let body = ""
    for await (const chunk of req) {
      body += chunk
    }
    let inputTokens = 0
    try {
      const data = JSON.parse(body)
      const text =
        JSON.stringify(data.messages || []) +
        JSON.stringify(data.system || "") +
        JSON.stringify(data.tools || [])
      inputTokens = Math.ceil(text.length / CHARS_PER_TOKEN)
    } catch {}
    console.log(`  ⚡ Token count → ~${inputTokens} tokens (estimated)`)
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ input_tokens: inputTokens }))
    return
  }

  // Copilot usage / quota — calls GitHub's internal /copilot_internal/user
  // endpoint with the stored OAuth token and returns the raw payload plus a
  // human-readable `summary` string. Cached 5 minutes. Behind the API key gate
  // like everything else (the upstream payload includes org/email info).
  if (url.startsWith("/v1/copilot/usage")) {
    try {
      const data = await fetchCopilotUsage(token)
      const pi = data?.quota_snapshots?.premium_interactions
      const overageCost = computeOverageCost(pi)
      const projectedCost = projectMonthEndCost(data)
      const out = {
        summary: summarizeUsage(data),
        overage_cost_usd: Number(overageCost.toFixed(2)),
        projected_overage_cost_usd:
          projectedCost == null ? null : Number(projectedCost.toFixed(2)),
        premium_request_overage_rate_usd: PREMIUM_REQUEST_OVERAGE_USD,
        ...data,
      }
      console.log(`  ⚡ Usage → ${out.summary}`)
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(out, null, 2))
    } catch (err) {
      console.warn(`  ⚠ Usage fetch failed: ${err.message}`)
      res.writeHead(502, { "Content-Type": "application/json" })
      res.end(JSON.stringify({
        type: "error",
        error: { type: "api_error", message: `Failed to fetch Copilot usage: ${err.message}` },
      }))
    }
    return
  }

  // Handle models list endpoint — Claude Code may probe this. We surface the
  // live Copilot catalog (cached 1h) so new model rollouts appear without a
  // proxy update, plus Anthropic-style aliases (`claude-sonnet-4-5`) that
  // Claude Code typically sends as the model ID. On Copilot fetch failure
  // we fall back to the static alias list alone.
  if (url.includes("/models")) {
    const live = await fetchCopilotModels(token)
    const aliasIds = new Set(STATIC_MODEL_FALLBACK)
    if (live) {
      // Add any live IDs not already represented (e.g. new opus rollouts).
      for (const m of live) if (m?.id) aliasIds.add(m.id)
      // Some downstream tooling matches on the dotless dash form — also
      // include translated aliases for each live id.
      for (const m of live) {
        if (typeof m?.id === "string" && m.id.includes(".")) {
          aliasIds.add(m.id.replace(/\./g, "-"))
        }
      }
      const liveById = new Map(live.map((m) => [m.id, m]))
      const merged = [...aliasIds].map((id) => {
        const dotForm = id.replace(/-(\d)-(\d)$/, "-$1.$2")
        const meta = liveById.get(id) || liveById.get(dotForm)
        return meta ? { ...meta, id } : { id, object: "model" }
      })
      console.log(`  ⚡ Models endpoint → ${merged.length} (${live.length} live + aliases)`)
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ object: "list", data: merged }))
      return
    }
    console.log(`  ⚡ Models endpoint → static fallback (${STATIC_MODEL_FALLBACK.length} entries)`)
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({
      object: "list",
      data: STATIC_MODEL_FALLBACK.map((id) => ({ id, object: "model" })),
    }))
    return
  }

  if (!isMessagesEndpoint) {
    console.log(`  ⚠ Unhandled path: ${url}`)
    res.writeHead(404, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: `Not found: ${url}. Messages API is at /v1/messages` }))
    return
  }

  if (method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "Method not allowed" }))
    return
  }

  // Read request body
  let body = ""
  for await (const chunk of req) {
    body += chunk
  }

  // Log key headers for debugging
  console.log(`  Headers: anthropic-version=${req.headers["anthropic-version"] || "none"}, content-type=${req.headers["content-type"] || "none"}`)

  let anthropicReq
  try {
    anthropicReq = JSON.parse(body)
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "Invalid JSON" }))
    return
  }

  const copilotModel = mapModel(anthropicReq.model)
  const isStream = anthropicReq.stream === true

  // Compact request to fit under Copilot's 128K prompt cap.
  // Chrome DevTools MCP / CDP snapshots are the dominant cost driver — we
  // truncate older tool_result blocks first, then drop oldest message pairs.
  anthropicReq = stripCacheControl(anthropicReq)
  anthropicReq = compactRequest(anthropicReq)

  // Check for web_search tool
  const wsConfig = extractWebSearchConfig(anthropicReq.tools)
  if (wsConfig.hasWebSearch) {
    console.log(`  🔍 Web search enabled (max_uses: ${wsConfig.maxUses})`)
  }

  console.log(
    `→ ${anthropicReq.model} → ${copilotModel} | ${isStream ? "stream" : "sync"} | ${anthropicReq.messages?.length || 0} messages${wsConfig.hasWebSearch ? " | 🔍 web_search" : ""}`
  )

  // Build OpenAI request
  const openaiReq = {
    model: copilotModel,
    messages: translateMessages(anthropicReq.messages, anthropicReq.system),
    max_tokens: anthropicReq.max_tokens || defaultMaxOutput(copilotModel),
    stream: isStream,
  }

  // Ask Copilot to include token usage in the final streaming chunk.
  // Without this OpenAI-compatible servers omit `usage` in SSE, so Claude
  // Code sees 0 input/output tokens every turn.
  if (isStream) {
    openaiReq.stream_options = { include_usage: true }
  }

  // Forward reasoning_effort to Copilot when CCD requests extended thinking.
  // CCD signals effort via either:
  //   - output_config.effort: "low" | "medium" | "high"
  //   - thinking.type: "adaptive" | "enabled" (with budget_tokens)
  // Per-model behavior in Copilot (verified empirically — adjust as needed):
  //   claude-haiku-4.5     → does not support reasoning_effort at all
  //   claude-haiku-*       → assume same
  //   claude-sonnet-4.5    → does not support reasoning_effort (older sonnet)
  //   claude-opus-4.7      → caps at "medium"
  //   claude-opus-4.6      → supports up to "high"
  //   claude-sonnet-4.6    → supports up to "high"
  //   others               → try "high", let Copilot reject if unsupported
  const ccdEffort = anthropicReq.output_config?.effort
  const wantsThinking =
    ccdEffort ||
    anthropicReq.thinking?.type === "adaptive" ||
    anthropicReq.thinking?.type === "enabled" ||
    anthropicReq.thinking?.budget_tokens
  const noEffortModels = new Set([
    "claude-haiku-4.5",
    "claude-sonnet-4.5",
    "claude-opus-4.5",
  ])
  if (wantsThinking && !noEffortModels.has(copilotModel)) {
    const cap = {
      "claude-opus-4.7": "medium",
    }
    const requested = ccdEffort || "high"
    const max = cap[copilotModel]
    // Pick the lower of requested vs cap. Unknown values (e.g. "xhigh" from
    // newer Claude Code builds) are treated as higher than any known rank so
    // the cap forces them down — Copilot otherwise 400s with
    // `invalid_reasoning_effort`.
    const order = { low: 1, medium: 2, high: 3, xhigh: 4 }
    const requestedRank = order[requested] ?? Infinity
    const maxRank = order[max] ?? Infinity
    openaiReq.reasoning_effort =
      max && requestedRank > maxRank ? max : requested
  }

  if (anthropicReq.temperature !== undefined) {
    openaiReq.temperature = anthropicReq.temperature
  }

  if (anthropicReq.top_p !== undefined) {
    openaiReq.top_p = anthropicReq.top_p
  }

  if (anthropicReq.tools) {
    openaiReq.tools = translateTools(anthropicReq.tools)
    if (!openaiReq.tools || openaiReq.tools.length === 0) {
      delete openaiReq.tools
    }
  }

  // If web search is enabled, add the web_search function tool for Copilot
  if (wsConfig.hasWebSearch) {
    if (!openaiReq.tools) openaiReq.tools = []
    openaiReq.tools.push({
      type: "function",
      function: {
        name: "web_search",
        description: "Search the web for current information. Use this when you need up-to-date facts, news, or information that may not be in your training data.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The search query to look up on the web",
            },
          },
          required: ["query"],
        },
      },
    })
  }

  if (anthropicReq.stop_sequences) {
    openaiReq.stop = anthropicReq.stop_sequences
  }

  // Determine if there are images (for Copilot vision header)
  const hasImages = JSON.stringify(openaiReq.messages).includes("image_url")

  // Forward to Copilot
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "User-Agent": USER_AGENT,
    "Openai-Intent": "conversation-edits",
    "x-initiator": "user",
  }

  if (hasImages) {
    headers["Copilot-Vision-Request"] = "true"
  }

  try {
    // ── Web Search Path: use internal loop (always non-streaming internally) ──
    if (wsConfig.hasWebSearch) {
      console.log(`  ⚡ Using web search loop (internally non-streaming)`)
      try {
        const { contentBlocks, lastResponse, searchCount } = await handleWebSearchLoop(
          openaiReq, token, wsConfig.maxUses
        )

        const usage = lastResponse?.usage || {}
        const anthropicResponse = {
          id: lastResponse?.id || `msg_${Date.now()}`,
          type: "message",
          role: "assistant",
          model: anthropicReq.model,
          content: contentBlocks.length > 0 ? contentBlocks : [{ type: "text", text: "" }],
          stop_reason: contentBlocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: usage.prompt_tokens || 0,
            output_tokens: usage.completion_tokens || 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            server_tool_use: searchCount > 0 ? { web_search_requests: searchCount } : undefined,
          },
        }

        if (isStream) {
          // Emit the response as streaming SSE events
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          })

          // message_start
          const startEvent = `event: message_start\ndata: ${JSON.stringify({
            type: "message_start",
            message: {
              id: anthropicResponse.id,
              type: "message",
              role: "assistant",
              model: anthropicReq.model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: anthropicResponse.usage.input_tokens, output_tokens: 0 },
            },
          })}\n\n`
          res.write(startEvent)

          // Emit each content block
          for (let i = 0; i < contentBlocks.length; i++) {
            const block = contentBlocks[i]

            if (block.type === "text") {
              // content_block_start
              res.write(`event: content_block_start\ndata: ${JSON.stringify({
                type: "content_block_start",
                index: i,
                content_block: { type: "text", text: "" },
              })}\n\n`)

              // content_block_delta - send text in chunks for natural streaming feel
              const chunkSize = 50
              for (let j = 0; j < block.text.length; j += chunkSize) {
                const textChunk = block.text.substring(j, j + chunkSize)
                res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                  type: "content_block_delta",
                  index: i,
                  delta: { type: "text_delta", text: textChunk },
                })}\n\n`)
              }

              // content_block_stop
              res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                type: "content_block_stop",
                index: i,
              })}\n\n`)
            } else if (block.type === "server_tool_use") {
              // Emit server_tool_use block
              res.write(`event: content_block_start\ndata: ${JSON.stringify({
                type: "content_block_start",
                index: i,
                content_block: {
                  type: "server_tool_use",
                  id: block.id,
                  name: block.name,
                  input: {},
                },
              })}\n\n`)

              // Emit the query as input_json_delta
              res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                type: "content_block_delta",
                index: i,
                delta: {
                  type: "input_json_delta",
                  partial_json: JSON.stringify(block.input),
                },
              })}\n\n`)

              res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                type: "content_block_stop",
                index: i,
              })}\n\n`)
            } else if (block.type === "web_search_tool_result") {
              // Emit web_search_tool_result block
              res.write(`event: content_block_start\ndata: ${JSON.stringify({
                type: "content_block_start",
                index: i,
                content_block: block,
              })}\n\n`)

              res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                type: "content_block_stop",
                index: i,
              })}\n\n`)
            } else if (block.type === "tool_use") {
              // Regular tool use
              res.write(`event: content_block_start\ndata: ${JSON.stringify({
                type: "content_block_start",
                index: i,
                content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
              })}\n\n`)

              res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                type: "content_block_delta",
                index: i,
                delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
              })}\n\n`)

              res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                type: "content_block_stop",
                index: i,
              })}\n\n`)
            }
          }

          // message_delta
          res.write(`event: message_delta\ndata: ${JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: anthropicResponse.stop_reason, stop_sequence: null },
            usage: { output_tokens: anthropicResponse.usage.output_tokens },
          })}\n\n`)

          // message_stop
          res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`)
          res.end()
        } else {
          // Non-streaming: return the full response
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify(anthropicResponse))
        }

        console.log(`  ✓ Response sent (${searchCount} web searches performed)`)
        return
      } catch (err) {
        console.error(`✗ Web search loop error: ${err.message}`)
        // Fall through to normal path without web search
        console.log(`  ↓ Falling back to normal path without web search`)
        if (openaiReq.tools) {
          openaiReq.tools = openaiReq.tools.filter((t) => t.function?.name !== "web_search")
          if (openaiReq.tools.length === 0) delete openaiReq.tools
        }
      }
    }

    // ── Normal Path (no web search) ──
    let copilotRes = await fetchWithRetry(
      `${COPILOT_API_BASE}/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(openaiReq),
      },
      { label: "copilot-stream" }
    )

    // Retry once on prompt overflow: recompact aggressively (drop keep-recent
    // floor, halve per-result budget) and resend. Without this a single
    // oversized MCP response kills the session with no recovery.
    if (!copilotRes.ok && (copilotRes.status === 400 || copilotRes.status === 413)) {
      const errorText = await copilotRes.clone().text()
      if (isPromptOverflowError(copilotRes.status, errorText)) {
        console.log(`  ⚠ Prompt overflow detected — recompacting aggressively and retrying once`)
        const recompacted = aggressiveCompact(anthropicReq)
        const retryOpenai = {
          ...openaiReq,
          messages: translateMessages(recompacted.messages, recompacted.system),
        }
        copilotRes = await fetchWithRetry(
          `${COPILOT_API_BASE}/chat/completions`,
          {
            method: "POST",
            headers,
            body: JSON.stringify(retryOpenai),
          },
          { label: "copilot-overflow-retry" }
        )
      }
    }

    if (!copilotRes.ok) {
      const errorText = await copilotRes.text()
      console.error(`✗ Copilot API error: ${copilotRes.status} ${errorText}`)

      // Translate to Anthropic error format
      res.writeHead(copilotRes.status, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          type: "error",
          error: {
            type: anthropicErrorType(copilotRes.status),
            message: `Copilot API error (${copilotRes.status}): ${errorText}`,
          },
        })
      )
      return
    }

    if (isStream) {
      // Streaming response
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      })

      const translator = createStreamTranslator(anthropicReq.model, res, anthropicReq)

      // Periodic ping keeps the SSE connection alive through idle intervals
      // (long thinking, slow tool plans). Matches Anthropic's behavior and
      // prevents NAT/VPN/proxy timeouts mid-stream.
      const PING_INTERVAL_MS = 10_000
      const pingTimer = setInterval(() => {
        try {
          if (!res.writableEnded) {
            res.write(`event: ping\ndata: ${JSON.stringify({ type: "ping" })}\n\n`)
          }
        } catch { /* ignore — cleanup runs below */ }
      }, PING_INTERVAL_MS)
      const stopPings = () => clearInterval(pingTimer)
      res.on("close", stopPings)
      res.on("error", stopPings)
      req.on("close", stopPings)

      const reader = copilotRes.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      const logUsage = () => {
        const i = translator._finalInputTokens || 0
        const o = translator._finalOutputTokens || 0
        if (i || o) console.log(`  ⌁ usage: ${i} in / ${o} out`)
      }

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() || ""

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue
            const data = line.slice(6).trim()

            if (data === "[DONE]") {
              translator.processChunk("[DONE]")
              logUsage()
              stopPings()
              res.end()
              return
            }

            try {
              const parsed = JSON.parse(data)
              const isDone = translator.processChunk(parsed)
              if (isDone) {
                logUsage()
                stopPings()
                res.end()
                return
              }
            } catch {
              // Skip unparseable chunks
            }
          }
        }

        // If we get here without [DONE], clean up
        translator.processChunk("[DONE]")
        logUsage()
      } finally {
        stopPings()
      }
      res.end()
    } else {
      // Non-streaming response
      const openaiData = await copilotRes.json()
      const anthropicRes = translateResponseToAnthropic(
        openaiData,
        anthropicReq.model
      )
      const u = anthropicRes?.usage
      if (u) console.log(`  ⌁ usage: ${u.input_tokens || 0} in / ${u.output_tokens || 0} out`)

      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(anthropicRes))
    }

    console.log(`  ✓ Response sent`)
  } catch (err) {
    console.error(`✗ Proxy error: ${err.message}`)
    res.writeHead(500, { "Content-Type": "application/json" })
    res.end(
      JSON.stringify({
        type: "error",
        error: {
          type: "api_error",
          message: `Proxy error: ${err.message}`,
        },
      })
    )
  }
}

// ─── Server ──────────────────────────────────────────────────────────────────

const token = loadAuth()
console.log()
console.log("╔══════════════════════════════════════════════════════════╗")
console.log("║   GitHub Copilot Proxy for Claude Code                  ║")
console.log("╚══════════════════════════════════════════════════════════╝")
console.log()

const server = createServer((req, res) => handleRequest(req, res, token))

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`✗ Port ${PORT} is already in use.`)
    console.error(`  Kill the existing process:  lsof -ti:${PORT} | xargs kill -9`)
    console.error(`  Or use a different port:    COPILOT_PROXY_PORT=18081 node scripts/proxy.mjs`)
  } else {
    console.error(`✗ Server error: ${err.message}`)
  }
  process.exit(1)
})

server.listen(PORT, () => {
  console.log(`✓ Proxy server running on http://localhost:${PORT}`)
  console.log()
  console.log("  Translates: Anthropic Messages API → Copilot Chat Completions API")
  console.log()
  if (BRAVE_API_KEY) {
    console.log("  🔍 Web Search: Brave Search API (configured)")
  } else {
    console.log("  🔍 Web Search: DuckDuckGo Lite (free, no API key)")
    console.log("     For better results, set BRAVE_API_KEY (free at https://api.search.brave.com/)")
  }
  if (PROXY_API_KEY) {
    console.log(`  🔒 API key enforcement: ON (set COPILOT_PROXY_API_KEY)`)
  } else {
    console.log(`  🔓 API key enforcement: OFF (any key accepted — set COPILOT_PROXY_API_KEY to enforce)`)
  }
  console.log()
  console.log("  Use Claude Code with:")
  console.log(
    `  ANTHROPIC_BASE_URL=http://localhost:${PORT} ANTHROPIC_AUTH_TOKEN=${PROXY_API_KEY || "copilot-proxy"} claude`
  )
  console.log()
  console.log("  Press Ctrl+C to stop")
  console.log()
  console.log("─".repeat(60))
})

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n\nShutting down proxy server...")
  server.close()
  process.exit(0)
})

process.on("SIGTERM", () => {
  server.close()
  process.exit(0)
})
