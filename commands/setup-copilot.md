---
description: Set up and start using Claude through GitHub Copilot
allowed-tools: Bash
---

Help the user set up the GitHub Copilot provider for Claude Code. Follow these steps:

1. First, check if the plugin exists:
   ```
   ls ${CLAUDE_PLUGIN_ROOT}/../github-copilot-provider/scripts/
   ```

2. Check if the user is already authenticated (checks repo-local `.config/auth.json` first, then legacy `~/.claude-copilot-auth.json`):
   ```
   cat ${CLAUDE_PLUGIN_ROOT}/../github-copilot-provider/.config/auth.json 2>/dev/null || cat ~/.claude-copilot-auth.json 2>/dev/null
   ```

3. If not authenticated, tell the user to run in a separate terminal:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/../github-copilot-provider/scripts/auth.mjs
   ```
   Wait for them to confirm they've completed authentication.

4. Once authenticated, tell the user how to start the proxy and use it:

   **Terminal 1** — Start the proxy:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/../github-copilot-provider/scripts/proxy.mjs
   ```

   **Terminal 2** — Run Claude Code:
   ```
   ANTHROPIC_BASE_URL=http://localhost:18080 ANTHROPIC_AUTH_TOKEN=copilot-proxy claude
   ```

5. For convenience, suggest they add a shell alias:
   ```bash
   # Add to ~/.zshrc or ~/.bashrc
   alias claude-copilot='ANTHROPIC_BASE_URL=http://localhost:18080 ANTHROPIC_AUTH_TOKEN=copilot-proxy claude'
   ```

Be concise and guide them through each step, verifying success before moving on.
