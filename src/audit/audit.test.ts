import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AuditLog, readAuditEntries, scrub } from '@/audit/audit'

const dir = mkdtempSync(join(tmpdir(), 'rinnegan-audit-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('AuditLog', () => {
  test('appends JSONL entries tagged with session and mode', async () => {
    const audit = new AuditLog({ dir, mode: 'live', now: () => new Date(2026, 9, 21, 12).getTime() })
    audit.write('ban', { uid: 1, reason: '独轮车' })
    audit.write('unban', { uid: 1 })
    expect(audit.path).toEndWith('audit-2026-10-21.jsonl')
    const entries = await readAuditEntries(audit.path)
    expect(entries.map(entry => entry.event)).toEqual(['ban', 'unban'])
    expect(entries[0]).toMatchObject({ session: audit.sessionId, mode: 'live', uid: 1, reason: '独轮车' })
  })

  test('never writes secrets', async () => {
    const audit = new AuditLog({ dir, mode: 'live', now: () => new Date(2026, 9, 22).getTime() })
    audit.write('session-start', { loginSync: { token: 'uuid@pw' }, cookie: 'SESSDATA=x', nested: [{ csrf: 'y' }] })
    const text = await Bun.file(audit.path).text()
    expect(text).not.toContain('uuid@pw')
    expect(text).not.toContain('SESSDATA')
    expect(text).toContain('[redacted]')
  })

  test('skips a torn final line', async () => {
    const path = join(dir, 'torn.jsonl')
    await Bun.write(path, '{"event":"ban"}\n{"event":"un')
    expect(await readAuditEntries(path)).toEqual([{ event: 'ban' }])
  })
})

describe('scrub', () => {
  test('replaces secret keys at any depth and keeps the rest', () => {
    expect(scrub({ apiKey: 'k', a: { password: 'p', b: 1 }, list: [{ authKey: 'x' }] })).toEqual({
      apiKey: '[redacted]',
      a: { password: '[redacted]', b: 1 },
      list: [{ authKey: '[redacted]' }],
    })
  })
})
