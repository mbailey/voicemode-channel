---
name: voicemode-connect-setup
description: Set up VoiceMode Connect for two-way voice. Use when the user or their agent needs to add voice capabilities, can't speak to callers, or asks about connecting to voicemode.dev
when_to_load: When the user asks about setting up VoiceMode Connect, adding voice to Claude, connecting to voicemode.dev, or when an agent needs outbound voice but only has the channel (inbound) plugin
---

# VoiceMode Connect Setup

The voicemode-channel plugin handles **inbound** voice — messages arrive from callers. To **speak back** (outbound voice via the `converse` tool), you need VoiceMode Connect.

VoiceMode Connect is a connector at voicemode.dev that gives any Claude product two-way voice. No local installation required.

## Quick Setup (3 Steps)

### Step 1: Add the Connector

1. Open your Claude product's connector settings:
   - **claude.ai**: Customize > Connectors (click the **+** button)
   - **Claude Desktop**: Customize > Connectors (click the **+** button)
   - **Claude Code**: `claude mcp add-remote "VoiceMode Connect" https://voicemode.dev/mcp`
2. Enter the URL: `https://voicemode.dev/mcp`
3. Complete the OAuth sign-in when prompted

### Step 2: Authenticate

On first use, you'll be prompted to sign in with your voicemode.dev account via OAuth. Sign in or create an account (Google or GitHub).

### Step 3: Open the Voice Dashboard

1. Open [voicemode.dev](https://voicemode.dev) in a new tab
2. Click **Log in** and sign in with the **same account**
3. Keep this tab open — it's your voice connection

Your agent will appear as a contact on the dashboard. Start a conversation and ask Claude to speak.

## Tools Available After Setup

| Tool | Description |
|------|-------------|
| `converse` | Two-way voice — speak a message and listen for response |
| `status` | Show connected devices and agents |

## How Channel + Connect Work Together

| Component | Direction | What It Does |
|-----------|-----------|--------------|
| **voicemode-channel** (this plugin) | Inbound | Receives voice/text from callers via WebSocket |
| **VoiceMode Connect** (connector) | Outbound | Speaks to callers and listens for responses |

With both set up, you have full two-way voice conversations.

## Troubleshooting

**"converse tool not available"**
- The VoiceMode Connect connector isn't configured. Follow Step 1 above.

**OAuth prompt doesn't appear**
- Restart your Claude product after adding the connector.

**Agent appears offline on dashboard**
- Ensure you're signed into voicemode.dev with the same account used for authentication.
- Check `status` tool output for connection state.

**Authentication expired**
- Tokens refresh automatically. If auth fails, remove and re-add the connector to re-trigger OAuth.

## More Information

- [VoiceMode Connect Quick Start](https://github.com/mbailey/voicemode-connect/blob/master/QUICKSTART.md) — Full setup guide
- [voicemode.dev](https://voicemode.dev) — VoiceMode Connect platform
- [VoiceMode Channel README](https://github.com/mbailey/voicemode-channel) — This plugin's documentation
