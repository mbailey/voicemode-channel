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

      // Read back and verify headers
      const result = read_message(filename)
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

      // All sessions (no agent_session_id filter)
      const all = list_messages({})
      assert.equal(all.length, 4, 'Should find all 4 messages without filters')

      // Verify sort order (newest first)
      assert.ok(all[0].body.includes('msg-4'), 'First message should be newest (msg-4)')
      assert.ok(all[3].body.includes('msg-1'), 'Last message should be oldest (msg-1)')

      // Limit
      const limited = list_messages({ limit: 2 })
      assert.equal(limited.length, 2, 'Limit should restrict result count')
      assert.ok(limited[0].body.includes('msg-4'), 'Limited results should still be newest first')
    })
  })

  // -----------------------------------------------------------------------
  // 4. read_message
  // -----------------------------------------------------------------------
  describe('read_message', () => {
    it('reads back a written message with all fields matching', () => {
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

      const result = read_message(filename)
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
    })

    it('returns null for non-existent messages', () => {
      const result = read_message('vm-doesnotexist')
      assert.equal(result, null)
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
  })
})
