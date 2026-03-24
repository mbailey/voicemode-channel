#!/bin/bash
# Start the VoiceMode channel server
# When loaded as a plugin: CLAUDE_PLUGIN_ROOT and CLAUDE_PLUGIN_DATA are set by Claude Code
# When running from the repo: falls back to script directory

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$SCRIPT_DIR}"
PLUGIN_DATA="${CLAUDE_PLUGIN_DATA:-$SCRIPT_DIR}"

# Pre-flight checks
if ! command -v node >/dev/null 2>&1; then
  echo "[voicemode-channel] ERROR: Node.js is not installed." >&2
  echo "[voicemode-channel] Install it from https://nodejs.org or via your package manager." >&2
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ] 2>/dev/null; then
  echo "[voicemode-channel] ERROR: Node.js v18+ required (found $(node -v))." >&2
  exit 1
fi

# Install dependencies if needed
if [ ! -d "${PLUGIN_DATA}/node_modules" ]; then
  echo "[voicemode-channel] Installing dependencies..." >&2
  (cd "${PLUGIN_DATA}" && npm install --production 2>&1) >&2
  if [ $? -ne 0 ]; then
    echo "[voicemode-channel] ERROR: npm install failed." >&2
    exit 1
  fi
fi

# ESM module resolution requires node_modules next to the source files.
# Plugin root (source) and plugin data (deps) may be separate directories,
# so we symlink node_modules into the root if needed.
if [ ! -e "${PLUGIN_ROOT}/node_modules" ] && [ -d "${PLUGIN_DATA}/node_modules" ]; then
  ln -sf "${PLUGIN_DATA}/node_modules" "${PLUGIN_ROOT}/node_modules"
fi

# Check tsx is available
TSX="${PLUGIN_DATA}/node_modules/.bin/tsx"
if [ ! -x "$TSX" ]; then
  echo "[voicemode-channel] ERROR: tsx not found at ${TSX}" >&2
  echo "[voicemode-channel] Try: cd ${PLUGIN_DATA} && npm install" >&2
  exit 1
fi

# Check for auth credentials
CREDS_FILE="$HOME/.voicemode/credentials"
if [ ! -f "$CREDS_FILE" ]; then
  echo "[voicemode-channel] WARNING: No credentials found at ${CREDS_FILE}" >&2
  echo "[voicemode-channel] Run: voicemode connect auth login" >&2
fi

echo "[voicemode-channel] Starting channel server (node $(node -v))..." >&2
exec "$TSX" "${PLUGIN_ROOT}/index.ts"
