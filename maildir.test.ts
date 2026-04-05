/**
 * Unit tests for maildir.ts -- VoiceMode Maildir persistence.
 *
 * Run with: npx tsx maildir.test.ts
 */

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  write_message,
  read_message,
  list_messages,
  get_maildir_path,
  mark_read,
  parse_maildir_filename,
  merge_flags,
  build_maildir_filename,
  truncate_body,
  TRUNCATION_MARKER,
} from './maildir.js'
import type { VoiceMessage } from './maildir.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function make_tmp_maildir(): string {
  return mkdtempSync(join(tmpdir(), 'maildir-test-'))
}

function make_message(overrides: Partial<VoiceMessage> = {}): VoiceMessage {
  return {
    direction: 'inbound',
    from_name: 'Alice',
    to_name: 'Bob',
    text: 'Hello from the test suite',
    session_id: 'sess-001',
    agent_session_id: 'agent-sess-001',
    agent_name: 'TestAgent',
    timestamp: new Date('2026-04-05T12:00:00Z'),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('maildir', () => {
  let tmp_dir: string

  // Each test gets a fresh temporary Maildir
  beforeEach(() => {
    tmp_dir = make_tmp_maildir()
    process.env.VOICEMODE_MAILDIR_PATH = tmp_dir
    delete process.env.VOICEMODE_MAILDIR_ENABLED
  })

  after(() => {
    // Clean up env vars
    delete process.env.VOICEMODE_MAILDIR_PATH
    delete process.env.VOICEMODE_MAILDIR_ENABLED
  })

  // -----------------------------------------------------------------------
  // 1. Write message
  // -----------------------------------------------------------------------
  describe('write_message', () => {
    it('writes a file to new/ with correct RFC 2822 headers', () => {
      const msg = make_message()
      const filename = write_message(msg)

      assert.ok(filename, 'write_message should return a filename')

      // Verify file exists in new/
      const new_dir = join(tmp_dir, 'new')
      const files = readdirSync(new_dir)
      assert.ok(files.includes(filename), `File ${filename} should exist in new/`)

      // Read back and verify headers (opt out of auto-mark so file stays in new/)
      const result = read_message(filename, { mark_read: false })
      assert.ok(result, 'read_message should return the written message')

      assert.ok(result.from.includes('Alice'), 'From header should contain sender name')
      assert.ok(result.from.includes('alice@voicemode-connect'), 'From header should contain slugified email')
      assert.ok(result.to.includes('Bob'), 'To header should contain recipient name')
      assert.ok(result.to.includes('bob@voicemode-connect'), 'To header should contain slugified email')
      assert.ok(result.date.length > 0, 'Date header should be present')
      assert.ok(result.subject.length > 0, 'Subject header should be present')
      assert.equal(result.direction, 'inbound')
      assert.equal(result.session_id, 'sess-001')
      assert.equal(result.agent_session_id, 'agent-sess-001')
      assert.equal(result.agent_name, 'TestAgent')
      assert.equal(result.body, 'Hello from the test suite')

      // Verify Message-ID header exists in raw file
      const raw = readFileSync(join(new_dir, filename), 'utf8')
      assert.ok(raw.includes('Message-ID: <vm-'), 'Raw message should contain Message-ID header')
      assert.ok(raw.includes('X-Transport: voicemode-connect'), 'Raw message should contain X-Transport header')
      assert.ok(raw.includes('X-VoiceMode-Direction: inbound'), 'Raw message should contain direction header')
      assert.ok(raw.includes('X-VoiceMode-Session: sess-001'), 'Raw message should contain session header')
      assert.ok(raw.includes('X-VoiceMode-Agent-Session: agent-sess-001'), 'Raw message should contain agent session header')
      assert.ok(raw.includes('X-VoiceMode-Agent: TestAgent'), 'Raw message should contain agent header')
    })
  })

  // -----------------------------------------------------------------------
  // 2. Dedup
  // -----------------------------------------------------------------------
  describe('dedup', () => {
    it('writes only one file for duplicate messages', () => {
      const msg = make_message()
      const filename1 = write_message(msg)
      const filename2 = write_message(msg)

      assert.ok(filename1, 'First write should return a filename')
      assert.ok(filename2, 'Second write should return a filename')
      assert.equal(filename1, filename2, 'Both writes should return the same filename')

      // Count files in new/
      const files = readdirSync(join(tmp_dir, 'new'))
      assert.equal(files.length, 1, 'Only one file should exist after duplicate write')
    })
  })

  // -----------------------------------------------------------------------
  // 3. list_messages
  // -----------------------------------------------------------------------
  describe('list_messages', () => {
    it('filters by agent_session_id and direction, supports all_sessions and limit', () => {
      // Write messages across different sessions and directions
      write_message(make_message({
        text: 'msg-1-inbound',
        session_id: 'sess-A',
        agent_session_id: 'agent-A',
        direction: 'inbound',
        timestamp: new Date('2026-04-05T12:00:00Z'),
      }))
      write_message(make_message({
        text: 'msg-2-outbound',
        session_id: 'sess-A',
        agent_session_id: 'agent-A',
        direction: 'outbound',
        timestamp: new Date('2026-04-05T12:01:00Z'),
      }))
      write_message(make_message({
        text: 'msg-3-inbound-B',
        session_id: 'sess-B',
        agent_session_id: 'agent-B',
        direction: 'inbound',
        timestamp: new Date('2026-04-05T12:02:00Z'),
      }))
      write_message(make_message({
        text: 'msg-4-outbound-B',
        session_id: 'sess-B',
        agent_session_id: 'agent-B',
        direction: 'outbound',
        timestamp: new Date('2026-04-05T12:03:00Z'),
      }))

      // Filter by agent_session_id
      const agent_a = list_messages({ agent_session_id: 'agent-A' })
      assert.equal(agent_a.length, 2, 'Should find 2 messages for agent-A')
      assert.ok(agent_a.every(m => m.agent_session_id === 'agent-A'), 'All should be agent-A')

      const agent_b = list_messages({ agent_session_id: 'agent-B' })
      assert.equal(agent_b.length, 2, 'Should find 2 messages for agent-B')

      // Filter by direction
      const inbound = list_messages({ direction: 'inbound' })
      assert.equal(inbound.length, 2, 'Should find 2 inbound messages')
      assert.ok(inbound.every(m => m.direction === 'inbound'), 'All should be inbound')

      const outbound = list_messages({ direction: 'outbound' })
      assert.equal(outbound.length, 2, 'Should find 2 outbound messages')

      // Combined filter
      const agent_a_inbound = list_messages({ agent_session_id: 'agent-A', direction: 'inbound' })
      assert.equal(agent_a_inbound.length, 1, 'Should find 1 inbound message for agent-A')

      // All sessions (no agent_session_id filter) -- include bodies to check content
      const all = list_messages({ include_body: true })
      assert.equal(all.length, 4, 'Should find all 4 messages without filters')

      // Verify sort order (newest first)
      assert.ok(all[0].body.includes('msg-4'), 'First message should be newest (msg-4)')
      assert.ok(all[3].body.includes('msg-1'), 'Last message should be oldest (msg-1)')

      // Limit
      const limited = list_messages({ limit: 2, include_body: true })
      assert.equal(limited.length, 2, 'Limit should restrict result count')
      assert.ok(limited[0].body.includes('msg-4'), 'Limited results should still be newest first')
    })
  })

  // -----------------------------------------------------------------------
  // 4. read_message
  // -----------------------------------------------------------------------
  describe('read_message', () => {
    it('reads back a written message with all fields matching (mark_read: false)', () => {
      const msg = make_message({
        text: 'Read me back please',
        from_name: 'Sender',
        to_name: 'Receiver',
        direction: 'outbound',
        session_id: 'sess-read',
        agent_session_id: 'agent-read',
        agent_name: 'ReadAgent',
        timestamp: new Date('2026-04-05T15:30:00Z'),
      })

      const filename = write_message(msg)
      assert.ok(filename)

      const result = read_message(filename, { mark_read: false })
      assert.ok(result, 'read_message should return a message')

      assert.equal(result.filename, filename)
      assert.ok(result.from.includes('Sender'))
      assert.ok(result.to.includes('Receiver'))
      assert.equal(result.direction, 'outbound')
      assert.equal(result.session_id, 'sess-read')
      assert.equal(result.agent_session_id, 'agent-read')
      assert.equal(result.agent_name, 'ReadAgent')
      assert.equal(result.body, 'Read me back please')
      assert.equal(result.subject, 'Read me back please')

      // mark_read: false should leave the file in new/ untouched
      assert.ok(readdirSync(join(tmp_dir, 'new')).includes(filename))
      const cur_exists = readdirSync(tmp_dir).includes('cur')
        ? readdirSync(join(tmp_dir, 'cur')).length
        : 0
      assert.equal(cur_exists, 0, 'cur/ should be empty when mark_read: false')
    })

    it('returns null for non-existent messages', () => {
      const result = read_message('vm-doesnotexist')
      assert.equal(result, null)
    })

    it('marks the message as read by default (moves new/ -> cur/ with S flag)', () => {
      const filename = write_message(make_message({ text: 'auto-mark' }))!
      assert.ok(filename)

      const result = read_message(filename)
      assert.ok(result, 'read_message should return a message')

      // Filename in the returned message reflects the new on-disk name
      assert.equal(result.filename, `${filename}:2,S`)
      assert.equal(result.body, 'auto-mark')

      // File should have moved to cur/ with S flag
      assert.equal(readdirSync(join(tmp_dir, 'new')).length, 0)
      const cur_files = readdirSync(join(tmp_dir, 'cur'))
      assert.equal(cur_files.length, 1)
      assert.equal(cur_files[0], `${filename}:2,S`)
    })

    it('can read a message by base name after it has been marked', () => {
      const filename = write_message(make_message({ text: 'base-lookup' }))!

      // First read auto-marks -- file is now at cur/<filename>:2,S
      const first = read_message(filename)
      assert.ok(first)
      assert.equal(first.filename, `${filename}:2,S`)

      // Second read via the original bare filename still finds the file (base-name lookup)
      const second = read_message(filename, { mark_read: false })
      assert.ok(second, 'base-name lookup should locate the flagged file')
      assert.equal(second.body, 'base-lookup')
      assert.equal(second.filename, `${filename}:2,S`)
    })

    it('mark_read: false on a subsequent read preserves existing flags', () => {
      const filename = write_message(make_message({ text: 'preserve-flags' }))!

      // Auto-mark first call (S flag applied)
      read_message(filename)

      // Read again with mark_read: false -- should find the :2,S file and not modify it
      const cur_before = readdirSync(join(tmp_dir, 'cur'))
      const result = read_message(filename, { mark_read: false })
      const cur_after = readdirSync(join(tmp_dir, 'cur'))

      assert.ok(result)
      assert.deepEqual(cur_before, cur_after, 'cur/ contents unchanged when mark_read: false')
      assert.equal(result.filename, `${filename}:2,S`)
    })
  })

  // -----------------------------------------------------------------------
  // 5. read_message path traversal
  // -----------------------------------------------------------------------
  describe('read_message path traversal', () => {
    it('rejects ../../etc/passwd', () => {
      const result = read_message('../../etc/passwd')
      assert.equal(result, null, 'Path traversal with ../../etc/passwd should return null')
    })

    it('rejects ../secret', () => {
      const result = read_message('../secret')
      assert.equal(result, null, 'Path traversal with ../secret should return null')
    })

    it('rejects filenames containing slashes', () => {
      const result = read_message('subdir/filename')
      assert.equal(result, null, 'Filename with slash should return null')
    })
  })

  // -----------------------------------------------------------------------
  // 6. read_message wrong transport
  // -----------------------------------------------------------------------
  describe('read_message wrong transport', () => {
    it('returns null for messages with a different X-Transport header', () => {
      // Manually write a file with a different transport header
      const new_dir = join(tmp_dir, 'new')
      mkdirSync(new_dir, { recursive: true })

      const filename = 'vm-wrongtransport'
      const content = [
        'From: Evil <evil@other>',
        'To: Target <target@other>',
        'Date: Sat, 05 Apr 2026 12:00:00 GMT',
        'Subject: Wrong transport',
        'X-Transport: other-system',
        'X-VoiceMode-Direction: inbound',
        'X-VoiceMode-Session: sess-evil',
        'X-VoiceMode-Agent-Session: agent-evil',
        'X-VoiceMode-Agent: EvilAgent',
        '',
        'This should not be readable',
        '',
      ].join('\n')

      writeFileSync(join(new_dir, filename), content)

      const result = read_message(filename)
      assert.equal(result, null, 'Message with wrong X-Transport should return null')
    })
  })

  // -----------------------------------------------------------------------
  // 7. VOICEMODE_MAILDIR_ENABLED=false
  // -----------------------------------------------------------------------
  describe('VOICEMODE_MAILDIR_ENABLED=false', () => {
    it('returns null and writes no file when persistence is disabled', () => {
      process.env.VOICEMODE_MAILDIR_ENABLED = 'false'

      const msg = make_message({ text: 'Should not be written' })
      const result = write_message(msg)

      assert.equal(result, null, 'write_message should return null when disabled')

      // Verify no files were written (the new/ directory should not even exist)
      const new_dir = join(tmp_dir, 'new')
      let file_count = 0
      try {
        file_count = readdirSync(new_dir).length
      } catch {
        // Directory doesn't exist -- that's expected
      }
      assert.equal(file_count, 0, 'No files should be written when persistence is disabled')
    })
  })

  // -----------------------------------------------------------------------
  // 8. Maildir filename parsing helpers (pure functions)
  // -----------------------------------------------------------------------
  describe('parse_maildir_filename', () => {
    it('returns empty flags for a bare basename', () => {
      assert.deepEqual(parse_maildir_filename('vm-abc123'), { base: 'vm-abc123', flags: '' })
    })

    it('splits base and flags on :2, marker', () => {
      assert.deepEqual(parse_maildir_filename('vm-abc123:2,S'), { base: 'vm-abc123', flags: 'S' })
      assert.deepEqual(parse_maildir_filename('vm-abc123:2,RS'), { base: 'vm-abc123', flags: 'RS' })
    })

    it('preserves empty flags after :2, marker', () => {
      assert.deepEqual(parse_maildir_filename('vm-abc123:2,'), { base: 'vm-abc123', flags: '' })
    })

    it('treats unknown info markers (:1,) as no flags', () => {
      assert.deepEqual(parse_maildir_filename('vm-abc123:1,foo'), { base: 'vm-abc123:1,foo', flags: '' })
    })
  })

  describe('merge_flags', () => {
    it('returns sorted unique flags', () => {
      assert.equal(merge_flags('S', 'R'), 'RS')
      assert.equal(merge_flags('RS', 'S'), 'RS')
      assert.equal(merge_flags('', 'S'), 'S')
      assert.equal(merge_flags('S', ''), 'S')
    })

    it('deduplicates and sorts across both inputs', () => {
      assert.equal(merge_flags('SF', 'RT'), 'FRST')
      assert.equal(merge_flags('RRR', 'SSS'), 'RS')
    })

    it('normalizes to uppercase', () => {
      assert.equal(merge_flags('s', 'r'), 'RS')
      assert.equal(merge_flags('rS', 'f'), 'FRS')
    })

    it('drops non-letter characters', () => {
      assert.equal(merge_flags('S1', 'R!'), 'RS')
      assert.equal(merge_flags(',', ':2,S'), 'S')
    })
  })

  describe('build_maildir_filename', () => {
    it('returns base alone when flags are empty', () => {
      assert.equal(build_maildir_filename('vm-abc', ''), 'vm-abc')
    })

    it('appends :2, prefix when flags are set', () => {
      assert.equal(build_maildir_filename('vm-abc', 'S'), 'vm-abc:2,S')
      assert.equal(build_maildir_filename('vm-abc', 'RS'), 'vm-abc:2,RS')
    })
  })

  // -----------------------------------------------------------------------
  // 9. mark_read
  // -----------------------------------------------------------------------
  describe('mark_read', () => {
    it('moves a file from new/ to cur/ with default S flag', () => {
      const filename = write_message(make_message({ text: 'mark-me-read' }))!
      assert.ok(filename)

      const results = mark_read([filename])

      assert.equal(results.length, 1)
      assert.equal(results[0].filename, filename)
      assert.equal(results[0].found, true)
      assert.equal(results[0].new_filename, `${filename}:2,S`)

      // File should no longer exist in new/
      assert.equal(readdirSync(join(tmp_dir, 'new')).length, 0)
      // File should exist in cur/ with :2,S suffix
      const cur_files = readdirSync(join(tmp_dir, 'cur'))
      assert.equal(cur_files.length, 1)
      assert.equal(cur_files[0], `${filename}:2,S`)
    })

    it('supports custom flag sets and sorts them alphabetically', () => {
      const filename = write_message(make_message({ text: 'custom-flags' }))!
      const results = mark_read([filename], 'RS')

      assert.equal(results[0].new_filename, `${filename}:2,RS`)

      // Verify on disk
      const cur_files = readdirSync(join(tmp_dir, 'cur'))
      assert.ok(cur_files.includes(`${filename}:2,RS`))
    })

    it('sorts flags alphabetically even when input is not sorted', () => {
      const filename = write_message(make_message({ text: 'unsorted-input' }))!
      const results = mark_read([filename], 'SR')

      // Output must be alphabetically sorted per Maildir spec
      assert.equal(results[0].new_filename, `${filename}:2,RS`)
    })

    it('merges with existing flags when called twice', () => {
      const filename = write_message(make_message({ text: 'merge-flags' }))!

      // First mark: just S
      const first = mark_read([filename], 'S')
      assert.equal(first[0].new_filename, `${filename}:2,S`)

      // Second mark: add R -- should merge to RS (pass the already-flagged name)
      const second = mark_read([`${filename}:2,S`], 'R')
      assert.equal(second[0].new_filename, `${filename}:2,RS`)

      // Only one file should exist now (merge, not duplicate)
      assert.equal(readdirSync(join(tmp_dir, 'cur')).length, 1)
      assert.equal(readdirSync(join(tmp_dir, 'new')).length, 0)
    })

    it('looks up by base name so the caller can pass either form', () => {
      const filename = write_message(make_message({ text: 'by-base' }))!

      // First mark to get into cur/ with :2,S suffix
      mark_read([filename], 'S')

      // Now call again with the *bare* base name (no suffix) -- should still find it
      const results = mark_read([filename], 'R')
      assert.equal(results[0].found, true)
      assert.equal(results[0].new_filename, `${filename}:2,RS`)
    })

    it('deduplicates repeated flag letters', () => {
      const filename = write_message(make_message({ text: 'dedup-flags' }))!
      const results = mark_read([filename], 'SSSRS')

      assert.equal(results[0].new_filename, `${filename}:2,RS`)
    })

    it('is idempotent when the same flag is applied twice', () => {
      const filename = write_message(make_message({ text: 'idempotent' }))!

      mark_read([filename], 'S')
      const second = mark_read([`${filename}:2,S`], 'S')

      assert.equal(second[0].found, true)
      assert.equal(second[0].new_filename, `${filename}:2,S`)
      assert.equal(readdirSync(join(tmp_dir, 'cur')).length, 1)
    })

    it('handles bulk filenames in a single call', () => {
      const f1 = write_message(make_message({ text: 'bulk-1', timestamp: new Date('2026-04-05T10:00:00Z') }))!
      const f2 = write_message(make_message({ text: 'bulk-2', timestamp: new Date('2026-04-05T11:00:00Z') }))!
      const f3 = write_message(make_message({ text: 'bulk-3', timestamp: new Date('2026-04-05T12:00:00Z') }))!

      const results = mark_read([f1, f2, f3], 'S')

      assert.equal(results.length, 3)
      assert.ok(results.every(r => r.found), 'all three should be found')
      assert.equal(readdirSync(join(tmp_dir, 'new')).length, 0)
      assert.equal(readdirSync(join(tmp_dir, 'cur')).length, 3)
    })

    it('returns found=false for missing filenames without crashing', () => {
      // Write one real message
      const real = write_message(make_message({ text: 'real' }))!

      const results = mark_read([real, 'vm-doesnotexist'], 'S')

      assert.equal(results.length, 2)
      assert.equal(results[0].found, true)
      assert.equal(results[1].found, false)
      assert.equal(results[1].new_filename, null)
    })

    it('rejects filenames with path traversal', () => {
      const results = mark_read(['../../etc/passwd', '../secret', 'subdir/file'], 'S')

      assert.equal(results.length, 3)
      assert.ok(results.every(r => !r.found), 'all path-traversal attempts should fail')
      assert.ok(results.every(r => r.new_filename === null))
    })

    it('creates cur/ directory if it does not already exist', () => {
      const filename = write_message(make_message({ text: 'no-cur-yet' }))!

      // Remove cur/ to simulate a fresh maildir (write_message creates it but let's be sure)
      rmSync(join(tmp_dir, 'cur'), { recursive: true, force: true })
      assert.equal(readdirSync(tmp_dir).includes('cur'), false)

      const results = mark_read([filename], 'S')
      assert.equal(results[0].found, true)
      assert.ok(readdirSync(tmp_dir).includes('cur'))
      assert.equal(readdirSync(join(tmp_dir, 'cur')).length, 1)
    })

    it('accepts flag letters in mixed case', () => {
      const filename = write_message(make_message({ text: 'mixed-case' }))!
      const results = mark_read([filename], 'rs')

      assert.equal(results[0].new_filename, `${filename}:2,RS`)
    })

    it('applies custom flags to a bulk batch in a single call', () => {
      const f1 = write_message(make_message({ text: 'bulk-custom-1', timestamp: new Date('2026-04-05T10:00:00Z') }))!
      const f2 = write_message(make_message({ text: 'bulk-custom-2', timestamp: new Date('2026-04-05T11:00:00Z') }))!
      const f3 = write_message(make_message({ text: 'bulk-custom-3', timestamp: new Date('2026-04-05T12:00:00Z') }))!

      // Apply custom flag set (R + S) across the batch -- matches the mark_read MCP tool API
      const results = mark_read([f1, f2, f3], 'RS')

      assert.equal(results.length, 3)
      assert.ok(results.every(r => r.found), 'all three should be found')
      assert.equal(results[0].new_filename, `${f1}:2,RS`)
      assert.equal(results[1].new_filename, `${f2}:2,RS`)
      assert.equal(results[2].new_filename, `${f3}:2,RS`)

      // All files moved to cur/ with the RS flag set
      assert.equal(readdirSync(join(tmp_dir, 'new')).length, 0)
      const cur_files = readdirSync(join(tmp_dir, 'cur')).sort()
      assert.equal(cur_files.length, 3)
      assert.ok(cur_files.every(name => name.endsWith(':2,RS')))
    })
  })

  // -----------------------------------------------------------------------
  // 10. truncate_body (pure helper)
  // -----------------------------------------------------------------------
  describe('truncate_body', () => {
    it('returns body unchanged when shorter than limit', () => {
      assert.equal(truncate_body('hello', 2000), 'hello')
    })

    it('returns body unchanged when exactly at limit', () => {
      const body = 'a'.repeat(10)
      assert.equal(truncate_body(body, 10), body)
    })

    it('truncates and appends marker when body exceeds limit', () => {
      const body = 'a'.repeat(50)
      const result = truncate_body(body, 10)
      assert.ok(result.startsWith('a'.repeat(10)))
      assert.ok(result.endsWith(TRUNCATION_MARKER))
    })

    it('returns body unchanged when max_length is 0 (unlimited)', () => {
      const body = 'x'.repeat(100000)
      assert.equal(truncate_body(body, 0), body)
    })

    it('treats negative max_length as unlimited', () => {
      const body = 'hello world'
      assert.equal(truncate_body(body, -1), body)
    })

    it('does not append marker on empty body', () => {
      assert.equal(truncate_body('', 100), '')
      assert.equal(truncate_body('', 0), '')
    })
  })

  // -----------------------------------------------------------------------
  // 11. list_messages: include_body, body_max_length, unread filter
  // -----------------------------------------------------------------------
  describe('list_messages include_body and body_max_length', () => {
    it('omits bodies by default (include_body: false)', () => {
      write_message(make_message({ text: 'body text here' }))

      const messages = list_messages({})
      assert.equal(messages.length, 1)
      assert.equal(messages[0].body, '', 'body should be empty string when include_body is false')
    })

    it('returns full body when include_body: true and body is under limit', () => {
      write_message(make_message({ text: 'short body' }))

      const messages = list_messages({ include_body: true })
      assert.equal(messages.length, 1)
      assert.equal(messages[0].body, 'short body')
    })

    it('truncates bodies past body_max_length with a clear marker', () => {
      // Make a body longer than the truncation limit
      const long_text = 'X'.repeat(100)
      write_message(make_message({ text: long_text }))

      const messages = list_messages({ include_body: true, body_max_length: 20 })
      assert.equal(messages.length, 1)
      assert.ok(messages[0].body.startsWith('X'.repeat(20)))
      assert.ok(messages[0].body.endsWith(TRUNCATION_MARKER))
      // The truncated content length should be 20 + newline + marker
      assert.equal(messages[0].body.length, 20 + 1 + TRUNCATION_MARKER.length)
    })

    it('body_max_length: 0 returns full body without truncation', () => {
      const long_text = 'Z'.repeat(10000)
      write_message(make_message({ text: long_text }))

      const messages = list_messages({ include_body: true, body_max_length: 0 })
      assert.equal(messages.length, 1)
      assert.equal(messages[0].body, long_text, 'body_max_length: 0 should return full body')
      assert.ok(!messages[0].body.includes(TRUNCATION_MARKER), 'no truncation marker on unlimited')
    })

    it('default body_max_length is 2000 when include_body is true', () => {
      const long_text = 'A'.repeat(3000)
      write_message(make_message({ text: long_text }))

      const messages = list_messages({ include_body: true })
      assert.equal(messages.length, 1)
      assert.ok(messages[0].body.length < 3000, 'body should be truncated by default 2000 limit')
      assert.ok(messages[0].body.startsWith('A'.repeat(2000)))
      assert.ok(messages[0].body.endsWith(TRUNCATION_MARKER))
    })

    it('returns bodies for bulk reads across multiple messages', () => {
      write_message(make_message({ text: 'msg one', timestamp: new Date('2026-04-05T10:00:00Z') }))
      write_message(make_message({ text: 'msg two', timestamp: new Date('2026-04-05T11:00:00Z') }))
      write_message(make_message({ text: 'msg three', timestamp: new Date('2026-04-05T12:00:00Z') }))

      const messages = list_messages({ include_body: true })
      assert.equal(messages.length, 3)
      // Sorted newest first
      assert.equal(messages[0].body, 'msg three')
      assert.equal(messages[1].body, 'msg two')
      assert.equal(messages[2].body, 'msg one')
    })
  })

  describe('list_messages unread filter', () => {
    it('defaults to both read and unread (unread: undefined)', () => {
      const f1 = write_message(make_message({ text: 'unread-1', timestamp: new Date('2026-04-05T10:00:00Z') }))!
      const f2 = write_message(make_message({ text: 'read-2', timestamp: new Date('2026-04-05T11:00:00Z') }))!
      // Mark f2 as seen
      mark_read([f2], 'S')

      const all = list_messages({})
      assert.equal(all.length, 2, 'both messages should be returned when unread is omitted')
    })

    it('unread: true returns messages in new/ and cur/ files without S flag', () => {
      const f1 = write_message(make_message({ text: 'still-unread-in-new', timestamp: new Date('2026-04-05T10:00:00Z') }))!
      const f2 = write_message(make_message({ text: 'seen-in-cur', timestamp: new Date('2026-04-05T11:00:00Z') }))!
      const f3 = write_message(make_message({ text: 'replied-but-not-seen', timestamp: new Date('2026-04-05T12:00:00Z') }))!

      // f2 -> marked as Seen (S flag, moves to cur/)
      mark_read([f2], 'S')
      // f3 -> marked as Replied only (R flag, moves to cur/ but no S, so still unread)
      mark_read([f3], 'R')

      const unread = list_messages({ unread: true })
      assert.equal(unread.length, 2, 'unread should include new/ file and cur/ file without S')
      const bodies_present = unread.map(m => m.filename).sort()
      // f1 is still in new/ with no flags; f3 is in cur/ with :2,R
      assert.ok(bodies_present.some(n => n === f1), 'new/ file should be in unread list')
      assert.ok(bodies_present.some(n => n === `${f3}:2,R`), 'cur/ file without S should be in unread list')
    })

    it('unread: false returns only read messages (cur/ files with S flag)', () => {
      const f1 = write_message(make_message({ text: 'u-1', timestamp: new Date('2026-04-05T10:00:00Z') }))!
      const f2 = write_message(make_message({ text: 'seen-1', timestamp: new Date('2026-04-05T11:00:00Z') }))!
      const f3 = write_message(make_message({ text: 'seen-replied', timestamp: new Date('2026-04-05T12:00:00Z') }))!

      mark_read([f2], 'S')
      mark_read([f3], 'RS')

      const read = list_messages({ unread: false })
      assert.equal(read.length, 2, 'should return only messages with S flag')
      const names = read.map(m => m.filename).sort()
      assert.ok(names.some(n => n === `${f2}:2,S`))
      assert.ok(names.some(n => n === `${f3}:2,RS`))
    })

    it('unread filter composes with include_body and body_max_length', () => {
      const f1 = write_message(make_message({ text: 'unread body content', timestamp: new Date('2026-04-05T10:00:00Z') }))!
      const f2 = write_message(make_message({ text: 'read body content', timestamp: new Date('2026-04-05T11:00:00Z') }))!
      mark_read([f2], 'S')

      const unread = list_messages({ unread: true, include_body: true, body_max_length: 0 })
      assert.equal(unread.length, 1)
      assert.equal(unread[0].body, 'unread body content')
    })

    it('unread filter returns empty list when all messages are read', () => {
      const f1 = write_message(make_message({ text: 'one', timestamp: new Date('2026-04-05T10:00:00Z') }))!
      const f2 = write_message(make_message({ text: 'two', timestamp: new Date('2026-04-05T11:00:00Z') }))!
      mark_read([f1, f2], 'S')

      const unread = list_messages({ unread: true })
      assert.equal(unread.length, 0)
    })
  })

})
