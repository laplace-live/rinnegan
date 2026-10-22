import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Reviewer, ReviewInput } from '@/ai/types'
import type { BilibiliClient, CredentialProvider } from '@/bilibili'
import type { ApiResult, SilentUser } from '@/bilibili/types'
import type { BanPatch, BanRecord, BanStore } from '@/store/types'
import type { Assessment } from '@/types'

import { AuditLog, readAuditEntries } from '@/audit/audit'
import { type AiMode, DEFAULT_CONFIG } from '@/config'
import { Enforcer } from '@/enforce/enforcer'

const dir = mkdtempSync(join(tmpdir(), 'rinnegan-enforcer-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const OK: ApiResult = { ok: true, code: 0, message: '0', data: {}, status: 200 }

class FakeStore implements BanStore {
  readonly kind = 'memory' as const
  readonly records: BanRecord[] = []
  async init() {}
  async add(record: BanRecord) {
    this.records.push(structuredClone(record))
  }
  async get(id: string) {
    return this.records.find(record => record.id === id) ?? null
  }
  async findActive(roomId: number, uid: number) {
    return this.records.find(r => r.roomId === roomId && r.uid === uid && r.status === 'active') ?? null
  }
  async listActive() {
    return this.records.filter(record => record.status === 'active')
  }
  async list() {
    return this.records
  }
  async listDue() {
    return []
  }
  async update(id: string, patch: BanPatch) {
    const record = this.records.find(item => item.id === id)
    if (!record) return null
    Object.assign(record, patch)
    return record
  }
  async addSpend() {
    return null
  }
  async close() {}
}

function fakeClient(options: { silent?: number[]; ban?: ApiResult[]; listFails?: boolean } = {}) {
  const bans: { roomId: number; uid: number; reason: string; hours: number }[] = []
  const unbans: number[] = []
  const banResults = [...(options.ban ?? [])]
  const client = {
    async getAllSilentUsers(): Promise<SilentUser[]> {
      if (options.listFails) throw new Error('没有权限')
      return (options.silent ?? []).map(uid => ({
        uid,
        uname: '',
        operatorName: null,
        createdAt: null,
        remainingSec: null,
        raw: {},
      }))
    },
    async addSilentUser(roomId: number, uid: number, reason: string, hours: number) {
      bans.push({ roomId, uid, reason, hours })
      return banResults.shift() ?? OK
    },
    async delSilentUser(_roomId: number, uid: number) {
      unbans.push(uid)
      return OK
    },
  }
  return { client: client as unknown as BilibiliClient, bans, unbans }
}

function assessment(patch: Partial<Assessment> = {}): Assessment {
  return {
    roomId: 1,
    uid: 42,
    uname: 'bot',
    at: Date.now(),
    score: 100,
    verdict: 'spam',
    pattern: 'loop',
    repeats: 30,
    windowMessages: 31,
    automation: 0.95,
    evidence: [{ kind: 'invisible-jitter', weight: 0.95, detail: 'U+00AD' }],
    clusters: [
      {
        key: '千舰',
        count: 31,
        variants: 20,
        invisible: 31,
        medianGapMs: 1300,
        regularity: 1,
        crowd: 0,
        firstAt: 0,
        lastAt: 1,
        samples: [{ timestamp: 0, text: '千­舰' }],
      },
    ],
    userType: 0,
    guardType: 0,
    medalLevel: 0,
    wealthLevel: 0,
    ...patch,
  }
}

function setup(
  options: {
    dryRun?: string | null
    client?: ReturnType<typeof fakeClient>
    reviewer?: Reviewer | null
    aiMode?: AiMode
    ban?: Partial<typeof DEFAULT_CONFIG.ban>
    credentials?: CredentialProvider | null
    now?: () => number
  } = {}
) {
  const client = options.client ?? fakeClient()
  const store = new FakeStore()
  const audit = new AuditLog({ dir, mode: 'test', sessionId: crypto.randomUUID() })
  const lines: string[] = []
  const enforcer = new Enforcer({
    ban: { ...DEFAULT_CONFIG.ban, ...options.ban },
    dryRunReason: options.dryRun === undefined ? null : options.dryRun,
    client: client.client,
    credentials: options.credentials ?? null,
    store,
    audit,
    reviewer: options.reviewer ?? null,
    aiMode: options.aiMode ?? 'off',
    operatorUid: 7,
    windowMs: 600_000,
    print: line => lines.push(line),
    apiGapMs: 0,
    now: options.now,
  })
  const events = async () => (await readAuditEntries(audit.path)).filter(entry => entry.session === audit.sessionId)
  return { enforcer, client, store, audit, lines, events }
}

function reviewer(probability: number, threshold = 0.8): Reviewer & { inputs: ReviewInput[] } {
  const inputs: ReviewInput[] = []
  return {
    label: 'fake',
    inputs,
    async review(input) {
      inputs.push(input)
      return { provider: 'fake', probability, agrees: probability >= threshold, reason: 'test', latencyMs: 1 }
    },
  }
}

describe('Enforcer', () => {
  test('bans a spam verdict once, stores and audits it', async () => {
    const { enforcer, client, store, events } = setup()
    expect(await enforcer.consider(assessment(), [])).toBe('banned')
    expect(await enforcer.consider(assessment({ score: 100 }), [])).toBe('skipped')
    expect(client.bans).toEqual([{ roomId: 1, uid: 42, reason: '独轮车 ×31：千舰', hours: -1 }])
    expect(store.records).toMatchObject([{ uid: 42, status: 'active', operatorUid: 7, reason: '独轮车 ×31：千舰' }])
    const ban = (await events()).find(entry => entry.event === 'ban')
    expect(ban).toMatchObject({ uid: 42, dryRun: false, banId: store.records[0]?.id })
    expect(enforcer.stats.banned).toBe(1)
  })

  test('dry-run simulates without calling the API', async () => {
    const { enforcer, client, store, events } = setup({ dryRun: '未提供 LOGIN_SYNC_TOKEN' })
    expect(await enforcer.consider(assessment(), [])).toBe('simulated')
    expect(client.bans).toEqual([])
    expect(store.records).toEqual([])
    expect((await events()).find(entry => entry.event === 'ban')).toMatchObject({ dryRun: true })
  })

  test('ignores suspects and exempt users', async () => {
    const { enforcer, client } = setup()
    expect(await enforcer.consider(assessment({ verdict: 'suspect', score: 85 }), [])).toBe('skipped')
    expect(await enforcer.consider(assessment({ userType: 100 }), [])).toBe('skipped')
    expect(await enforcer.consider(assessment({ uid: 43, pattern: 'flood' }), [])).toBe('skipped')
    expect(client.bans).toEqual([])
  })

  test('skips users already on the silent list', async () => {
    const { enforcer, client } = setup({ client: fakeClient({ silent: [42] }) })
    expect(await enforcer.consider(assessment(), [])).toBe('skipped')
    enforcer.noteBlocked(1, 43)
    expect(await enforcer.consider(assessment({ uid: 43 }), [])).toBe('skipped')
    expect(client.bans).toEqual([])
  })

  test('simulates bans in rooms this account cannot moderate', async () => {
    const { enforcer, client } = setup({ client: fakeClient({ listFails: true }) })
    expect(await enforcer.consider(assessment(), [])).toBe('simulated')
    expect(client.bans).toEqual([])
  })

  test('refreshes credentials once after an auth failure', async () => {
    let invalidated = 0
    const credentials = { invalidate: () => invalidated++ } as unknown as CredentialProvider
    const denied: ApiResult = { ok: false, code: -101, message: '账号未登录', data: null, status: 200 }
    const { enforcer, client } = setup({ client: fakeClient({ ban: [denied, OK] }), credentials })
    expect(await enforcer.consider(assessment(), [])).toBe('banned')
    expect(invalidated).toBe(1)
    expect(client.bans.length).toBe(2)
  })

  test('records a failure and retries after a back-off', async () => {
    const error: ApiResult = { ok: false, code: 1, message: '系统繁忙', data: null, status: 200 }
    let now = 1_000_000
    const { enforcer, client } = setup({ client: fakeClient({ ban: [error] }), now: () => now })
    expect(await enforcer.consider(assessment(), [])).toBe('failed')
    expect(await enforcer.consider(assessment(), [])).toBe('skipped')
    now += 61_000
    expect(await enforcer.consider(assessment(), [])).toBe('banned')
    expect(client.bans.length).toBe(2)
  })

  test('treats "already banned" as done', async () => {
    const already: ApiResult = { ok: false, code: 1, message: '该用户已经被禁言', data: null, status: 200 }
    const { enforcer, store } = setup({ client: fakeClient({ ban: [already] }) })
    expect(await enforcer.consider(assessment(), [])).toBe('banned')
    expect(store.records[0]?.meta).toEqual({ alreadyBanned: true })
  })

  test('safety brake pauses a room after maxPerMinute and stops at maxPerSession', async () => {
    const { enforcer, client } = setup({ ban: { maxPerMinute: 2, maxPerSession: 3 } })
    for (const uid of [1, 2, 3]) await enforcer.consider(assessment({ uid }), [])
    expect(client.bans.map(ban => ban.uid)).toEqual([1, 2])
    await enforcer.consider(assessment({ uid: 4, roomId: 2 }), [])
    await enforcer.consider(assessment({ uid: 5, roomId: 3 }), [])
    expect(client.bans.map(ban => ban.uid)).toEqual([1, 2, 4])
  })

  test('confirm mode needs the reviewer to agree', async () => {
    const yes = reviewer(0.95)
    const agreed = setup({ reviewer: yes, aiMode: 'confirm' })
    expect(
      await agreed.enforcer.consider(assessment(), [
        { timestamp: 0, text: 'a' },
        { timestamp: 1500, text: 'b' },
      ])
    ).toBe('banned')
    expect(yes.inputs[0]?.messages).toEqual([
      { offsetSec: 0, text: 'a' },
      { offsetSec: 1.5, text: 'b' },
    ])
    const vetoed = setup({ reviewer: reviewer(0.2), aiMode: 'confirm' })
    expect(await vetoed.enforcer.consider(assessment(), [])).toBe('vetoed')
    expect(vetoed.client.bans).toEqual([])
    expect((await vetoed.events()).some(entry => entry.event === 'veto')).toBe(true)
  })

  test('assist mode escalates a strong suspect only when the reviewer agrees', async () => {
    const suspect = assessment({
      verdict: 'suspect',
      score: 85,
      evidence: [{ kind: 'periodic', weight: 0.6, detail: 'banded' }],
    })
    const agreed = setup({ reviewer: reviewer(0.9), aiMode: 'assist' })
    expect(await agreed.enforcer.consider(suspect, [])).toBe('banned')
    const repetitionOnly = setup({ reviewer: reviewer(0.99), aiMode: 'assist' })
    const flood = { ...suspect, evidence: [{ kind: 'volume' as const, weight: 0.45, detail: '' }] }
    expect(await repetitionOnly.enforcer.consider(flood, [])).toBe('skipped')
    expect(repetitionOnly.client.bans).toEqual([])
  })

  test('lift calls the unban API, is audited, and a relapse can be banned again', async () => {
    const { enforcer, client, store, events } = setup()
    await enforcer.consider(assessment(), [])
    const record = store.records[0] as BanRecord
    expect(await enforcer.lift(record, '消费满 ¥30')).toBe(true)
    expect(client.unbans).toEqual([42])
    expect((await events()).find(entry => entry.event === 'unban')).toMatchObject({ uid: 42, reason: '消费满 ¥30' })
    // The ban lifecycle marks the record lifted once the API call succeeds.
    await store.update(record.id, { status: 'lifted', liftedAt: Date.now(), liftReason: '消费满 ¥30' })
    expect(await enforcer.consider(assessment(), [])).toBe('banned')
  })
})
