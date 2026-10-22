import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encrypt } from '@laplace.live/login-sync'

import type { LiveSession } from '@/commands/live'
import type { ChatMessage } from '@/types'

import { readAuditEntries } from '@/audit/audit'
import { startLive } from '@/commands/live'
import { DEFAULT_CONFIG, mergeConfig } from '@/config'
import { type FakeBridge, startFakeBridge } from '@/testing/fake-bridge'
import { mergeStreams, simulateChatterboxLoop, simulateHumanChat } from '@/testing/simulate'

const ROOM = 25034104

function toEvent(message: ChatMessage) {
  return {
    type: 'message',
    id: message.id,
    origin: message.roomId,
    originIdx: 0,
    uid: message.uid,
    username: message.uname,
    message: message.text,
    userType: 0,
    guardType: 0,
    sendType: 0,
    medal: { level: 0 },
    wealthMedalLevel: 0,
    timestamp: message.timestamp,
    timestampNormalized: message.timestamp,
  }
}

function traffic(): ChatMessage[] {
  const start = Date.parse('2026-10-20T12:00:00Z')
  const bot = simulateChatterboxLoop({
    persona: { uid: 4242, uname: '独轮车bot', roomId: ROOM },
    template: '关注主播谢谢喵',
    startAt: start,
    durationMs: 60_000,
    randomChar: '­',
  })
  const human = simulateHumanChat({
    persona: { uid: 7, uname: 'fan', roomId: ROOM },
    lines: ['主播好', '哈哈', '?'],
    startAt: start,
    sends: 6,
  })
  return mergeStreams(bot, human)
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out')
    await Bun.sleep(20)
  }
}

describe('live mode end to end', () => {
  let bridge: FakeBridge | null = null
  let session: LiveSession | null = null
  let dir = ''
  afterEach(async () => {
    await session?.stop('test')
    bridge?.stop()
    if (dir) rmSync(dir, { recursive: true, force: true })
    session = null
    bridge = null
  })

  test('dry run without a login-sync token: detects and audits a simulated ban', async () => {
    dir = mkdtempSync(join(tmpdir(), 'rinnegan-live-'))
    bridge = startFakeBridge()
    const calls: string[] = []
    const config = mergeConfig(DEFAULT_CONFIG, {
      logDir: dir,
      live: { url: bridge.url, rooms: [ROOM] },
      loginSync: { token: '' },
    })
    session = await startLive({
      config,
      verbose: false,
      statusEvery: 0,
      fetch: (url: string) => {
        calls.push(url)
        return Response.json({ code: 0, data: { room_id: ROOM, short_id: 0, uid: 1 } })
      },
    })
    expect(session).not.toBeNull()
    await bridge.waitForConnections(1)
    for (const message of traffic()) bridge.broadcast(toEvent(message))

    const audit = session?.audit
    await until(async () => (await readAuditEntries(audit?.path ?? '')).some(entry => entry.event === 'ban'))
    const entries = await readAuditEntries(audit?.path ?? '')
    const ban = entries.find(entry => entry.event === 'ban')
    expect(ban).toMatchObject({ uid: 4242, dryRun: true, dryRunReason: '未提供 LOGIN_SYNC_TOKEN' })
    expect(String(ban?.reason)).toContain('关注主播谢谢喵')
    expect(entries.find(entry => entry.event === 'session-start')).toMatchObject({ dryRun: true, rooms: [ROOM] })
    expect(entries.some(entry => entry.event === 'detection' && entry.uid === 7 && entry.verdict === 'spam')).toBe(
      false
    )
    expect(calls.every(url => url.includes('room_init'))).toBe(true)
  })

  test('real run: pulls cookies from login sync and calls AddSilentUser once', async () => {
    dir = mkdtempSync(join(tmpdir(), 'rinnegan-live-'))
    bridge = startFakeBridge()
    const credentials = { uuid: 'abc123', password: 'pw' }
    const expires = Date.now() / 1000 + 86_400
    const cookie = (name: string, value: string) => ({
      name,
      value,
      domain: '.bilibili.com',
      path: '/',
      secure: true,
      httpOnly: false,
      hostOnly: false,
      session: false,
      sameSite: 'no_restriction',
      storeId: '0',
      expirationDate: expires,
    })
    const blob = await encrypt(
      {
        cookie_data: {
          'bilibili.com': [cookie('SESSDATA', 'sess'), cookie('bili_jct', 'csrf123'), cookie('DedeUserID', '777')],
        },
        local_storage_data: {},
      },
      credentials,
      { version: 2 }
    )
    const posts: { url: string; body: string }[] = []
    const fetch = async (url: string, init?: RequestInit) => {
      if (url.includes('/get/abc123')) return Response.json({ encrypted: blob })
      if (url.includes('/x/web-interface/nav')) {
        return Response.json({ code: 0, data: { isLogin: true, mid: 777, uname: '房管' } })
      }
      if (url.includes('room_init')) return Response.json({ code: 0, data: { room_id: ROOM, short_id: 0, uid: 1 } })
      posts.push({ url, body: String(init?.body ?? '') })
      if (url.includes('GetSilentUserList')) return Response.json({ code: 0, data: { data: [], total_page: 1 } })
      return Response.json({ code: 0, message: '0', data: {} })
    }
    const config = mergeConfig(DEFAULT_CONFIG, {
      logDir: dir,
      storeUrl: 'memory:',
      live: { url: bridge.url, rooms: [ROOM] },
      loginSync: { token: 'abc123@pw', baseURL: 'https://login-sync.test' },
    })
    session = await startLive({ config, verbose: false, statusEvery: 0, fetch })
    expect(session).not.toBeNull()
    await bridge.waitForConnections(1)
    for (const message of traffic()) bridge.broadcast(toEvent(message))

    await until(() => posts.some(post => post.url.includes('AddSilentUser')), 10_000)
    await Bun.sleep(200)
    const bans = posts.filter(post => post.url.includes('AddSilentUser'))
    expect(bans.length).toBe(1)
    expect(bans[0]?.body).toStartWith(`room_id=${ROOM}&tuid=4242&msg=`)
    expect(bans[0]?.body).toEndWith('&mobile_app=web&type=1&hour=-1&csrf_token=csrf123&csrf=csrf123&visit_id=')
    const entries = await readAuditEntries(session?.audit.path ?? '')
    expect(entries.find(entry => entry.event === 'ban')).toMatchObject({ uid: 4242, dryRun: false })
    expect(entries.find(entry => entry.event === 'session-start')).toMatchObject({ operatorUid: 777, dryRun: false })
    expect(JSON.stringify(entries)).not.toContain('csrf123')
    expect(session?.enforcer.stats.banned).toBe(1)
  }, 20_000)
})
