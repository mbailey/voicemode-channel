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

import { mkdirSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
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
