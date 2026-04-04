/**
 * Maildir persistence for VoiceMode voice messages.
 *
 * Writes inbound (user speaks) and outbound (agent replies) messages to Maildir
 * format so they can be indexed by notmuch and accessed via MCP tools.
 *
 * Maildir protocol: write to tmp/ first, then rename() to new/ (atomic, no locking).
 * Dedup: content-hash filename (sha256(from|timestamp|text)[:16]) prevents duplicates.
 *
 * Environment variables:
 *   VOICEMODE_MAILDIR_PATH    Override default ~/.voicemode/maildir/channel
 *   VOICEMODE_MAILDIR_ENABLED Set to 'false' to disable persistence
 */

import { mkdirSync, writeFileSync, renameSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'

export interface VoiceMessage {
  direction: 'inbound' | 'outbound'
  from_name: string
  to_name: string
  text: string
  session_id: string        // gateway session
  agent_session_id: string  // claude session
  agent_name: string
  timestamp?: Date
}

export interface MaildirMessage {
  filename: string
  from: string
  to: string
  date: string
  subject: string
  direction: string
  session_id: string
  agent_session_id: string
  agent_name: string
  body: string
}

const DEFAULT_MAILDIR = join(homedir(), '.voicemode', 'maildir', 'channel')

export function get_maildir_path(): string {
  return process.env.VOICEMODE_MAILDIR_PATH || DEFAULT_MAILDIR
}

/**
 * Write a voice message to Maildir.
 *
 * Returns the filename if written (or already exists), null if persistence is disabled.
 * Uses atomic tmp/ -> new/ rename to guarantee no partial reads.
 * Silently skips duplicate messages (same from/timestamp/text hash).
 */
export function write_message(msg: VoiceMessage): string | null {
  if (process.env.VOICEMODE_MAILDIR_ENABLED === 'false') return null

  const maildir = get_maildir_path()
  const ts = msg.timestamp ?? new Date()

  // Ensure Maildir structure exists
  for (const sub of ['tmp', 'new', 'cur']) {
    mkdirSync(join(maildir, sub), { recursive: true })
  }

  // Content-hash dedup: sha256(from|timestamp|text)[:16]
  const hash = createHash('sha256')
    .update(`${msg.from_name}|${ts.toISOString()}|${msg.text}`)
    .digest('hex')
    .slice(0, 16)
  const filename = `vm-${hash}`

  // Skip if already written (dedup -- check both new/ and cur/)
  const new_path = join(maildir, 'new', filename)
  const cur_path = join(maildir, 'cur', filename)
  if (existsSync(new_path) || existsSync(cur_path)) return filename

  // Slugify name -> email-safe local part
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')

  // RFC 2822 message
  const subject = msg.text.length > 60 ? msg.text.slice(0, 60) + '...' : msg.text
  const rfc_date = ts.toUTCString()  // e.g. "Sat, 05 Apr 2026 12:00:00 GMT"

  const email = [
    `From: ${msg.from_name} <${slug(msg.from_name)}@voicemode-connect>`,
    `To: ${msg.to_name} <${slug(msg.to_name)}@voicemode-connect>`,
    `Date: ${rfc_date}`,
    `Subject: ${subject}`,
    `Message-ID: <vm-${hash}@voicemode-connect>`,
    `X-Transport: voicemode-connect`,
    `X-VoiceMode-Direction: ${msg.direction}`,
    `X-VoiceMode-Session: ${msg.session_id}`,
    `X-VoiceMode-Agent-Session: ${msg.agent_session_id}`,
    `X-VoiceMode-Agent: ${msg.agent_name}`,
    '',
    msg.text,
    '',
  ].join('\n')

  // Atomic write: tmp/ -> new/
  const tmp_path = join(maildir, 'tmp', filename)
  writeFileSync(tmp_path, email)
  renameSync(tmp_path, new_path)

  return filename
}

// ---------------------------------------------------------------------------
// Read helpers -- parse RFC 2822 messages from Maildir
// ---------------------------------------------------------------------------

/**
 * Parse an RFC 2822 message string into headers and body.
 * Headers are separated from the body by the first blank line.
 */
function parse_message(raw: string): { headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = {}
  const separator = raw.indexOf('\n\n')
  const header_block = separator >= 0 ? raw.slice(0, separator) : raw
  const body = separator >= 0 ? raw.slice(separator + 2).trimEnd() : ''

  for (const line of header_block.split('\n')) {
    const colon = line.indexOf(':')
    if (colon < 1) continue
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    headers[key] = value
  }

  return { headers, body }
}

/**
 * Convert parsed headers + body into a MaildirMessage.
 */
function to_maildir_message(filename: string, headers: Record<string, string>, body: string): MaildirMessage {
  return {
    filename,
    from: headers['From'] ?? '',
    to: headers['To'] ?? '',
    date: headers['Date'] ?? '',
    subject: headers['Subject'] ?? '',
    direction: headers['X-VoiceMode-Direction'] ?? '',
    session_id: headers['X-VoiceMode-Session'] ?? '',
    agent_session_id: headers['X-VoiceMode-Agent-Session'] ?? '',
    agent_name: headers['X-VoiceMode-Agent'] ?? '',
    body,
  }
}

/**
 * Read a single message by filename from the Maildir.
 *
 * Security: rejects filenames containing '..' or '/' and verifies the
 * resolved path is within the Maildir directory. Only returns messages
 * with X-Transport: voicemode-connect header.
 *
 * Returns null if the file doesn't exist, fails security checks, or
 * has the wrong X-Transport header.
 */
export function read_message(filename: string): MaildirMessage | null {
  // Path traversal prevention: reject suspicious filenames
  if (filename.includes('..') || filename.includes('/')) return null

  const maildir = get_maildir_path()
  const maildir_resolved = resolve(maildir)

  // Check new/ and cur/ directories
  for (const sub of ['new', 'cur']) {
    const file_path = join(maildir, sub, filename)
    const resolved_path = resolve(file_path)

    // Verify resolved path is within the Maildir directory
    if (!resolved_path.startsWith(maildir_resolved + '/')) continue

    if (!existsSync(resolved_path)) continue

    try {
      const raw = readFileSync(resolved_path, 'utf8')
      const { headers, body } = parse_message(raw)

      // Only return messages with the correct transport header
      if (headers['X-Transport'] !== 'voicemode-connect') return null

      return to_maildir_message(filename, headers, body)
    } catch {
      return null
    }
  }

  return null
}

/**
 * List messages from the Maildir, filtered by session and direction.
 *
 * Scans both new/ and cur/ directories. Only includes messages with
 * X-Transport: voicemode-connect header.
 *
 * Returns messages sorted by date descending (newest first).
 */
export function list_messages(options: {
  agent_session_id?: string
  direction?: 'inbound' | 'outbound'
  limit?: number
}): MaildirMessage[] {
  const { agent_session_id, direction, limit = 50 } = options
  const maildir = get_maildir_path()
  const messages: MaildirMessage[] = []

  for (const sub of ['new', 'cur']) {
    const dir_path = join(maildir, sub)
    if (!existsSync(dir_path)) continue

    let filenames: string[]
    try {
      filenames = readdirSync(dir_path)
    } catch {
      continue
    }

    for (const filename of filenames) {
      // Skip hidden files and non-vm files
      if (filename.startsWith('.')) continue

      const file_path = join(dir_path, filename)
      let raw: string
      try {
        raw = readFileSync(file_path, 'utf8')
      } catch {
        continue
      }

      const { headers, body } = parse_message(raw)

      // Only include voicemode-connect messages
      if (headers['X-Transport'] !== 'voicemode-connect') continue

      // Filter by agent_session_id if provided
      if (agent_session_id && headers['X-VoiceMode-Agent-Session'] !== agent_session_id) continue

      // Filter by direction if provided
      if (direction && headers['X-VoiceMode-Direction'] !== direction) continue

      messages.push(to_maildir_message(filename, headers, body))
    }
  }

  // Sort by date descending (newest first)
  messages.sort((a, b) => {
    const date_a = new Date(a.date).getTime()
    const date_b = new Date(b.date).getTime()
    // Handle invalid dates by pushing them to the end
    if (isNaN(date_a) && isNaN(date_b)) return 0
    if (isNaN(date_a)) return 1
    if (isNaN(date_b)) return -1
    return date_b - date_a
  })

  return messages.slice(0, limit)
}
