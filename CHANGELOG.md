# Changelog

All notable changes to the VoiceMode Channel plugin will be documented in this file.

## [Unreleased]

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
