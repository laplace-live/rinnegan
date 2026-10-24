import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AuditLog, readAuditEntries } from '@/audit/audit'
import { saveQRLogin } from '@/bilibili'
import { runBans, runUnban } from '@/commands/admin'
import { DEFAULT_CONFIG, mergeConfig } from '@/config'
import { createBanStore } from '@/store'
import { banRecord } from '@/testing/fixtures'
import { fakeBilibili as fakeServer, moderatorBlob } from '@/testing/login-sync'
import { qrLogin } from '@/testing/qr-login'

const ROOM = 25034104
const TOKEN = 'u1@p'

async function fakeBilibili(silent: { tuid: number; tname: string }[] = []) {
  return fakeServer({ token: TOKEN, blob: await moderatorBlob(TOKEN, 'csrf', 9), uid: 9, uname: '主播', silent })
}

describe('admin commands', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test('unban --session reverts every real ban of one live run', async () => {
    dir = mkdtempSync(join(tmpdir(), 'rinnegan-admin-'))
    const storeUrl = `sqlite:${join(dir, 'bans.sqlite')}`
    const store = await createBanStore(storeUrl)
    const live = new AuditLog({ dir, mode: 'live' })
    for (const uid of [101, 102]) {
      const record = banRecord({ roomId: ROOM, uid, uname: `bot${uid}`, operatorUid: 9 })
      await store.add(record)
      live.write('ban', { roomId: ROOM, uid, uname: `bot${uid}`, dryRun: false, banId: record.id })
    }
    live.write('ban', { roomId: ROOM, uid: 103, uname: 'simulated', dryRun: true })
    await store.close()

    const { posts, fetch } = await fakeBilibili()
    const config = mergeConfig(DEFAULT_CONFIG, { logDir: dir, storeUrl, loginSync: { token: TOKEN } })
    const code = await runUnban({
      config,
      room: null,
      uids: [],
      session: live.sessionId,
      reason: '误封',
      dryRun: false,
      fetch,
      gapMs: 0,
    })
    expect(code).toBe(0)
    expect(posts.map(post => post.body)).toEqual([
      `tuid=101&room_id=${ROOM}&mobi_app=web&csrf_token=csrf&csrf=csrf&visit_id=`,
      `tuid=102&room_id=${ROOM}&mobi_app=web&csrf_token=csrf&csrf=csrf&visit_id=`,
    ])

    const reopened = await createBanStore(storeUrl)
    expect(await reopened.listActive(ROOM)).toEqual([])
    expect((await reopened.list({ roomId: ROOM })).map(record => record.liftReason)).toEqual([
      '手动解除：误封',
      '手动解除：误封',
    ])
    await reopened.close()
    const audit = (await readAuditEntries(live.path)).filter(entry => entry.mode === 'unban')
    expect(audit.filter(entry => entry.event === 'unban').map(entry => entry.uid)).toEqual([101, 102])
  })

  test('unban needs targets and refuses to run without a login', async () => {
    dir = mkdtempSync(join(tmpdir(), 'rinnegan-admin-'))
    const config = mergeConfig(DEFAULT_CONFIG, { logDir: dir, storeUrl: 'memory:', loginFile: join(dir, 'login.json') })
    const base = { config, room: ROOM, session: null, reason: 'x', dryRun: false }
    expect(await runUnban({ ...base, uids: [] })).toBe(1)
    expect(await runUnban({ ...base, uids: [5] })).toBe(1)
    expect(await runUnban({ ...base, uids: [5], dryRun: true })).toBe(0)
  })

  test('bans lists the remote silent list', async () => {
    dir = mkdtempSync(join(tmpdir(), 'rinnegan-admin-'))
    const { posts, fetch } = await fakeBilibili([{ tuid: 5, tname: 'spammer' }])
    const config = mergeConfig(DEFAULT_CONFIG, { logDir: dir, storeUrl: 'memory:', loginSync: { token: TOKEN } })
    expect(await runBans({ config, room: ROOM, remote: true, local: true, limit: 10, fetch })).toBe(0)
    expect(posts[0]?.body).toBe(`room_id=${ROOM}&ps=1&csrf_token=csrf&csrf=csrf&visit_id=`)
  })

  test('bans and unban fall back to the saved QR login', async () => {
    dir = mkdtempSync(join(tmpdir(), 'rinnegan-admin-'))
    const loginFile = join(dir, 'login.json')
    await saveQRLogin(loginFile, qrLogin())
    const { posts, fetch } = fakeServer({ uid: 9, uname: '主播', silent: [{ tuid: 5, tname: 'spammer' }] })
    const config = mergeConfig(DEFAULT_CONFIG, { logDir: dir, storeUrl: 'memory:', loginFile })
    expect(await runBans({ config, room: ROOM, remote: true, local: false, limit: 10, fetch })).toBe(0)
    const unban = { config, room: ROOM, uids: [5], session: null, reason: '误封', dryRun: false, fetch, gapMs: 0 }
    expect(await runUnban(unban)).toBe(0)
    expect(posts.map(post => post.body)).toEqual([
      `room_id=${ROOM}&ps=1&csrf_token=qrcsrf&csrf=qrcsrf&visit_id=`,
      `tuid=5&room_id=${ROOM}&mobi_app=web&csrf_token=qrcsrf&csrf=qrcsrf&visit_id=`,
    ])
  })
})
