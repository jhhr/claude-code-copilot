#!/usr/bin/env node

/**
 * GitHub Copilot OAuth Device Code Authentication
 *
 * Authenticates with GitHub using the same OAuth device code flow
 * that VS Code and OpenCode use for Copilot. Saves the token to
 * ~/.claude-copilot-auth.json for use by the proxy server.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"

// Public OAuth client ID for the VS Code GitHub Copilot extension. Intentionally
// shared — this same value is hardcoded in VS Code, OpenCode, Aider, and every
// other Copilot client. GitHub only allows a whitelist of Microsoft/GitHub-owned
// apps to call api.githubcopilot.com, so reusing this ID is the only path for
// unofficial clients. Not a secret; the per-user access token is what matters.
const CLIENT_ID = "Ov23li8tweQw6odWQebz"
const DEVICE_CODE_URL = "https://github.com/login/device/code"
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token"
// Default to repo-local .config/auth.json (creates dir if missing). Legacy
// ~/.claude-copilot-auth.json is honored if it already exists (back-compat).
function defaultAuthFile() {
  const legacy = join(homedir(), ".claude-copilot-auth.json")
  if (existsSync(legacy)) return legacy
  return join(process.cwd(), ".config", "auth.json")
}
const AUTH_FILE = process.env.COPILOT_AUTH_FILE || defaultAuthFile()
const USER_AGENT = "claude-code-copilot-provider/1.0.0"

async function initiateDeviceCode() {
  const response = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      scope: "read:user",
    }),
  })

  if (!response.ok) {
    throw new Error(
      `Failed to initiate device code flow: ${response.status} ${response.statusText}`
    )
  }

  return response.json()
}

async function pollForToken(deviceCode, interval) {
  const pollInterval = (interval + 1) * 1000 // Add safety margin

  while (true) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval))

    const response = await fetch(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    })

    const data = await response.json()

    if (data.access_token) {
      return data.access_token
    }

    if (data.error === "authorization_pending") {
      process.stdout.write(".")
      continue
    }

    if (data.error === "slow_down") {
      await new Promise((resolve) => setTimeout(resolve, 5000))
      continue
    }

    if (data.error === "expired_token") {
      throw new Error("Device code expired. Please try again.")
    }

    if (data.error === "access_denied") {
      throw new Error("Authorization was denied by user.")
    }

    throw new Error(`Unexpected error: ${data.error} - ${data.error_description}`)
  }
}

async function verifyToken(token) {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": USER_AGENT,
    },
  })

  if (!response.ok) {
    throw new Error("Token verification failed")
  }

  return response.json()
}

async function checkCopilotAccess(token) {
  // Try hitting the Copilot API to verify access
  const response = await fetch("https://api.githubcopilot.com/models", {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": USER_AGENT,
      "Openai-Intent": "conversation-edits",
    },
  })

  return response.ok || response.status === 401 // 401 might just mean different auth format
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗")
  console.log("║   GitHub Copilot Authentication for Claude Code        ║")
  console.log("╚══════════════════════════════════════════════════════════╝")
  console.log()

  // Check for existing token
  if (existsSync(AUTH_FILE)) {
    try {
      const existing = JSON.parse(readFileSync(AUTH_FILE, "utf-8"))
      if (existing.access_token) {
        const user = await verifyToken(existing.access_token)
        console.log(`Already authenticated as: ${user.login}`)
        console.log(`Token file: ${AUTH_FILE}`)
        console.log()
        console.log("To re-authenticate, delete the file and run again:")
        console.log(`  rm ${AUTH_FILE}`)
        console.log(`  node scripts/auth.mjs`)
        return
      }
    } catch {
      // Token invalid, proceed with new auth
      console.log("Existing token is invalid, starting fresh authentication...\n")
    }
  }

  // Step 1: Initiate device code flow
  console.log("Initiating GitHub OAuth device code flow...\n")
  const deviceData = await initiateDeviceCode()

  // Step 2: Show user code
  console.log("┌──────────────────────────────────────────────────────────┐")
  console.log("│                                                          │")
  console.log(`│   Your code:  ${deviceData.user_code.padEnd(40)}│`)
  console.log("│                                                          │")
  console.log("│   Open this URL in your browser:                         │")
  console.log(`│   ${deviceData.verification_uri.padEnd(54)}│`)
  console.log("│                                                          │")
  console.log("│   Enter the code above and authorize the application.    │")
  console.log("│                                                          │")
  console.log("└──────────────────────────────────────────────────────────┘")
  console.log()

  // Try to open the browser automatically
  try {
    const { exec } = await import("node:child_process")
    const openCmd =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "start"
          : "xdg-open"
    exec(`${openCmd} ${deviceData.verification_uri}`)
    console.log("(Browser opened automatically)")
  } catch {
    // Ignore if we can't open the browser
  }

  console.log()
  process.stdout.write("Waiting for authorization")

  // Step 3: Poll for token
  const accessToken = await pollForToken(
    deviceData.device_code,
    deviceData.interval || 5
  )
  console.log("\n")

  // Step 4: Verify token
  const user = await verifyToken(accessToken)
  console.log(`✓ Authenticated as: ${user.login} (${user.name || "N/A"})`)

  // Step 5: Save token
  const authData = {
    access_token: accessToken,
    provider: "github-copilot",
    github_user: user.login,
    created_at: new Date().toISOString(),
  }

  mkdirSync(dirname(AUTH_FILE), { recursive: true })
  writeFileSync(AUTH_FILE, JSON.stringify(authData, null, 2))
  console.log(`✓ Token saved to: ${AUTH_FILE}`)
  console.log()
  console.log("You can now start the proxy server:")
  console.log("  node scripts/proxy.mjs")
  console.log()
  console.log("Then run Claude Code with:")
  console.log(
    "  ANTHROPIC_BASE_URL=http://localhost:18080 ANTHROPIC_AUTH_TOKEN=copilot-proxy claude"
  )
}

main().catch((err) => {
  console.error("\n✗ Authentication failed:", err.message)
  process.exit(1)
})
