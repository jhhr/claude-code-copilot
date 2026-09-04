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

const PORT = parseInt(process.env.COPILOT_PROXY_PORT || "18080", 10)
const BIND_HOST = process.env.COPILOT_PROXY_BIND_HOST || "127.0.0.1"
const AUTH_FILE =
  process.env.COPILOT_AUTH_FILE || join(homedir(), ".claude-copilot-auth.json")
const COPILOT_API_BASE = "https://api.githubcopilot.com"
const USER_AGENT = "claude-code-copilot-provider/1.0.0"
const BRAVE_API_KEY = process.env.BRAVE_API_KEY || ""
const WEB_SEARCH_MAX_RESULTS = parseInt(process.env.WEB_SEARCH_MAX_RESULTS || "5", 10)
const CORS_ALLOWED_ORIGINS = (process.env.COPILOT_PROXY_CORS_ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
const ALLOW_AUTO_MODEL = process.env.COPILOT_ALLOW_AUTO_MODEL === "1"
const DEFAULT_COPILOT_MODEL = process.env.COPILOT_DEFAULT_MODEL || "claude-sonnet-4.6"

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
  const copilotRes = await fetch(`${COPILOT_API_BASE}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(reqBody),
  })
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
            input: (() => { try { return JSON.parse(tc.function.arguments) } catch { return {} } })(),
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
  // Opus 4.6
  "claude-opus-4-6": "claude-opus-4.6",
  "claude-opus-4-6-20260214": "claude-opus-4.6",
  "claude-opus-4-6-latest": "claude-opus-4.6",
  // Sonnet 4.6
  "claude-sonnet-4-6": "claude-sonnet-4.6",
  "claude-sonnet-4-6-latest": "claude-sonnet-4.6",
  "claude-sonnet-4-6-20260219": "claude-sonnet-4.6",
  "claude-sonnet-4-6-20260301": "claude-sonnet-4.6",
  // Sonnet 4.5
  "claude-sonnet-4-5-20250929": "claude-sonnet-4.5",
  "claude-sonnet-4-5": "claude-sonnet-4.5",
  "claude-sonnet-4-5-latest": "claude-sonnet-4.5",
  // Sonnet 4
  "claude-sonnet-4-20250514": "claude-sonnet-4",
  "claude-sonnet-4": "claude-sonnet-4",
  "claude-3-5-sonnet-20241022": "claude-sonnet-4",
  "claude-3-5-sonnet-latest": "claude-sonnet-4",
  // Opus 4.5
  "claude-opus-4-5": "claude-opus-4.5",
  "claude-opus-4-5-20251101": "claude-opus-4.5",
  "claude-opus-4-5-latest": "claude-opus-4.5",
  // Opus 4.1
  "claude-opus-4-1": "claude-opus-41",
  "claude-opus-4-1-latest": "claude-opus-41",
  // Haiku 4.5
  "claude-haiku-4-5": "claude-haiku-4.5",
  "claude-haiku-4-5-20251001": "claude-haiku-4.5",
  "claude-haiku-4-5-latest": "claude-haiku-4.5",
  "claude-haiku-4-20250414": "claude-haiku-4.5",
  "claude-3-5-haiku-20241022": "claude-haiku-4.5",
  "claude-3-haiku-20240307": "claude-haiku-4.5",
  // Legacy opus
  "claude-opus-4-20250918": "claude-opus-4.5",
  "claude-3-opus-20240229": "claude-opus-4.5",
  "claude-3-5-opus-latest": "claude-opus-4.5",
}

function normalizeModelName(value) {
  return typeof value === "string" ? value.trim() : ""
}

function isAutoModel(value) {
  const model = normalizeModelName(value).toLowerCase()
  return model === "" || model === "auto" || model === "copilot-auto" || model === "default"
}

// Fallback: try to intelligently map unknown model names
function mapModel(anthropicModel) {
  if (isAutoModel(anthropicModel)) {
    if (ALLOW_AUTO_MODEL) return null
    return mapModel(DEFAULT_COPILOT_MODEL)
  }

  const normalized = normalizeModelName(anthropicModel)
  if (MODEL_MAP[normalized]) return MODEL_MAP[normalized]

  // Try pattern matching for unknown dated versions
  const m = normalized.toLowerCase()
  if (m.includes("sonnet") && (m.includes("4.6") || m.includes("4-6"))) return "claude-sonnet-4.6"
  if (m.includes("opus") && (m.includes("4.6") || m.includes("4-6"))) return "claude-opus-4.6"
  if (m.includes("sonnet") && (m.includes("4.5") || m.includes("4-5"))) return "claude-sonnet-4.5"
  if (m.includes("sonnet")) return "claude-sonnet-4"
  if (m.includes("opus") && (m.includes("4.5") || m.includes("4-5"))) return "claude-opus-4.5"
  if (m.includes("opus") && (m.includes("4.1") || m.includes("4-1") || m.includes("41"))) return "claude-opus-41"
  if (m.includes("haiku")) return "claude-haiku-4.5"
  if (m.includes("opus")) return "claude-opus-4.6"

  // Pass through as-is
  return normalized
}

function isLocalOrigin(originValue) {
  try {
    const parsed = new URL(originValue)
    const host = parsed.hostname.toLowerCase()
    return host === "localhost" || host === "127.0.0.1" || host === "::1"
  } catch {
    return false
  }
}

function isAllowedOrigin(originValue) {
  if (!originValue) return false
  if (CORS_ALLOWED_ORIGINS.includes("*")) return true
  if (CORS_ALLOWED_ORIGINS.length > 0) return CORS_ALLOWED_ORIGINS.includes(originValue)
  return isLocalOrigin(originValue)
}

function applyCorsHeaders(req, res) {
  const origin = req.headers.origin
  if (!origin) return

  if (isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin)
    res.setHeader("Vary", "Origin")
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, anthropic-version")
  }
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
        input: (() => {
          try {
            return JSON.parse(tc.function.arguments)
          } catch {
            return {}
          }
        })(),
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

function createStreamTranslator(model, res) {
  let messageId = `msg_${Date.now()}`
  let inputTokens = 0
  let outputTokens = 0
  let sentStart = false
  let toolCallBuffers = {} // id -> {name, arguments}

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
        // Send message_stop
        sendSSE("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: outputTokens },
        })
        sendSSE("message_stop", { type: "message_stop" })
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
        inputTokens = data.usage.prompt_tokens || inputTokens
        outputTokens = data.usage.completion_tokens || outputTokens
      }

      const choice = data.choices?.[0]
      if (!choice) return false

      const delta = choice.delta
      if (DEBUG_STREAM) console.log(`  [stream] delta=${JSON.stringify(delta)?.substring(0, 120)} finish=${choice.finish_reason || ""}`)

      // Text content
      if (delta?.content) {
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

      // Handle finish
      if (choice.finish_reason) {
        // Close any open blocks
        if (this._inTextBlock) {
          sendSSE("content_block_stop", {
            type: "content_block_stop",
            index: contentBlockIndex,
          })
          this._inTextBlock = false
        }

        // Close tool call blocks
        for (const idx of Object.keys(toolCallBuffers)) {
          sendSSE("content_block_stop", {
            type: "content_block_stop",
            index: contentBlockIndex + parseInt(idx),
          })
        }

        let stopReason = "end_turn"
        if (choice.finish_reason === "tool_calls") stopReason = "tool_use"
        else if (choice.finish_reason === "length") stopReason = "max_tokens"

        sendSSE("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: outputTokens },
        })
        sendSSE("message_stop", { type: "message_stop" })
        return true
      }

      return false
    },

    _inTextBlock: false,
  }
}

// ─── Request Handler ─────────────────────────────────────────────────────────

async function handleRequest(req, res, token) {
  const url = req.url || ""
  const method = req.method || "GET"

  // Log every request for debugging
  console.log(`[${new Date().toISOString()}] ${method} ${url}`)

  // CORS
  applyCorsHeaders(req, res)

  if (method === "OPTIONS") {
    if (req.headers.origin && !isAllowedOrigin(req.headers.origin)) {
      res.writeHead(403, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "Origin not allowed" }))
      return
    }
    res.writeHead(204)
    res.end()
    return
  }

  // Health check
  if (url === "/health" || url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ status: "ok", provider: "github-copilot" }))
    return
  }

  // Handle messages endpoint - match any path ending in /messages or containing messages
  const isMessagesEndpoint = url.includes("/messages")

  // Handle token counting / tokenizer endpoints - Claude Code calls this
  if (url.includes("/count_tokens") || url.includes("/token")) {
    // Read body to get token count request for accurate-ish estimation
    let body = ""
    for await (const chunk of req) {
      body += chunk
    }
    let inputTokens = 0
    try {
      const data = JSON.parse(body)
      // Rough estimation: ~4 chars per token
      const text = JSON.stringify(data.messages || []) + JSON.stringify(data.system || "")
      inputTokens = Math.ceil(text.length / 4)
    } catch {}
    console.log(`  ⚡ Token count → ~${inputTokens} tokens (estimated)`)
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ input_tokens: inputTokens }))
    return
  }

  // Handle models list endpoint — Claude Code may probe this
  if (url.includes("/models")) {
    console.log(`  ⚡ Models endpoint hit — returning available models`)
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({
      data: [
        { id: "auto", object: "model" },
        { id: "claude-sonnet-4-6", object: "model" },
        { id: "claude-opus-4-6", object: "model" },
        { id: "claude-sonnet-4-5-20250929", object: "model" },
        { id: "claude-sonnet-4-20250514", object: "model" },
        { id: "claude-opus-4-5-20251101", object: "model" },
        { id: "claude-haiku-4-5", object: "model" },
      ]
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

  const requestedModel = anthropicReq.model || "auto"
  const copilotModel = mapModel(requestedModel)
  const isStream = anthropicReq.stream === true

  // Check for web_search tool
  const wsConfig = extractWebSearchConfig(anthropicReq.tools)
  if (wsConfig.hasWebSearch) {
    console.log(`  🔍 Web search enabled (max_uses: ${wsConfig.maxUses})`)
  }

  console.log(
    `→ ${requestedModel} → ${copilotModel || "copilot-auto"} | ${isStream ? "stream" : "sync"} | ${anthropicReq.messages?.length || 0} messages${wsConfig.hasWebSearch ? " | 🔍 web_search" : ""}`
  )

  // Build OpenAI request
  const openaiReq = {
    messages: translateMessages(anthropicReq.messages, anthropicReq.system),
    max_tokens: anthropicReq.max_tokens || 4096,
    stream: isStream,
  }

  if (copilotModel) {
    openaiReq.model = copilotModel
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
    const copilotRes = await fetch(
      `${COPILOT_API_BASE}/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(openaiReq),
      }
    )

    if (!copilotRes.ok) {
      const errorText = await copilotRes.text()
      console.error(`✗ Copilot API error: ${copilotRes.status} ${errorText}`)

      // Translate to Anthropic error format
      res.writeHead(copilotRes.status, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          type: "error",
          error: {
            type:
              copilotRes.status === 401
                ? "authentication_error"
                : copilotRes.status === 429
                  ? "rate_limit_error"
                  : copilotRes.status === 403
                    ? "permission_error"
                    : "api_error",
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

      const translator = createStreamTranslator(anthropicReq.model, res)

      const reader = copilotRes.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

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
            res.end()
            return
          }

          try {
            const parsed = JSON.parse(data)
            const isDone = translator.processChunk(parsed)
            if (isDone) {
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
      res.end()
    } else {
      // Non-streaming response
      const openaiData = await copilotRes.json()
      const anthropicRes = translateResponseToAnthropic(
        openaiData,
        anthropicReq.model
      )

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

server.listen(PORT, BIND_HOST, () => {
  console.log(`✓ Proxy server running on http://${BIND_HOST}:${PORT}`)
  console.log()
  console.log("  Translates: Anthropic Messages API → Copilot Chat Completions API")
  console.log(`  Auto model mode: ${ALLOW_AUTO_MODEL ? "enabled (model omitted)" : `disabled (fallback: ${DEFAULT_COPILOT_MODEL})`}`)
  console.log()
  if (BRAVE_API_KEY) {
    console.log("  🔍 Web Search: Brave Search API (configured)")
  } else {
    console.log("  🔍 Web Search: DuckDuckGo Lite (free, no API key)")
    console.log("     For better results, set BRAVE_API_KEY (free at https://api.search.brave.com/)")
  }
  console.log()
  console.log("  Use Claude Code with:")
  console.log(
    `  ANTHROPIC_BASE_URL=http://localhost:${PORT} ANTHROPIC_API_KEY=copilot-proxy claude`
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
