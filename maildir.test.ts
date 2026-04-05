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

import { write_message, read_message, list_messages, get_maildir_path } from './maildir.js'
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
})
