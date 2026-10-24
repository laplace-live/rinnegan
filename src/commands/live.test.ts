import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { LiveSession } from '@/commands/live'
import type { ChatMessage } from '@/types'

import { readAuditEntries } from '@/audit/audit'
import { saveQRLogin } from '@/bilibili'
import { startLive } from '@/commands/live'
import { DEFAULT_CONFIG, mergeConfig } from '@/config'
import { messageEvent } from '@/testing/events'
import { type FakeBridge, startFakeBridge } from '@/testing/fake-bridge'
import { fakeBilibili, moderatorBlob } from '@/testing/login-sync'
import { qrLogin } from '@/testing/qr-login'
import { mergeStreams, simulateChatterboxLoop, simulateHumanChat } from '@/testing/simulate'
import { until } from '@/testing/wait'

const ROOM = 25034104

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
    for (const message of traffic()) bridge.broadcast(messageEvent(message))

    const audit = session?.audit
    await until(async () => (await readAuditEntries(audit?.path ?? '')).some(entry => entry.event === 'ban'))
    const entries = await readAuditEntries(audit?.path ?? '')
    const ban = entries.find(entry => entry.event === 'ban')
    expect(ban).toMatchObject({
      uid: 4242,
      dryRun: true,
      dryRunReason: '未提供 LOGIN_SYNC_TOKEN，也未扫码登录（rinnegan login）',
    })
    expect(String(ban?.reason)).toContain('关注主播谢谢喵')
    expect(entries.find(entry => entry.event === 'session-start')).toMatchObject({
      dryRun: true,
      login: null,
      rooms: [ROOM],
    })
    expect(entries.some(entry => entry.event === 'detection' && entry.uid === 7 && entry.verdict === 'spam')).toBe(
      false
    )
    expect(calls.every(url => url.includes('room_init'))).toBe(true)
  })

  test('real run: pulls cookies from login sync and calls AddSilentUser once', async () => {
    dir = mkdtempSync(join(tmpdir(), 'rinnegan-live-'))
    bridge = startFakeBridge()
    const token = 'abc123@pw'
    const blob = await moderatorBlob(token, 'csrf123', 777)
    const { fetch, posts } = fakeBilibili({ token, blob, uid: 777, uname: '房管', roomId: ROOM })
    const config = mergeConfig(DEFAULT_CONFIG, {
      logDir: dir,
      storeUrl: 'memory:',
      live: { url: bridge.url, rooms: [ROOM] },
      loginSync: { token, baseURL: 'https://login-sync.test' },
    })
    session = await startLive({ config, verbose: false, statusEvery: 0, fetch })
    expect(session).not.toBeNull()
    await bridge.waitForConnections(1)
    for (const message of traffic()) bridge.broadcast(messageEvent(message))

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

  test('an explicit dry run never logs in, so a broken saved login cannot stop it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'rinnegan-live-'))
    bridge = startFakeBridge()
    const loginFile = join(dir, 'login.json')
    await Bun.write(loginFile, '{}')
    const calls: string[] = []
    const config = mergeConfig(DEFAULT_CONFIG, {
      logDir: dir,
      live: { url: bridge.url, rooms: [ROOM] },
      loginFile,
      ban: { dryRun: true },
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
    const entries = await readAuditEntries(session?.audit.path ?? '')
    expect(entries.find(entry => entry.event === 'session-start')).toMatchObject({
      dryRun: true,
      dryRunReason: '已指定 --dry-run',
      login: null,
    })
    expect(calls.every(url => url.includes('room_init'))).toBe(true)
  })

  test('a saved QR login takes live mode out of dry run', async () => {
    dir = mkdtempSync(join(tmpdir(), 'rinnegan-live-'))
    bridge = startFakeBridge()
    const loginFile = join(dir, 'login.json')
    await saveQRLogin(loginFile, qrLogin())
    const { fetch, posts } = fakeBilibili({ uid: 9, uname: '主播', roomId: ROOM })
    const config = mergeConfig(DEFAULT_CONFIG, {
      logDir: dir,
      storeUrl: 'memory:',
      live: { url: bridge.url, rooms: [ROOM] },
      loginFile,
    })
    session = await startLive({ config, verbose: false, statusEvery: 0, fetch })
    const path = session?.audit.path ?? ''
    await until(async () => (await readAuditEntries(path)).some(entry => entry.event === 'room-ready'))
    expect((await readAuditEntries(path)).find(entry => entry.event === 'session-start')).toMatchObject({
      dryRun: false,
      login: 'qr',
      operatorUid: 9,
    })
    expect(posts.map(post => post.body)).toEqual([`room_id=${ROOM}&ps=1&csrf_token=qrcsrf&csrf=qrcsrf&visit_id=`])
  })
})
