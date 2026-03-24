# Changelog

All notable changes to the VoiceMode Channel plugin will be documented in this file.

## [Unreleased]

## [0.1.5] - 2026-03-25

Pre-public release hardening (VMCH-2). Four parallel reviews (security, reliability, code quality, plugin structure) identified and fixed issues across 8 files.

### Fixed
- **Security:** Replace `execSync` with `execFileSync` in `get_project_context` -- eliminates shell injection surface
- **Security:** Add WebSocket `maxPayload` limit (1 MB) -- prevents memory exhaustion from oversized payloads
- **Security:** Add inbound transcript length limit (10,000 chars) -- prevents oversized messages
- **Security:** Remove `project_path` from `capabilities_update` -- only send `context` (repo name), not full filesystem path
- **Reliability:** Heartbeat liveness detection -- force-close WebSocket after 60s silence, triggers reconnect
- **Reliability:** Guard against concurrent `start()` calls -- prevents duplicate WebSocket connections
- **Reliability:** Cancellable backoff sleep -- shutdown completes promptly instead of waiting up to 60s
- **Plugin:** Add `set -e` to `start.sh` for fail-fast on errors
- **Plugin:** Add 30s timeout to SessionStart hook -- prevents `npm install` from blocking indefinitely
- **Plugin:** Add pre-flight checks to `start.sh` for better error messages

### Changed
- Tighten `presence` field to union type (`available` | `busy` | `away`) instead of bare string
- Add runtime type checks for `voice` and `wait_for_response` tool arguments
- Sync versions across plugin.json, package.json, index.ts, and gateway.ts
- Fix README: `voicemode connect login` -> `voicemode connect auth login`
- Add troubleshooting section to README
- Add `.voicemode.env` to `.gitignore`
- Backfill changelog entries for v0.1.2 and v0.1.4

## [0.1.4] - 2026-03-24

### Added
- Session ID (`session_id`) included in `capabilities_update` for multi-session coexistence

## [0.1.3] - 2026-03-24

### Added
- **Profile tool** -- `profile` MCP tool for dynamic agent identity management
  - Call with no args to read current profile (name, display_name, context, voice, presence)
  - Call with fields to update and push capabilities_update to gateway in real-time
  - Agents can change how they appear in VoiceMode Connect mid-session
- Profile state initialized from env vars (VOICEMODE_AGENT_NAME, VOICEMODE_AGENT_DISPLAY_NAME)
- Context defaults to git repo name, overridable via profile tool
- Profile re-sent on gateway reconnect (survives connection drops)

### Changed
- Exported `ProfileData` interface and `get_project_context()` from gateway module
- `GatewayClient.send_capabilities_update()` now accepts profile data parameter
- Refactored tool handlers into separate functions (handle_reply_tool, handle_profile_tool)

## [0.1.2] - 2026-03-23

### Added
- External message prefix on channel-delivered transcripts -- prompt injection mitigation
- Load `voicemode.env` for config; fix plugin path resolution

## [0.1.1] - 2026-03-23

### Added
- Project context in capabilities_update (git repo name + project_path)
- Unique device IDs per project directory (enables multi-session coexistence)

### Changed
- Updated `voicemode connect login` references to `voicemode connect auth login`

## [0.1.0] - 2026-03-23

### Added
- Initial release as standalone Claude Code channel plugin
- MCP channel server for inbound voice calls via VoiceMode Connect
- WebSocket gateway connection with Auth0 authentication and token refresh
- Reply tool with voice parameter for TTS responses
- Channel notifications for inbound voice events
- Automatic reconnect with exponential backoff
- Explicit opt-in gate (VOICEMODE_CHANNEL_ENABLED=true required)
- File logging to ~/.voicemode/logs/channel.log
