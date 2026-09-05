import test from "node:test"
import assert from "node:assert/strict"

import {
  buildCopilotHeaders,
  mapModel,
  resolveCopilotModel,
} from "../scripts/proxy.mjs"

test("buildCopilotHeaders includes Copilot integration metadata", () => {
  const headers = buildCopilotHeaders({
    token: "abc123",
    hasImages: true,
    includeOpenAIIntent: true,
  })

  assert.equal(headers["Copilot-Integration-Id"], "vscode-chat")
  assert.equal(headers["Editor-Version"], "vscode/1.95.0")
  assert.equal(headers["Editor-Plugin-Version"], "copilot-chat/0.26.7")
  assert.equal(headers.Authorization, "Bearer " + "abc123")
  assert.equal(headers["Copilot-Vision-Request"], "true")
})

test("model normalization preserves valid Claude models and falls back for incompatible integrators", () => {
  assert.equal(mapModel("claude-sonnet-4"), "claude-sonnet-4.5")
  assert.equal(mapModel("claude-opus-4-7-latest"), "claude-opus-4.7")
  assert.equal(resolveCopilotModel("claude-opus-4-7", "opencode"), "claude-sonnet-4.5")
  assert.equal(resolveCopilotModel("claude-sonnet-4-6", "opencode"), "claude-sonnet-4.5")
  assert.equal(resolveCopilotModel("claude-sonnet-4.5", "vscode-chat"), "claude-sonnet-4.5")
})
