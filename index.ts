#!/usr/bin/env node
/**
 * VoiceMode Channel Server
 *
 * A minimal MCP channel server that pushes inbound voice events into a
 * Claude Code session. Declares the experimental claude/channel capability
 * and sends notifications/claude/channel notifications.
 *
 * Connects to VoiceMode Connect gateway via WebSocket (authenticated).
 * No local HTTP server -- all events come through the gateway.
 *
 * Usage:
 *   VOICEMODE_CHANNEL_ENABLED=true claude --dangerously-load-development-channels server:voicemode-channel
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { appendFileSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { GatewayClient, get_project_context } from './gateway.js'
import type { ProfileData } from './gateway.js'
import { login } from './auth.js'
import { load_credentials, is_expired, CREDENTIALS_FILE, get_valid_token } from './credentials.js'

// ---------------------------------------------------------------------------
// Load ~/.voicemode/voicemode.env (simple dotenv parsing)
// Env vars already set in the process take precedence.
// ---------------------------------------------------------------------------
try {
  const env_path = join(homedir(), '.voicemode', 'voicemode.env')
  const env_content = readFileSync(env_path, 'utf8')
  for (const line of env_content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 1) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    // Don't override existing env vars
    if (!(key in process.env)) {
      process.env[key] = value
    }
  }
} catch {
  // voicemode.env not found -- that's fine, use env vars only
}

// ---------------------------------------------------------------------------
// CLI subcommand routing
// Auth subcommands run standalone -- no MCP server, no VOICEMODE_CHANNEL_ENABLED gate.
// ---------------------------------------------------------------------------

const cli_args = process.argv.slice(2)

if (cli_args[0] === 'auth') {
  const stderr_log = (msg: string) => process.stderr.write(`${msg}\n`)

  switch (cli_args[1]) {
    case 'login':
      try {
        await login(stderr_log)
        console.log('Login successful.')
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`Login failed: ${message}`)
        process.exit(1)
      }
      process.exit(0)
      break

    case 'logout':
      try {
        unlinkSync(CREDENTIALS_FILE)
        console.log('Credentials removed.')
      } catch {
        console.log('No credentials to remove.')
      }
      process.exit(0)
      break

    case 'status': {
      const creds = load_credentials()
      if (!creds) {
        console.log('Not logged in.')
        console.log('Run: voicemode-channel auth login')
        process.exit(1)
      }

      const expired = is_expired(creds)
      const expires_date = new Date(creds.expires_at * 1000)

      console.log('Logged in.')
      console.log(`  Token type:  ${creds.token_type}`)
      console.log(`  Expires at:  ${expires_date.toLocaleString()}`)
      console.log(`  Status:      ${expired ? 'EXPIRED' : 'valid'}`)
      console.log(`  Refresh:     ${creds.refresh_token ? 'available' : 'none'}`)

      if (creds.user_info) {
        const ui = creds.user_info
        if (ui.name) console.log(`  Name:        ${ui.name}`)
        if (ui.email) console.log(`  Email:       ${ui.email}`)
      }

      process.exit(0)
      break
    }

    default:
      console.error(`Unknown auth subcommand: ${cli_args[1] ?? '(none)'}`)
      console.error('Usage: voicemode-channel auth [login|logout|status]')
      process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Explicit opt-in gate -- channel server must NOT connect to external services
// unless the user has deliberately enabled it. This prevents surprise outbound
// WebSocket connections when someone loads dev channels for other reasons.
// ---------------------------------------------------------------------------
if (process.env.VOICEMODE_CHANNEL_ENABLED !== 'true') {
  process.stderr.write(
    'VoiceMode channel server disabled. Set VOICEMODE_CHANNEL_ENABLED=true to enable.\n'
  )
  process.exit(0)
}

const CHANNEL_NAME = 'voicemode-channel'
const CHANNEL_VERSION = '0.1.4'

const INSTRUCTIONS = [
  'Events from VoiceMode appear as <channel source="voicemode-channel" caller="NAME">TRANSCRIPT</channel>.',
  'These are inbound voice messages from a user speaking on their phone or web app.',
  'Respond using the voicemode-channel reply tool (NOT the converse tool from a different server).',
  'The reply tool sends your response back through the same channel connection,',
  'keeping the conversation in the same thread on the user\'s device.',
  'Address the caller by name.',
  'Keep responses concise -- the user is listening via text-to-speech.',
].join(' ')

// ---------------------------------------------------------------------------
// Agent profile state (mutable via the profile tool)
// ---------------------------------------------------------------------------

let currentProfile: ProfileData = {
  name: process.env.VOICEMODE_AGENT_NAME ?? 'voicemode',
  display_name: process.env.VOICEMODE_AGENT_DISPLAY_NAME ?? 'Claude Code',
  context: get_project_context(process.cwd()),
  voice: null,
  presence: 'available',
}

// ---------------------------------------------------------------------------
// MCP server with channel capability
// ---------------------------------------------------------------------------

const mcp = new Server(
  { name: CHANNEL_NAME, version: CHANNEL_VERSION },
  {
    capabilities: {
      tools: {},
      experimental: { 'claude/channel': {} },
    },
    instructions: INSTRUCTIONS,
  },
)

// ---------------------------------------------------------------------------
// Generate unique message IDs
// ---------------------------------------------------------------------------

function generate_message_id(): string {
  return `msg-${Date.now()}-${randomBytes(6).toString('hex')}`
}

// ---------------------------------------------------------------------------
// MCP tool handlers (reply tool)
// ---------------------------------------------------------------------------

mcp.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'reply',
        description:
          'Send a voice reply to the user through VoiceMode. ' +
          'Use this to respond to inbound voice channel events. ' +
          'The reply is spoken aloud on the user\'s device via TTS.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            text: {
              type: 'string',
              description: 'The message to speak to the user',
            },
            voice: {
              type: 'string',
              description: 'TTS voice name (optional, uses device default if omitted)',
            },
            wait_for_response: {
              type: 'boolean',
              description: 'Whether to listen for user response after speaking (default: false)',
            },
          },
          required: ['text'],
        },
      },
      {
        name: 'profile',
        description:
          'Get or update the agent profile. ' +
          'Call with no arguments to read the current profile. ' +
          'Call with fields to update them and push a capabilities_update to the gateway.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            name: {
              type: 'string',
              description: 'Agent identity (e.g. "cora")',
            },
            display_name: {
              type: 'string',
              description: 'Human-readable name (e.g. "Cora 7")',
            },
            context: {
              type: 'string',
              description: 'What the agent is working on (e.g. "voicemode-connect", "VMC-298")',
            },
            voice: {
              type: 'string',
              description: 'Preferred TTS voice',
            },
            presence: {
              type: 'string',
              description: 'Agent presence status',
              enum: ['available', 'busy', 'away'],
            },
          },
        },
      },
    ],
  }
})

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  if (name === 'profile') {
    return handle_profile_tool(args as Record<string, unknown> | undefined)
  }

  if (name === 'reply') {
    return handle_reply_tool(args as Record<string, unknown> | undefined)
  }

  return {
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    isError: true,
  }
})

// ---------------------------------------------------------------------------
// Tool handler: reply
// ---------------------------------------------------------------------------

function handle_reply_tool(args: Record<string, unknown> | undefined) {
  // Validate arguments
  const text = args?.text
  if (typeof text !== 'string' || text.trim().length === 0) {
    return {
      content: [{ type: 'text', text: 'Error: text parameter is required and must be non-empty' }],
      isError: true,
    }
  }

  const voice = typeof args?.voice === 'string' ? args.voice : (currentProfile.voice || undefined)
  const wait_for_response = typeof args?.wait_for_response === 'boolean' ? args.wait_for_response : undefined

  // Check gateway connection
  if (!gateway || gateway.state !== 'connected') {
    return {
      content: [{ type: 'text', text: 'Error: Not connected to VoiceMode gateway. Waiting for reconnect.' }],
      isError: true,
    }
  }

  // Build speak message and send through gateway WebSocket
  const msg_id = generate_message_id()
  const speak_msg: Record<string, unknown> = {
    type: 'speak',
    id: msg_id,
    text: text.trim(),
    timestamp: Date.now(),
  }
  if (voice) speak_msg.voice = voice
  if (wait_for_response) speak_msg.waitForResponse = true

  const sent = gateway.send_message(speak_msg)
  if (!sent) {
    return {
      content: [{ type: 'text', text: 'Error: Failed to send speak message -- WebSocket not open' }],
      isError: true,
    }
  }

  log(`Sent reply via gateway: id=${msg_id} text="${truncate(text.trim(), 80)}"`)

  return {
    content: [{
      type: 'text',
      text: `Reply sent (id: ${msg_id}). Text: "${truncate(text.trim(), 120)}"`,
    }],
  }
}

// ---------------------------------------------------------------------------
// Tool handler: profile
// ---------------------------------------------------------------------------

function handle_profile_tool(args: Record<string, unknown> | undefined) {
  // No args (or empty object) -- return current profile
  const has_updates = args && Object.keys(args).length > 0
  if (!has_updates) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(currentProfile, null, 2),
      }],
    }
  }

  // Merge provided fields into current profile
  if (typeof args.name === 'string') currentProfile.name = args.name
  if (typeof args.display_name === 'string') currentProfile.display_name = args.display_name
  if (typeof args.context === 'string') currentProfile.context = args.context
  if (typeof args.voice === 'string') currentProfile.voice = args.voice
  if (args.presence === 'available' || args.presence === 'busy' || args.presence === 'away') currentProfile.presence = args.presence

  log(`Profile updated: ${JSON.stringify(currentProfile)}`)

  // Push capabilities update to the gateway if connected
  if (gateway && gateway.state === 'connected') {
    gateway.send_capabilities_update(currentProfile)
    log('Pushed capabilities_update after profile change')
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(currentProfile, null, 2),
    }],
  }
}

// ---------------------------------------------------------------------------
// Push a channel notification for an inbound voice event
// ---------------------------------------------------------------------------

const EXTERNAL_MESSAGE_PREFIX = '[VoiceMode Connect - External Message]: '

async function push_voice_event(
  caller: string,
  transcript: string,
  device_id?: string,
): Promise<void> {
  const meta: Record<string, string> = { caller }
  if (device_id) {
    meta.device_id = device_id
  }

  await mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: `${EXTERNAL_MESSAGE_PREFIX}${transcript}`,
      meta,
    },
  })

  log(`Pushed channel notification: caller=${caller} transcript="${truncate(transcript, 80)}"`)
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const LOG_DIR = join(homedir(), '.voicemode', 'logs')
const LOG_FILE = join(LOG_DIR, 'channel.log')
const DEBUG = process.env.VOICEMODE_CHANNEL_DEBUG === '1' || process.env.VOICEMODE_CHANNEL_DEBUG === 'true'

// Ensure log directory exists
try { mkdirSync(LOG_DIR, { recursive: true }) } catch { /* ignore */ }

function log(message: string, level: 'INFO' | 'DEBUG' | 'WARN' | 'ERROR' = 'INFO'): void {
  if (level === 'DEBUG' && !DEBUG) return
  const ts = new Date().toISOString()
  const line = `${ts} [${level}] [${CHANNEL_NAME}] ${message}\n`
  // Always write to stderr (Claude Code captures this)
  process.stderr.write(line)
  // Also write to log file for debugging
  try { appendFileSync(LOG_FILE, line) } catch { /* ignore */ }
}

function truncate(str: string, max_length: number): string {
  if (str.length <= max_length) return str
  return str.slice(0, max_length - 3) + '...'
}

// ---------------------------------------------------------------------------
// WebSocket gateway connection
// ---------------------------------------------------------------------------

let gateway: GatewayClient | null = null

function start_gateway(): void {
  gateway = new GatewayClient(log)

  gateway.on('connected', () => {
    log('Gateway connection established -- ready to receive voice events')
    // Push current profile to the gateway on every (re)connect so the
    // gateway always has the latest profile state.
    gateway!.send_capabilities_update(currentProfile)
  })

  gateway.on('disconnected', () => {
    log('Gateway connection lost')
  })

  gateway.on('state', (state: string) => {
    log(`Gateway state: ${state}`)
  })

  // Handle inbound messages from the gateway (voice event pipeline)
  gateway.on('message', (msg: Record<string, unknown>) => {
    if (msg.type !== 'user_message_delivery') {
      log(`Ignoring message type: ${String(msg.type)}`)
      return
    }

    const text = msg.text
    const from = msg.from
    const user_id = msg.userId

    // Validate required fields
    if (typeof text !== 'string' || text.trim().length === 0) {
      log('Dropping user_message_delivery: missing or empty text field')
      return
    }

    const MAX_TRANSCRIPT_LENGTH = 10000
    if (text.length > MAX_TRANSCRIPT_LENGTH) {
      log(`Truncating transcript from ${text.length} to ${MAX_TRANSCRIPT_LENGTH} chars`)
    }
    const safe_text = text.slice(0, MAX_TRANSCRIPT_LENGTH)

    // Caller identity: use "from" field if available, fall back to userId
    const caller = typeof from === 'string' && from.length > 0
      ? from
      : typeof user_id === 'string' && user_id.length > 0
        ? user_id
        : 'unknown'

    // device_id is not present on user_message_delivery -- use userId as a routing hint
    const device_id = typeof user_id === 'string' && user_id.length > 0
      ? user_id
      : undefined

    log(`Received voice event: from="${caller}" text="${truncate(safe_text.trim(), 80)}"`)

    push_voice_event(caller, safe_text.trim(), device_id).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      log(`Error pushing voice event to channel: ${message}`)
    })
  })

  // Start the connection (non-blocking -- reconnects in the background)
  gateway.start().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    log(`Gateway start error: ${message}`)
  })
}

// ---------------------------------------------------------------------------
// Clean shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal: string): Promise<void> {
  log(`Received ${signal}, shutting down...`)

  if (gateway) {
    await gateway.shutdown()
  }

  // Give a moment for cleanup, then exit
  setTimeout(() => process.exit(0), 500)
}

process.on('SIGTERM', () => { shutdown('SIGTERM') })
process.on('SIGINT', () => { shutdown('SIGINT') })

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log(`Starting ${CHANNEL_NAME} v${CHANNEL_VERSION}`)

  // Check credentials and auto-login if needed
  const token = await get_valid_token((msg: string) => log(msg))
  if (!token) {
    log('No valid credentials -- starting login flow...')
    try {
      await login((msg: string) => log(msg))
      log('Authentication complete')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      log(`Login failed: ${message}`, 'ERROR')
      process.exit(1)
    }
  }

  // Start MCP stdio transport (communicates with Claude Code)
  const transport = new StdioServerTransport()
  await mcp.connect(transport)
  log('MCP channel server connected via stdio')

  // Connect to the voicemode.dev WebSocket gateway
  start_gateway()
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(`Fatal: ${message}\n`)
  process.exit(1)
})
