# Changelog

All notable changes to the VoiceMode Channel plugin will be documented in this file.

## [Unreleased]

### Added
- **Built-in Auth0 PKCE login** -- native login flow, no Python voicemode dependency needed (VMC-448)
- **CLI auth subcommands** -- `voicemode-channel auth login/logout/status` for credential management
- **Auto-login on first start** -- opens browser if no credentials found
- **Headless login fallback** -- prints login URL to stderr when no browser available
- **Status MCP tool** -- query connection state, auth info, and agent profile (VMC-428)
- **npm standalone** -- `npx voicemode-channel` works without Claude Code plugin system (VMC-450)
- **Makefile** -- build, test, publish, run, inspect, shell, and audit targets
- **Dependabot** -- automated security updates for npm dependencies
- **mcptools shell support** -- interactive MCP shell via `make shell`
- **CLAUDE.md** -- project context for Claude Code

### Changed
- Extracted shared credentials module from gateway.ts (`credentials.ts`)
- Moved tsx from runtime to dev dependency
- Entry point shebang changed to `#!/usr/bin/env node`

### Fixed
- Include `project_path` in `capabilities_update` user entry (VMC-302)

## [0.1.6] - 2026-03-25

### Added
- **Profile voice as reply default** -- reply tool now uses the agent's profile voice when no voice parameter is specified, so agents keep their configured voice identity

### Fixed
- **Security:** Replace `execSync` with `execFileSync` in `get_project_context` -- eliminates shell injection surface
- **Security:** Add WebSocket `maxPayload` limit (1 MB) -- prevents memory exhaustion from oversized payloads
- **Security:** Add transcript length limit and remove `project_path` from `capabilities_update`
- **Reliability:** Heartbeat liveness detection -- force-close WebSocket after 60s silence, triggers reconnect
- **Reliability:** Guard against concurrent `start()` calls; cancellable backoff sleep for prompt shutdown

### Changed
- Tighten TypeScript types and update `.gitignore`
- Plugin packaging robustness and documentation fixes

## [0.1.5] - 2026-03-25

### Fixed
- **Pre-flight checks in start.sh** -- validates Node.js version, npm packages, and required env vars before starting, with clear error messages

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
