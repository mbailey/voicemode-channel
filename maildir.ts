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
 * Base-name lookup: the caller can pass either the bare filename or an
 * already-flagged `:2,FLAGS` form -- we look up by base name across new/
 * and cur/, matching the behaviour of mark_read.
 *
 * By default, a successful read marks the message as Seen (moves to cur/
 * with S flag). Pass `{ mark_read: false }` to opt out. The returned
 * MaildirMessage's `filename` field reflects the on-disk name after any
 * rename (so callers can use it for subsequent operations).
 *
 * Returns null if the file doesn't exist, fails security checks, or
 * has the wrong X-Transport header.
 */
export function read_message(
  filename: string,
  options: { mark_read?: boolean } = {},
): MaildirMessage | null {
  // Path traversal prevention: reject suspicious filenames
  if (filename.includes('..') || filename.includes('/')) return null

  const { mark_read: should_mark = true } = options

  const maildir = get_maildir_path()
  const maildir_resolved = resolve(maildir)
  const { base } = parse_maildir_filename(filename)

  // Locate the file by base name across new/ and cur/ (handles flag suffix drift)
  let found_path: string | null = null
  let found_name: string | null = null

  for (const sub of ['new', 'cur']) {
    const dir_path = join(maildir, sub)
    if (!existsSync(dir_path)) continue

    let entries: string[]
    try {
      entries = readdirSync(dir_path)
    } catch {
      continue
    }

    for (const entry of entries) {
      if (parse_maildir_filename(entry).base !== base) continue
      const candidate = join(dir_path, entry)
      const resolved = resolve(candidate)
      // Verify resolved path is within the Maildir directory
      if (!resolved.startsWith(maildir_resolved + '/')) continue
      found_path = resolved
      found_name = entry
      break
    }
    if (found_path) break
  }

  if (!found_path || !found_name) return null

  let raw: string
  try {
    raw = readFileSync(found_path, 'utf8')
  } catch {
    return null
  }

  const { headers, body } = parse_message(raw)

  // Only return messages with the correct transport header
  if (headers['X-Transport'] !== 'voicemode-connect') return null

  // Apply S flag (and move new/ -> cur/) unless opted out
  let effective_name = found_name
  if (should_mark) {
    const results = mark_read([found_name], 'S')
    const result = results[0]
    if (result && result.found && result.new_filename) {
      effective_name = result.new_filename
    }
  }

  return to_maildir_message(effective_name, headers, body)
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

// ---------------------------------------------------------------------------
// Maildir flag operations (mark_read)
// ---------------------------------------------------------------------------

/**
 * Parse a Maildir filename into its base and flag components.
 *
 * Maildir spec: filenames in cur/ use the form `<base>:2,<flags>` where flags
 * are ASCII letters sorted alphabetically (e.g. "RS" = Replied + Seen).
 * Files in new/ typically have no suffix.
 *
 * Only the experimental `:2,` variant is recognized -- `:1,` filenames are
 * treated as having no flags, since that form is not used by notmuch/neomutt.
 */
export function parse_maildir_filename(filename: string): { base: string; flags: string } {
  const marker = ':2,'
  const idx = filename.lastIndexOf(marker)
  if (idx < 0) return { base: filename, flags: '' }
  return { base: filename.slice(0, idx), flags: filename.slice(idx + marker.length) }
}

/**
 * Merge two flag strings into a single set of unique, alphabetically sorted
 * uppercase ASCII-letter flags.
 *
 * Non-letter characters are dropped. Case is normalized to uppercase.
 * Duplicates are removed. Output is sorted (standard Maildir flag order).
 */
export function merge_flags(existing: string, new_flags: string): string {
  const letters = new Set<string>()
  for (const ch of (existing + new_flags).toUpperCase()) {
    if (ch >= 'A' && ch <= 'Z') letters.add(ch)
  }
  return Array.from(letters).sort().join('')
}

/**
 * Build a full Maildir filename from its base and flag components.
 * When flags is empty, returns just the base (suitable for new/ files).
 */
export function build_maildir_filename(base: string, flags: string): string {
  return flags.length === 0 ? base : `${base}:2,${flags}`
}

export interface MarkReadResult {
  /** The filename as passed in by the caller. */
  filename: string
  /** New filename (with flags applied) if the file was found and renamed. */
  new_filename: string | null
  /** True if the file was located in new/ or cur/. */
  found: boolean
}

/**
 * Mark one or more messages with Maildir flags, moving them from new/ to cur/.
 *
 * For each filename:
 *   1. Locate the file by its base name (with or without a :2,FLAGS suffix)
 *      in either new/ or cur/.
 *   2. Merge the requested flags with any existing flags (unique, sorted).
 *   3. Rename the file to `<base>:2,<flags>` in cur/.
 *
 * Security: filenames containing '..' or '/' are rejected (returns found=false).
 *
 * Idempotent: marking an already-marked file with the same flags is a no-op
 * rename (the file is already in cur/ with those flags).
 *
 * @param filenames Basenames of Maildir files (as returned by list_messages)
 * @param flags Letters to apply (default "S" = Seen). Case-insensitive.
 * @returns One result per input filename, in the same order.
 */
export function mark_read(filenames: string[], flags: string = 'S'): MarkReadResult[] {
  const maildir = get_maildir_path()
  const maildir_resolved = resolve(maildir)
  const cur_dir = join(maildir, 'cur')

  // Ensure cur/ exists (may not if nothing has been marked yet)
  mkdirSync(cur_dir, { recursive: true })

  const results: MarkReadResult[] = []

  for (const filename of filenames) {
    // Path traversal prevention
    if (filename.includes('..') || filename.includes('/')) {
      results.push({ filename, new_filename: null, found: false })
      continue
    }

    const { base } = parse_maildir_filename(filename)

    // Search both new/ and cur/ for a file whose base matches.
    // The on-disk name may differ from `filename` if flags were previously applied.
    let found_path: string | null = null
    let found_sub: string | null = null
    let found_name: string | null = null

    for (const sub of ['new', 'cur']) {
      const dir_path = join(maildir, sub)
      if (!existsSync(dir_path)) continue

      let entries: string[]
      try {
        entries = readdirSync(dir_path)
      } catch {
        continue
      }

      for (const entry of entries) {
        if (parse_maildir_filename(entry).base === base) {
          const candidate = join(dir_path, entry)
          const resolved = resolve(candidate)
          // Verify resolved path is within the Maildir directory
          if (!resolved.startsWith(maildir_resolved + '/')) continue
          found_path = resolved
          found_sub = sub
          found_name = entry
          break
        }
      }
      if (found_path) break
    }

    if (!found_path || !found_sub || !found_name) {
      results.push({ filename, new_filename: null, found: false })
      continue
    }

    // Merge existing flags with requested flags
    const existing_flags = parse_maildir_filename(found_name).flags
    const merged = merge_flags(existing_flags, flags)
    const new_name = build_maildir_filename(base, merged)
    const new_path = join(cur_dir, new_name)

    // If source == destination, it's a no-op (already marked in cur/)
    if (found_path === resolve(new_path)) {
      results.push({ filename, new_filename: new_name, found: true })
      continue
    }

    try {
      renameSync(found_path, new_path)
      results.push({ filename, new_filename: new_name, found: true })
    } catch {
      results.push({ filename, new_filename: null, found: false })
    }
  }

  return results
}
