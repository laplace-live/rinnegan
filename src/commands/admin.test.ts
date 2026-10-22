import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encrypt } from '@laplace.live/login-sync'

import { AuditLog, readAuditEntries } from '@/audit/audit'
import { runBans, runUnban } from '@/commands/admin'
import { DEFAULT_CONFIG, mergeConfig } from '@/config'
import { createBanStore } from '@/store'

const ROOM = 25034104

async function loginSyncBlob(): Promise<string> {
  const cookie = (name: string, value: string) => ({
    name,
    value,
    domain: '.bilibili.com',
    path: '/',
    secure: true,
    httpOnly: false,
    hostOnly: false,
    session: true,
    sameSite: 'no_restriction',
    storeId: '0',
  })
  return encrypt(
    {
      cookie_data: { 'bilibili.com': [cookie('SESSDATA', 's'), cookie('bili_jct', 'csrf'), cookie('DedeUserID', '9')] },
      local_storage_data: {},
    },
    { uuid: 'u1', password: 'p' },
    { version: 2 }
  )
}

function fakeBilibili(blob: string, silent: { tuid: number; tname: string }[] = []) {
  const posts: { url: string; body: string }[] = []
  const fetch = async (url: string, init?: RequestInit) => {
    if (url.includes('/get/u1')) return Response.json({ encrypted: blob })
    if (url.includes('/nav')) return Response.json({ code: 0, data: { isLogin: true, mid: 9, uname: '主播' } })
    posts.push({ url, body: String(init?.body ?? '') })
    if (url.includes('GetSilentUserList')) return Response.json({ code: 0, data: { data: silent, total_page: 1 } })
    return Response.json({ code: 0, message: '0', data: {} })
  }
  return { posts, fetch }
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
      const id = crypto.randomUUID()
      await store.add({
        id,
        roomId: ROOM,
        uid,
        uname: `bot${uid}`,
        reason: '独轮车',
        score: 100,
        pattern: 'loop',
        evidence: {},
        createdAt: Date.now(),
        expiresAt: null,
        hours: -1,
        status: 'active',
        liftedAt: null,
        liftReason: null,
        spend: 0,
        operatorUid: 9,
        meta: {},
      })
      live.write('ban', { roomId: ROOM, uid, uname: `bot${uid}`, dryRun: false, banId: id })
    }
    live.write('ban', { roomId: ROOM, uid: 103, uname: 'simulated', dryRun: true })
    await store.close()

    const { posts, fetch } = fakeBilibili(await loginSyncBlob())
    const config = mergeConfig(DEFAULT_CONFIG, { logDir: dir, storeUrl, loginSync: { token: 'u1@p' } })
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

  test('unban needs targets and refuses to run without a login-sync token', async () => {
    dir = mkdtempSync(join(tmpdir(), 'rinnegan-admin-'))
    const config = mergeConfig(DEFAULT_CONFIG, { logDir: dir, storeUrl: 'memory:' })
    const base = { config, room: ROOM, session: null, reason: 'x', dryRun: false }
    expect(await runUnban({ ...base, uids: [] })).toBe(1)
    expect(await runUnban({ ...base, uids: [5] })).toBe(1)
    expect(await runUnban({ ...base, uids: [5], dryRun: true })).toBe(0)
  })

  test('bans lists the remote silent list', async () => {
    dir = mkdtempSync(join(tmpdir(), 'rinnegan-admin-'))
    const { posts, fetch } = fakeBilibili(await loginSyncBlob(), [{ tuid: 5, tname: 'spammer' }])
    const config = mergeConfig(DEFAULT_CONFIG, { logDir: dir, storeUrl: 'memory:', loginSync: { token: 'u1@p' } })
    expect(await runBans({ config, room: ROOM, remote: true, local: true, limit: 10, fetch })).toBe(0)
    expect(posts[0]?.body).toBe(`room_id=${ROOM}&ps=1&csrf_token=csrf&csrf=csrf&visit_id=`)
  })
})
