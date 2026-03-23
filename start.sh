#!/bin/bash
# Start the VoiceMode channel server
# CLAUDE_PLUGIN_ROOT and CLAUDE_PLUGIN_DATA are exported by Claude Code
exec "${CLAUDE_PLUGIN_DATA}/node_modules/.bin/tsx" "${CLAUDE_PLUGIN_ROOT}/index.ts"
