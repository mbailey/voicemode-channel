/**
 * WebSocket gateway client for VoiceMode Connect.
 *
 * Connects to the voicemode.dev WebSocket gateway, authenticates with Auth0
 * tokens, and maintains a persistent connection with auto-reconnect.
 *
 * This module handles:
 * - Reading Auth0 credentials from ~/.voicemode/credentials
 * - Refreshing expired access tokens via Auth0's /oauth/token endpoint
 * - Establishing and maintaining the WebSocket connection
 * - Sending auth, ready, and heartbeat messages per the protocol
 * - Exponential backoff on reconnect
 * - Clean shutdown on SIGTERM/SIGINT
 */

import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { hostname } from 'node:os'
import { join, basename } from 'node:path'
import { EventEmitter } from 'node:events'

// ---------------------------------------------------------------------------
// Profile data type (shared with index.ts)
// ---------------------------------------------------------------------------

export interface ProfileData {
  name: string
  display_name: string
  context: string | null
  voice: string | null
  presence: string
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const WS_URL = process.env.VOICEMODE_CONNECT_WS_URL ?? 'wss://voicemode.dev/ws'
const AUTH0_DOMAIN = 'dev-2q681p5hobd1dtmm.us.auth0.com'
const AUTH0_CLIENT_ID = '1uJR1Q4HMkLkhzOXTg5JFuqBCq0FBsXK'
const CREDENTIALS_FILE = join(homedir(), '.voicemode', 'credentials')
const TOKEN_EXPIRY_BUFFER_SECONDS = 60

const HEARTBEAT_INTERVAL_MS = 25_000
const HEARTBEAT_LIVENESS_TIMEOUT_MS = 60_000 // Force-close if no pong received within this window
const INITIAL_RETRY_DELAY_MS = 1_000
const MAX_RETRY_DELAY_MS = 60_000
const MAX_PAYLOAD_BYTES = 1_048_576 // 1 MB -- reject oversized messages to prevent memory exhaustion

// ---------------------------------------------------------------------------
// Project context helpers
// ---------------------------------------------------------------------------

/**
 * Derive project context from the working directory.
 * Returns the git remote origin basename (e.g., "voicemode-connect") or
 * the directory name as fallback. Returns null if detection fails.
 */
export function get_project_context(cwd: string): string | null {
  try {
    // Try git remote origin URL first (most specific)
    const remote_url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
    if (remote_url) {
      // Extract repo name from URL: https://github.com/user/repo.git -> repo
      const repo_name = basename(remote_url).replace(/\.git$/, '')
      if (repo_name) return repo_name
    }
  } catch {
    // Not a git repo or no remote -- fall through
  }

  // Fallback to directory name
  return basename(cwd) || null
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StoredCredentials {
  access_token: string
  refresh_token: string | null
  expires_at: number
  token_type: string
  user_info?: Record<string, unknown>
}

export type GatewayState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

// ---------------------------------------------------------------------------
// Credential helpers
// ---------------------------------------------------------------------------

function load_credentials(): StoredCredentials | null {
  try {
    const raw = readFileSync(CREDENTIALS_FILE, 'utf-8')
    const data = JSON.parse(raw) as StoredCredentials
    if (!data.access_token) return null
    return data
  } catch {
    return null
  }
}

function save_credentials(creds: StoredCredentials): void {
  try {
    const dir = join(homedir(), '.voicemode')
    mkdirSync(dir, { recursive: true })
    writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 })
  } catch {
    // Best effort -- if we can't save, we continue with the in-memory token
  }
}

function is_expired(creds: StoredCredentials): boolean {
  return Date.now() / 1000 >= (creds.expires_at - TOKEN_EXPIRY_BUFFER_SECONDS)
}

async function refresh_access_token(refresh_token: string): Promise<StoredCredentials | null> {
  const token_url = `https://${AUTH0_DOMAIN}/oauth/token`
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: AUTH0_CLIENT_ID,
    refresh_token,
  })

  try {
    const response = await fetch(token_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })

    if (!response.ok) {
      return null
    }

    const data = (await response.json()) as Record<string, unknown>
    const expires_in = (data.expires_in as number) ?? 3600
    const new_creds: StoredCredentials = {
      access_token: data.access_token as string,
      refresh_token: (data.refresh_token as string) ?? refresh_token,
      expires_at: Date.now() / 1000 + expires_in,
      token_type: (data.token_type as string) ?? 'Bearer',
    }
    return new_creds
  } catch {
    return null
  }
}

/**
 * Get a valid (non-expired) access token, refreshing if necessary.
 * Returns the access token string, or null if no valid token is available.
 */
async function get_valid_token(log: (msg: string) => void): Promise<string | null> {
  const creds = load_credentials()
  if (!creds) {
    log('No credentials found at ~/.voicemode/credentials')
    log('Run: voicemode connect auth login')
    return null
  }

  if (!is_expired(creds)) {
    return creds.access_token
  }

  log('Access token expired, attempting refresh...')

  if (!creds.refresh_token) {
    log('No refresh token available -- please re-login')
    log('Run: voicemode connect auth login')
    return null
  }

  const refreshed = await refresh_access_token(creds.refresh_token)
  if (!refreshed) {
    log('Token refresh failed -- please re-login')
    log('Run: voicemode connect auth login')
    return null
  }

  // Preserve user_info from original credentials
  refreshed.user_info = creds.user_info
  save_credentials(refreshed)
  log('Token refreshed successfully')
  return refreshed.access_token
}

// ---------------------------------------------------------------------------
// Gateway client
// ---------------------------------------------------------------------------

/**
 * WebSocket gateway client.
 *
 * Emits:
 * - 'connected' -- WebSocket authenticated and ready
 * - 'disconnected' -- WebSocket closed
 * - 'message' -- server message received (parsed JSON object)
 * - 'state' -- state changed (GatewayState)
 */
export class GatewayClient extends EventEmitter {
  private _ws: WebSocket | null = null
  private _state: GatewayState = 'disconnected'
  private _session_id: string | null = null
  private readonly _agent_session_id: string = process.env.CLAUDE_SESSION_ID ?? randomUUID()
  private _heartbeat_timer: ReturnType<typeof setInterval> | null = null
  private _last_pong_at = 0
  private _retry_delay_ms = INITIAL_RETRY_DELAY_MS
  private _reconnect_count = 0
  private _shutting_down = false
  private _running = false
  private _sleep_resolve: (() => void) | null = null
  private _sleep_timer: ReturnType<typeof setTimeout> | null = null
  private _log: (msg: string) => void
  private _profile: ProfileData | undefined

  constructor(log_fn: (msg: string) => void) {
    super()
    this._log = log_fn
  }

  get state(): GatewayState {
    return this._state
  }

  get session_id(): string | null {
    return this._session_id
  }

  get agent_session_id(): string {
    return this._agent_session_id
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Start the connection loop. Resolves immediately (connection is async).
   * The client will automatically reconnect on disconnect.
   */
  async start(): Promise<void> {
    if (this._shutting_down) return
    if (this._running) return
    this._running = true
    this._set_state('connecting')
    this._connection_loop()
  }

  /**
   * Send a JSON-serialisable message through the gateway WebSocket.
   * Returns true if the message was sent, false if the connection is not open.
   */
  send_message(msg: Record<string, unknown>): boolean {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      this._log('Cannot send message: WebSocket is not open')
      return false
    }
    this._ws.send(JSON.stringify(msg))
    return true
  }

  /**
   * Send a capabilities_update with the given profile data.
   * Called by the channel server when the profile tool updates fields.
   * Stores the profile so reconnects use the latest values.
   */
  send_capabilities_update(profile: ProfileData): void {
    this._profile = profile
    this._send_capabilities_update(profile)
  }

  /**
   * Cleanly shut down the WebSocket connection.
   */
  async shutdown(): Promise<void> {
    this._shutting_down = true
    this._cancel_sleep()
    this._stop_heartbeat()
    if (this._ws) {
      try {
        this._ws.close(1000, 'shutting down')
      } catch {
        // Ignore close errors during shutdown
      }
      this._ws = null
    }
    this._set_state('disconnected')
    this._log('Gateway client shut down')
  }

  // -----------------------------------------------------------------------
  // Connection loop
  // -----------------------------------------------------------------------

  private async _connection_loop(): Promise<void> {
    try {
      while (!this._shutting_down) {
        try {
          await this._connect_once()
        } catch {
          // Error handled inside _connect_once
        }

        if (this._shutting_down) break

        // Reconnect with exponential backoff
        this._reconnect_count++
        this._set_state('reconnecting')
        this._log(`Reconnecting in ${this._retry_delay_ms / 1000}s (attempt ${this._reconnect_count})...`)
        await this._sleep(this._retry_delay_ms)
        this._retry_delay_ms = Math.min(this._retry_delay_ms * 2, MAX_RETRY_DELAY_MS)
      }
    } finally {
      this._running = false
    }
  }

  private async _connect_once(): Promise<void> {
    this._set_state('connecting')

    // Get a valid access token (refreshing if necessary)
    const token = await get_valid_token(this._log)
    if (!token) {
      this._log('Cannot connect: no valid access token')
      return
    }

    this._log(`Connecting to ${WS_URL}...`)

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(WS_URL, {
        headers: { Authorization: `Bearer ${token}` },
        maxPayload: MAX_PAYLOAD_BYTES,
      })

      let authenticated = false

      ws.on('open', () => {
        this._ws = ws
        this._log('WebSocket connection opened')
      })

      ws.on('message', (data: WebSocket.Data) => {
        const raw = data.toString()

        // Ignore auto-response pong messages -- record timestamp for liveness detection
        if (raw === 'pong') {
          this._last_pong_at = Date.now()
          return
        }

        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(raw) as Record<string, unknown>
        } catch {
          this._log(`Invalid JSON from gateway: ${raw.slice(0, 100)}`)
          return
        }

        const msg_type = msg.type as string

        if (msg_type === 'connected' && !authenticated) {
          authenticated = true
          this._session_id = ((msg.sessionId as string) ?? '').slice(0, 12)
          this._log(`Authenticated (session: ${this._session_id})`)

          // Send ready message; capabilities_update is sent by the
          // channel server via the 'connected' event handler.
          this._send_ready()

          // Start heartbeat
          this._start_heartbeat()

          // Reset backoff on successful connection
          this._retry_delay_ms = INITIAL_RETRY_DELAY_MS
          this._reconnect_count = 0

          this._set_state('connected')
          this.emit('connected')
        } else if (msg_type === 'heartbeat_ack' || msg_type === 'heartbeat') {
          this._last_pong_at = Date.now()
        } else if (msg_type === 'error') {
          const error_msg = (msg.message as string) ?? 'Unknown error'
          const error_code = (msg.code as string) ?? ''
          this._log(`Server error: ${error_msg} (${error_code})`)
        } else if (msg_type === 'ack') {
          // Silently handle ack messages
        } else {
          // Emit all other messages for higher-level handling
          this.emit('message', msg)
        }
      })

      ws.on('error', (err: Error) => {
        this._log(`WebSocket error: ${err.message}`)
      })

      ws.on('close', (code: number, reason: Buffer) => {
        this._stop_heartbeat()
        this._ws = null
        const reason_str = reason.toString() || 'no reason'
        this._log(`WebSocket closed: code=${code} reason="${reason_str}"`)
        this._set_state('disconnected')
        this.emit('disconnected')
        resolve()
      })
    })
  }

  // -----------------------------------------------------------------------
  // Protocol messages
  // -----------------------------------------------------------------------

  private _send_ready(): void {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return

    const ready_msg = {
      type: 'ready',
      device: {
        platform: 'channel-server',
        appVersion: '0.1.4',
        name: `channel@${hostname()}`,
      },
    }

    this._ws.send(JSON.stringify(ready_msg))
    this._log('Sent ready message')
  }

  /**
   * Send capabilities_update to register as a callable agent.
   * This is how the gateway knows this connection can receive voice messages.
   * Without this, the connection won't show up in the users/contacts list.
   *
   * Accepts profile data from the channel server so that profile tool updates
   * are reflected immediately without restarting.
   */
  private _send_capabilities_update(profile?: ProfileData): void {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return

    const agent_name = profile?.name ?? process.env.VOICEMODE_AGENT_NAME ?? 'voicemode'
    const display_name = profile?.display_name ?? process.env.VOICEMODE_AGENT_DISPLAY_NAME ?? 'Claude Code'
    const presence = profile?.presence ?? 'available'
    const host = hostname()
    const project_path = process.cwd()
    const context = profile?.context ?? get_project_context(project_path)

    const user_entry: Record<string, unknown> = {
      name: agent_name,
      host,
      display_name,
      presence,
    }
    if (context) {
      user_entry.context = context
    }
    if (profile?.voice) {
      user_entry.voice = profile.voice
    }

    const capabilities_msg = {
      type: 'capabilities_update',
      platform: 'claude-code',
      session_id: this._agent_session_id,
      users: [user_entry],
    }

    this._ws.send(JSON.stringify(capabilities_msg))
    this._log(`Sent capabilities_update: session="${this._agent_session_id}" agent="${agent_name}" display="${display_name}" host="${host}" context="${context ?? project_path}" presence="${presence}"`)
  }

  private _start_heartbeat(): void {
    this._stop_heartbeat()
    this._last_pong_at = Date.now()
    this._heartbeat_timer = setInterval(() => {
      if (this._ws && this._ws.readyState === WebSocket.OPEN) {
        // Check liveness -- if no pong received within timeout, force-close (half-open TCP)
        const silent_ms = Date.now() - this._last_pong_at
        if (silent_ms > HEARTBEAT_LIVENESS_TIMEOUT_MS) {
          this._log(`No heartbeat response in ${Math.round(silent_ms / 1000)}s -- force-closing (half-open TCP suspected)`)
          this._ws.terminate()
          return
        }
        // Send literal "ping" text -- auto-responded by DO runtime without waking it
        this._ws.send('ping')
      }
    }, HEARTBEAT_INTERVAL_MS)
  }

  private _stop_heartbeat(): void {
    if (this._heartbeat_timer) {
      clearInterval(this._heartbeat_timer)
      this._heartbeat_timer = null
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private _set_state(state: GatewayState): void {
    if (this._state === state) return
    this._state = state
    this.emit('state', state)
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this._sleep_resolve = resolve
      this._sleep_timer = setTimeout(() => {
        this._sleep_resolve = null
        this._sleep_timer = null
        resolve()
      }, ms)
    })
  }

  private _cancel_sleep(): void {
    if (this._sleep_timer !== null) {
      clearTimeout(this._sleep_timer)
      this._sleep_timer = null
    }
    if (this._sleep_resolve !== null) {
      const resolve = this._sleep_resolve
      this._sleep_resolve = null
      resolve()
    }
  }
}
