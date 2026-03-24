#!/bin/bash
set -e
# Start the VoiceMode channel server
# When loaded as a plugin: CLAUDE_PLUGIN_ROOT and CLAUDE_PLUGIN_DATA are set by Claude Code
# When running from the repo: falls back to script directory

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$SCRIPT_DIR}"
PLUGIN_DATA="${CLAUDE_PLUGIN_DATA:-$SCRIPT_DIR}"

# ESM module resolution requires node_modules next to the source files.
# Plugin root (source) and plugin data (deps) may be separate directories,
# so we symlink node_modules into the root if needed.
if [ ! -e "${PLUGIN_ROOT}/node_modules" ] && [ -d "${PLUGIN_DATA}/node_modules" ]; then
  ln -sf "${PLUGIN_DATA}/node_modules" "${PLUGIN_ROOT}/node_modules"
fi

exec "${PLUGIN_DATA}/node_modules/.bin/tsx" "${PLUGIN_ROOT}/index.ts"
