# Changelog

All notable changes to the VoiceMode Channel plugin will be documented in this file.

## [Unreleased]

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
