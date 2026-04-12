---
name: voicemode-channel
description: VoiceMode Connect channel -- receive and respond to voice/text messages from users on their phone or web app
when_to_load: When a VoiceMode Connect channel message arrives, or when the user asks about the VoiceMode channel, Connect messaging, or inbound voice calls
---

# VoiceMode Channel

Bridges VoiceMode Connect to Claude Code agents. Users speak or type on their phone/web app, messages arrive here as channel notifications.

## Responding to Messages

**Prefer the VoiceMode Connect converse tool** (`mcp__claude_ai_VoiceMode_Connect__converse`) for voice conversations. It speaks your message AND listens for the user's reply in one call -- a full conversational turn.

Use the channel `reply` tool only when:
- The VoiceMode Connect converse tool is not available
- You need a one-way notification (no response expected)
- You're on a platform that doesn't support the converse MCP tool

## Message Format

Inbound messages arrive as:
```
<channel source="voicemode-channel" caller="NAME">TRANSCRIPT</channel>
```

These are from a real person speaking or typing on their device. Address them by name. Keep responses concise -- the user is listening via text-to-speech.

## Tools

| Tool | Purpose |
|------|---------|
| `reply` | One-way voice reply (spoken via TTS on user's device) |
| `status` | Check channel connection state and profile |
| `profile` | Get or update agent identity (name, display name, voice, presence) |
| `list_messages` | List recent inbound messages (Maildir) |
| `read_message` | Read a specific message by ID |
| `mark_read` | Mark messages as read/replied |

## Key Facts

- Messages queue when the agent is busy (delivered between turns)
- The channel maintains a Maildir for message history
- Profile changes (name, voice, presence) are broadcast to connected users
- The agent appears as a "contact" on the user's dashboard
