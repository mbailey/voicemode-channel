# voicemode-channel

Claude Code channel plugin -- inbound voice calls via VoiceMode Connect.

## Task Prefix

Use **VMCH** for tasks in this repo (e.g., VMCH-2, VMCH-10). VMC is for voicemode-connect.

## Build

```bash
make build          # Compile TypeScript to dist/
make test           # Build, pack, install from tarball, verify
make audit          # npm security audit
make publish        # Audit + build + npm publish
make shell          # Interactive mcptools shell (brew install mcptools)
make inspect        # MCP Inspector web UI
```

## Related Projects

When working on VMC-426 (receiver fixes) or other voicemode-connect tasks:

- **voicemode-connect** repo: Use `npm run typecheck` for type checking, NOT `npx tsc`. The project has a custom TypeScript setup and `npx tsc` pulls in the wrong compiler.

## Auth

- Auth0 domain: dev-2q681p5hobd1dtmm.us.auth0.com
- Client ID: 1uJR1Q4HMkLkhzOXTg5JFuqBCq0FBsXK (public native app)
- Credential file: ~/.voicemode/credentials (JSON, shared with Python CLI)

## Git

- Never commit to master -- always create a branch first
- Standard workflow: branch → commit → push → PR
