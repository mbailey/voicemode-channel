# Changelog

All notable changes to the VoiceMode Channel plugin will be documented in this file.

## [Unreleased]

### Added

- **Maildir persistence** -- inbound voice messages and outbound replies are now written to `~/.voicemode/maildir/channel/` in standard Maildir format, so conversation history survives across agent sessions (VMC-452)
- **Conversation history MCP tools** -- `list_messages` to browse the Maildir inbox and `read_message` to read a message by filename (marks the message as read by default; pass `mark_read: false` to opt out) (VMC-452, VMC-490)
- **Read/unread state tracking** -- messages move from `new/` to `cur/` when read, following the Maildir `:2,FLAGS` standard (S=Seen, R=Replied) that notmuch and neomutt read natively (VMC-490)
- **`mark_read` MCP tool** -- mark one or more messages read in bulk, with a custom flag set for marking replied, flagged, or other states (VMC-490)
- **Bulk body reads** -- `list_messages` takes `include_body` (default false) and `body_max_length` (default 2000, 0 = unlimited) with a clear truncation marker, so agents can fetch many messages in one call (VMC-490)
- **Unread filter** -- `list_messages` accepts `unread` (true/false/undefined) to filter by read state (VMC-490)
- **Unread count in status** -- the `status` tool reports the number of unread messages, supporting notification-append patterns (VMC-490)
- **R-flag on reply** -- the `reply` tool accepts an optional `in_reply_to` filename and stamps the source message with the Replied flag (VMC-490)
- **Persistence configuration** -- `VOICEMODE_MAILDIR_PATH` and `VOICEMODE_MAILDIR_ENABLED` environment variables control the Maildir location and whether persistence is active

### Security

- Filename path-traversal protection on all Maildir operations (rejects `..` and `/` in filenames; resolves paths within the Maildir root)
- Content-hash deduplication prevents duplicate writes for identical messages

## [0.2.1] - 2026-04-04

### Fixed

- Version display now reads from package.json instead of hardcoded string
- Removed dead `createConnection` import from auth.ts

## [0.2.0] - 2026-04-04

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
- Plugin MCP server now uses `npx voicemode-channel` instead of `start.sh` + tsx
- Track `package-lock.json` for reproducible installs

### Fixed

- Include `project_path` in `capabilities_update` user entry (VMC-302)

### Security

- **Fix reflected XSS** in OAuth callback page -- HTML-escape `error_description` parameter
- **Tighten directory permissions** -- `~/.voicemode/` created with mode 0700 (was 0755)
- **Restrict env parser** -- `voicemode.env` only accepts `VOICEMODE_` prefixed keys
- **Eliminate TOCTOU race** -- callback port binding uses single server with handler (no check-then-listen)
- **Reduce path leakage** -- send `basename(cwd)` instead of full filesystem path to gateway
- **Warn on non-TLS** -- log warning when gateway URL uses unencrypted `ws://` scheme
- **Cap profile strings** -- profile tool fields limited to 200 characters
- **Gate npm publish on audit** -- `make publish` runs `npm audit --audit-level=high` before build
- Security review grade: A (93%) across 4 review cycles

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
