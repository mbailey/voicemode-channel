/**
 * Shared credential management for VoiceMode Connect.
 *
 * Auth0 constants, credential file I/O, and token refresh logic
 * used by both the gateway client and the auth login flow.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Auth0 configuration
// ---------------------------------------------------------------------------

export const AUTH0_DOMAIN = 'dev-2q681p5hobd1dtmm.us.auth0.com'
export const AUTH0_CLIENT_ID = '1uJR1Q4HMkLkhzOXTg5JFuqBCq0FBsXK'

// ---------------------------------------------------------------------------
// Credential storage
// ---------------------------------------------------------------------------

export const CREDENTIALS_FILE = join(homedir(), '.voicemode', 'credentials')
const TOKEN_EXPIRY_BUFFER_SECONDS = 60

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StoredCredentials {
  access_token: string
  refresh_token: string | null
  expires_at: number
  token_type: string
  user_info?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Credential helpers
// ---------------------------------------------------------------------------

export function load_credentials(): StoredCredentials | null {
  try {
    const raw = readFileSync(CREDENTIALS_FILE, 'utf-8')
    const data = JSON.parse(raw) as StoredCredentials
    if (!data.access_token) return null
    return data
  } catch {
    return null
  }
}

export function save_credentials(creds: StoredCredentials): void {
  try {
    const dir = join(homedir(), '.voicemode')
    mkdirSync(dir, { recursive: true })
    writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 })
  } catch {
    // Best effort -- if we can't save, we continue with the in-memory token
  }
}

export function is_expired(creds: StoredCredentials): boolean {
  return Date.now() / 1000 >= (creds.expires_at - TOKEN_EXPIRY_BUFFER_SECONDS)
}

export async function refresh_access_token(refresh_token: string): Promise<StoredCredentials | null> {
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
export async function get_valid_token(log: (msg: string) => void): Promise<string | null> {
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
