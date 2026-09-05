#!/usr/bin/env bash

# Launch script: ensures the Docker proxy is running, then starts Claude Code
# Usage: ./scripts/launch.sh [claude-code-args...]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PORT="${COPILOT_PROXY_PORT:-18080}"
# Resolve auth file: explicit override → repo .config/auth.json → legacy ~/.claude-copilot-auth.json
if [ -n "$COPILOT_AUTH_FILE" ]; then
    AUTH_FILE="$COPILOT_AUTH_FILE"
elif [ -f "$PROJECT_DIR/.config/auth.json" ]; then
    AUTH_FILE="$PROJECT_DIR/.config/auth.json"
else
    AUTH_FILE="$HOME/.claude-copilot-auth.json"
fi

# Check auth
if [ ! -f "$AUTH_FILE" ]; then
    echo "✗ Not authenticated. Run authentication first:"
    echo "  node $SCRIPT_DIR/auth.mjs"
    exit 1
fi

# Check if proxy is already running (Docker or otherwise)
if curl -s "http://localhost:$PORT/health" > /dev/null 2>&1; then
    echo "✓ Proxy already running on port $PORT"
else
    # Try Docker first, fall back to direct node
    if command -v docker &> /dev/null && docker info &> /dev/null 2>&1; then
        echo "Starting proxy via Docker (restart: always)..."
        cd "$PROJECT_DIR"
        docker-compose up -d --build 2>/dev/null || docker compose up -d --build
        
        # Wait for proxy to be ready
        for i in $(seq 1 30); do
            if curl -s "http://localhost:$PORT/health" > /dev/null 2>&1; then
                break
            fi
            sleep 0.5
        done

        if ! curl -s "http://localhost:$PORT/health" > /dev/null 2>&1; then
            echo "✗ Docker proxy failed to start, falling back to node..."
            node "$SCRIPT_DIR/proxy.mjs" &
            PROXY_PID=$!
            for i in $(seq 1 30); do
                if curl -s "http://localhost:$PORT/health" > /dev/null 2>&1; then break; fi
                sleep 0.2
            done
            trap "kill $PROXY_PID 2>/dev/null" EXIT
        else
            echo "✓ Proxy running in Docker (auto-restarts on reboot)"
        fi
    else
        echo "Starting proxy server (no Docker found)..."
        node "$SCRIPT_DIR/proxy.mjs" &
        PROXY_PID=$!

        for i in $(seq 1 30); do
            if curl -s "http://localhost:$PORT/health" > /dev/null 2>&1; then break; fi
            sleep 0.2
        done

        if ! curl -s "http://localhost:$PORT/health" > /dev/null 2>&1; then
            echo "✗ Proxy failed to start"
            kill $PROXY_PID 2>/dev/null
            exit 1
        fi

        echo "✓ Proxy started (PID: $PROXY_PID)"
        trap "echo 'Stopping proxy...'; kill $PROXY_PID 2>/dev/null" EXIT
    fi
fi

echo "Starting Claude Code via Copilot..."
echo ""

ANTHROPIC_BASE_URL="http://localhost:$PORT" \
ANTHROPIC_AUTH_TOKEN="copilot-proxy" \
claude "$@"
