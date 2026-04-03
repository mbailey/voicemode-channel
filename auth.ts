/**
 * OAuth PKCE login flow for VoiceMode Connect.
 *
 * Implements Auth0 PKCE authentication using only Node built-ins:
 * - crypto for PKCE code verifier/challenge
 * - http for localhost callback server
 * - child_process for opening browser
 *
 * Ported from voice_mode/auth.py in the Python CLI.
 */

import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { platform } from 'node:os'
import { createConnection } from 'node:net'

import {
  AUTH0_DOMAIN,
  AUTH0_CLIENT_ID,
  save_credentials,
  type StoredCredentials,
} from './credentials.js'

// ---------------------------------------------------------------------------
// Auth0 OAuth parameters (matching Python CLI)
// ---------------------------------------------------------------------------

const AUTH0_SCOPES = 'openid profile email offline_access'
const AUTH0_AUDIENCE = 'https://voicemode.dev/api'

// ---------------------------------------------------------------------------
// Callback server configuration
// ---------------------------------------------------------------------------

const CALLBACK_PORT_START = 8765
const CALLBACK_PORT_END = 8769
const CALLBACK_TIMEOUT_MS = 300_000 // 5 minutes

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

interface PKCEParams {
  code_verifier: string
  code_challenge: string
}

function generate_pkce_params(): PKCEParams {
  // 32 random bytes → base64url ≈ 43 characters
  const code_verifier = randomBytes(32)
    .toString('base64url')

  // SHA256 hash → base64url (no padding)
  const code_challenge = createHash('sha256')
    .update(code_verifier, 'ascii')
    .digest('base64url')

  return { code_verifier, code_challenge }
}

// ---------------------------------------------------------------------------
// Port selection
// ---------------------------------------------------------------------------

function is_port_available(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port })
    sock.once('connect', () => { sock.destroy(); resolve(false) })
    sock.once('error', () => { sock.destroy(); resolve(true) })
  })
}

async function find_available_port(): Promise<number | null> {
  for (let port = CALLBACK_PORT_START; port <= CALLBACK_PORT_END; port++) {
    if (await is_port_available(port)) return port
  }
  return null
}

// ---------------------------------------------------------------------------
// Callback HTML page
// ---------------------------------------------------------------------------

function callback_page(success: boolean, error_message = ''): string {
  const icon_bg = success ? '#3fb950' : '#f85149'
  const icon_svg = success
    ? '<path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" fill="#0d1117"/>'
    : '<path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" fill="#0d1117"/>'
  const heading = success ? 'Authentication Successful' : 'Authentication Failed'
  const message = success
    ? 'You can close this window and return to the terminal.'
    : (error_message ? `Error: ${error_message}` : 'Something went wrong.')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VoiceMode - ${heading}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0d1117; color: #e6edf3;
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh; padding: 24px;
  }
  .card {
    background: #161b22; border: 1px solid #30363d; border-radius: 12px;
    padding: 48px 40px; max-width: 420px; width: 100%; text-align: center;
  }
  .icon {
    display: inline-flex; align-items: center; justify-content: center;
    width: 48px; height: 48px; background: ${icon_bg}; border-radius: 50%; margin-bottom: 20px;
  }
  h1 { font-size: 20px; font-weight: 600; margin-bottom: 8px; color: #e6edf3; }
  p { font-size: 14px; color: #8b949e; line-height: 1.5; }
</style>
</head>
<body>
  <div class="card">
    <div><div class="icon">
      <svg width="24" height="24" viewBox="0 0 24 24">${icon_svg}</svg>
    </div></div>
    <h1>${heading}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Browser opening
// ---------------------------------------------------------------------------

function open_browser(url: string): boolean {
  const plat = platform()
  let cmd: string
  let args: string[]

  if (plat === 'darwin') {
    cmd = 'open'
    args = [url]
  } else if (plat === 'linux') {
    cmd = 'xdg-open'
    args = [url]
  } else {
    // Windows fallback (unlikely for this project)
    cmd = 'cmd'
    args = ['/c', 'start', '', url]
  }

  try {
    execFile(cmd, args, (err) => {
      if (err) {
        // Browser open failed -- headless fallback already handled by caller
      }
    })
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Auth0 API calls
// ---------------------------------------------------------------------------

async function exchange_code_for_tokens(
  code: string,
  code_verifier: string,
  redirect_uri: string,
): Promise<Record<string, unknown>> {
  const token_url = `https://${AUTH0_DOMAIN}/oauth/token`
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: AUTH0_CLIENT_ID,
    code,
    code_verifier,
    redirect_uri,
  })

  const response = await fetch(token_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!response.ok) {
    let detail = `HTTP ${response.status}`
    try {
      const err = (await response.json()) as Record<string, string>
      detail = `${err.error ?? 'unknown'}: ${err.error_description ?? 'Token exchange failed'}`
    } catch { /* use HTTP status */ }
    throw new Error(`Token exchange failed: ${detail}`)
  }

  return (await response.json()) as Record<string, unknown>
}

async function get_user_info(access_token: string): Promise<Record<string, unknown> | null> {
  const url = `https://${AUTH0_DOMAIN}/userinfo`
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${access_token}` },
    })
    if (!response.ok) return null
    return (await response.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Authorization URL builder
// ---------------------------------------------------------------------------

function build_authorize_url(redirect_uri: string, pkce: PKCEParams, state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: AUTH0_CLIENT_ID,
    redirect_uri,
    scope: AUTH0_SCOPES,
    audience: AUTH0_AUDIENCE,
    code_challenge: pkce.code_challenge,
    code_challenge_method: 'S256',
    state,
  })
  return `https://${AUTH0_DOMAIN}/authorize?${params.toString()}`
}

// ---------------------------------------------------------------------------
// Main login flow
// ---------------------------------------------------------------------------

export async function login(log: (msg: string) => void): Promise<StoredCredentials> {
  // Find available port
  const port = await find_available_port()
  if (port === null) {
    throw new Error(
      `No available ports in range ${CALLBACK_PORT_START}-${CALLBACK_PORT_END}. ` +
      'Please close applications using these ports and try again.',
    )
  }

  // Generate PKCE parameters and state
  const pkce = generate_pkce_params()
  const state = randomBytes(16).toString('base64url')
  const redirect_uri = `http://localhost:${port}/callback`

  // Build authorization URL
  const auth_url = build_authorize_url(redirect_uri, pkce, state)

  // Start callback server and wait for the authorization code
  const result = await new Promise<{ code: string; state: string | null } | null>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`)

      if (url.pathname !== '/callback') {
        res.writeHead(404)
        res.end()
        return
      }

      const error = url.searchParams.get('error')
      if (error) {
        const desc = url.searchParams.get('error_description') ?? 'Unknown error'
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(callback_page(false, desc))
        cleanup()
        reject(new Error(`${error}: ${desc}`))
        return
      }

      const code = url.searchParams.get('code')
      if (!code) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(callback_page(false, 'Missing authorization code'))
        cleanup()
        reject(new Error('Missing authorization code in callback'))
        return
      }

      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(callback_page(true))
      cleanup()
      resolve({ code, state: url.searchParams.get('state') })
    })

    const timeout_timer = setTimeout(() => {
      cleanup()
      resolve(null)
    }, CALLBACK_TIMEOUT_MS)

    function cleanup() {
      clearTimeout(timeout_timer)
      server.close()
    }

    server.listen(port, '127.0.0.1', () => {
      log(`Callback server listening on port ${port}`)

      // Try to open browser
      const opened = open_browser(auth_url)

      if (!opened || !process.env.DISPLAY && !process.env.BROWSER && platform() === 'linux') {
        // Headless fallback
        process.stderr.write(`\nOpen this URL in your browser to log in:\n\n  ${auth_url}\n\n`)
      } else {
        log('Opening browser for authentication...')
      }

      log('Waiting for authentication (up to 5 minutes)...')
    })

    server.on('error', (err) => {
      cleanup()
      reject(new Error(`Callback server error: ${err.message}`))
    })
  })

  if (result === null) {
    throw new Error('Authentication timed out. Please try again.')
  }

  // Verify state (CSRF protection)
  if (result.state !== state) {
    throw new Error('State mismatch -- possible CSRF attack. Please try again.')
  }

  log('Authorization code received, exchanging for tokens...')

  // Exchange code for tokens
  const token_response = await exchange_code_for_tokens(result.code, pkce.code_verifier, redirect_uri)

  const expires_in = (token_response.expires_in as number) ?? 3600

  // Fetch user info (optional, non-fatal)
  const user_info = await get_user_info(token_response.access_token as string)

  // Build and save credentials
  const creds: StoredCredentials = {
    access_token: token_response.access_token as string,
    refresh_token: (token_response.refresh_token as string) ?? null,
    expires_at: Date.now() / 1000 + expires_in,
    token_type: (token_response.token_type as string) ?? 'Bearer',
    user_info: user_info ?? undefined,
  }

  save_credentials(creds)
  log('Login successful -- credentials saved to ~/.voicemode/credentials')

  return creds
}
