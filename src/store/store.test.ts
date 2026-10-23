import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RedisClient, SQL } from 'bun'

import type { BanPatch, BanRecord, BanStore } from '@/store/types'

import { createBanStore, describeStoreUrl } from '@/store'
import { MemoryBanStore } from '@/store/memory'
import { PostgresBanStore } from '@/store/postgres'
import { RedisBanStore } from '@/store/redis'
import { SqliteBanStore } from '@/store/sqlite'
import { banRecord as ban } from '@/testing/fixtures'

const PG_URL = process.env.RINNEGAN_TEST_DATABASE_URL ?? ''
const REDIS_URL = process.env.RINNEGAN_TEST_REDIS_URL ?? ''

/** 16 digits, past cjson's 14-digit precision */
const BIG_UID = 3_493_118_437_721_017

function ids(bans: BanRecord[]): string[] {
  return bans.map(b => b.id)
}

function tempDir(): { path: string; remove(): void } {
  const path = mkdtempSync(join(tmpdir(), 'rinnegan-store-'))
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) }
}

/** Registers the BanStore contract in the enclosing `describe`; `open` returns a fresh, initialized, empty store. */
function banStoreContract(open: () => Promise<BanStore>): void {
  let store: BanStore

  beforeEach(async () => {
    store = await open()
  })

  afterEach(async () => {
    await store.close()
  })

  test('add/get roundtrip keeps JSON fields, nulls and 16-digit ids', async () => {
    const active = ban({
      uid: BIG_UID,
      score: 87.53333333333333,
      evidence: {
        samples: [{ timestamp: 1_760_000_000_123, text: '千舰\u200b 🚗' }],
        empty: [],
        nested: { none: null, ratio: 0.1 + 0.2 },
      },
      meta: { source: 'test', tags: ['a', 'b'], list: [] },
    })
    const lifted = ban({
      expiresAt: 1_760_000_600_000,
      hours: 1,
      status: 'lifted',
      liftedAt: 1_760_000_300_000,
      liftReason: '手动解除',
      spend: 12.5,
      operatorUid: 3_546_569_284_667_590,
      evidence: null,
    })
    const plain = ban({ evidence: '纯文本证据', meta: { quote: '"\\' } })
    for (const record of [active, lifted, plain]) await store.add(record)

    expect(await store.get(active.id)).toEqual(active)
    expect(await store.get(lifted.id)).toEqual(lifted)
    expect(await store.get(plain.id)).toEqual(plain)
    expect(await store.get('missing')).toBeNull()
  })

  test('copies records in and out', async () => {
    const record = ban({ meta: { tags: ['a'] } })
    const original = structuredClone(record)
    await store.add(record)
    const tags = record.meta.tags as string[]
    tags.push('changed after add')

    const got = await store.get(record.id)
    if (!got) throw new Error('missing')
    got.meta.extra = true
    got.spend = 99
    expect(await store.get(record.id)).toEqual(original)
  })

  test('rejects a duplicate id', async () => {
    const record = ban()
    await store.add(record)
    await expect(store.add({ ...record, uname: 'other' })).rejects.toThrow()
    expect(await store.get(record.id)).toEqual(record)
  })

  test('findActive returns the newest active ban of the user in the room', async () => {
    const older = ban({ createdAt: 1000 })
    const newer = ban({ createdAt: 2000 })
    const newestLifted = ban({ createdAt: 3000, status: 'lifted', liftedAt: 3500, liftReason: '解除' })
    const otherUser = ban({ uid: 2001, createdAt: 4000 })
    const otherRoom = ban({ roomId: 1001, createdAt: 5000 })
    for (const record of [older, newestLifted, newer, otherUser, otherRoom]) await store.add(record)

    expect(await store.findActive(1000, 2000)).toEqual(newer)
    expect(await store.findActive(1000, 2001)).toEqual(otherUser)
    expect(await store.findActive(1001, 2000)).toEqual(otherRoom)
    expect(await store.findActive(1000, 9999)).toBeNull()
    expect(await store.findActive(9999, 2000)).toBeNull()
  })

  test('listActive is newest first, breaks ties by id and filters by room', async () => {
    const a = ban({ roomId: 1, createdAt: 3000 })
    const b = ban({ roomId: 2, createdAt: 1000 })
    const tieLow = ban({ roomId: 1, createdAt: 2000, id: '00000000-0000-4000-8000-000000000001' })
    const tieHigh = ban({ roomId: 1, createdAt: 2000, id: '00000000-0000-4000-8000-000000000002' })
    const lifted = ban({ roomId: 1, createdAt: 4000, status: 'lifted' })
    const expired = ban({ roomId: 2, createdAt: 5000, status: 'expired' })
    for (const record of [b, tieLow, lifted, a, expired, tieHigh]) await store.add(record)

    expect(await store.listActive()).toEqual([a, tieHigh, tieLow, b])
    expect(await store.listActive(1)).toEqual([a, tieHigh, tieLow])
    expect(await store.listActive(2)).toEqual([b])
    expect(await store.listActive(3)).toEqual([])
  })

  test('list covers every status, newest first, with room filter and limit', async () => {
    const statuses = ['active', 'lifted', 'active', 'expired', 'active'] as const
    const records = statuses.map((status, i) => ban({ roomId: i % 2 === 0 ? 1 : 2, createdAt: (i + 1) * 1000, status }))
    for (const record of records) await store.add(record)
    const newest = [...records].reverse()

    expect(await store.list()).toEqual(newest)
    expect(await store.list({ limit: 2 })).toEqual(newest.slice(0, 2))
    expect(await store.list({ roomId: 1 })).toEqual(newest.filter(r => r.roomId === 1))
    expect(await store.list({ roomId: 2, limit: 1 })).toEqual(records.slice(3, 4))
    expect(await store.list({ limit: 0 })).toEqual([])
  })

  test('list returns 100 bans by default', async () => {
    await Promise.all(Array.from({ length: 105 }, (_, i) => store.add(ban({ createdAt: i }))))
    const page = await store.list()
    expect(page).toHaveLength(100)
    expect(page[0]?.createdAt).toBe(104)
    expect(page.at(-1)?.createdAt).toBe(5)
  })

  test('listDue returns active bans whose expiry has passed, soonest first', async () => {
    const late = ban({ expiresAt: 1500 })
    const early = ban({ expiresAt: 1000 })
    const future = ban({ expiresAt: 2000 })
    const permanent = ban({ expiresAt: null })
    const lifted = ban({ expiresAt: 500, status: 'lifted' })
    for (const record of [late, permanent, future, lifted, early]) await store.add(record)

    expect(await store.listDue(1500)).toEqual([early, late])
    expect(await store.listDue(999)).toEqual([])
    expect(await store.listDue(Number.MAX_SAFE_INTEGER)).toEqual([early, late, future])
  })

  test('update patches fields and returns the stored record', async () => {
    const record = ban()
    await store.add(record)
    expect(await store.update('missing', { uname: 'x' })).toBeNull()

    const patch = {
      uname: '改名',
      score: 99.5,
      evidence: ['a'],
      meta: { note: '备注', list: [] },
      operatorUid: BIG_UID,
    }
    const expected = { ...record, ...patch }
    expect(await store.update(record.id, patch)).toEqual(expected)
    expect(await store.get(record.id)).toEqual(expected)

    // undefined values and identity fields are ignored
    const sneaky = { uname: undefined, id: 'x', roomId: 1, uid: 2, createdAt: 3 } as unknown as BanPatch
    expect(await store.update(record.id, sneaky)).toEqual(expected)
    expect(await store.update(record.id, {})).toEqual(expected)
    expect(await store.get(record.id)).toEqual(expected)
  })

  test('update keeps the active, due and per-user views consistent', async () => {
    const older = ban({ createdAt: 1000 })
    const record = ban({ createdAt: 2000 })
    await store.add(older)
    await store.add(record)

    await store.update(record.id, { expiresAt: 5000 })
    expect(ids(await store.listDue(5000))).toEqual([record.id])
    await store.update(record.id, { expiresAt: null })
    expect(await store.listDue(Number.MAX_SAFE_INTEGER)).toEqual([])
    await store.update(record.id, { expiresAt: 6000 })

    const lifted = await store.update(record.id, { status: 'lifted', liftedAt: 7000, liftReason: '测试' })
    expect(lifted).toMatchObject({ status: 'lifted', liftedAt: 7000, liftReason: '测试', expiresAt: 6000 })
    expect(ids(await store.listActive())).toEqual([older.id])
    expect(ids(await store.listActive(record.roomId))).toEqual([older.id])
    expect((await store.findActive(record.roomId, record.uid))?.id).toBe(older.id)
    expect(await store.listDue(Number.MAX_SAFE_INTEGER)).toEqual([])
    expect(ids(await store.list())).toEqual([record.id, older.id])

    await store.update(record.id, { status: 'active' })
    expect((await store.findActive(record.roomId, record.uid))?.id).toBe(record.id)
    expect(ids(await store.listDue(6000))).toEqual([record.id])
    expect(ids(await store.listActive())).toEqual([record.id, older.id])
  })

  test('addSpend accumulates atomically on the newest active ban', async () => {
    const older = ban({ createdAt: 1000 })
    const record = ban({ createdAt: 2000 })
    await store.add(older)
    await store.add(record)

    const results = await Promise.all(Array.from({ length: 20 }, () => store.addSpend(1000, 2000, 1.5)))
    expect(results.map(r => r?.id)).toEqual(Array(20).fill(record.id))
    // Every call saw a distinct running total, so none overwrote another
    expect(results.map(r => r?.spend ?? 0).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => (i + 1) * 1.5)
    )
    expect((await store.get(record.id))?.spend).toBe(30)
    expect((await store.get(older.id))?.spend).toBe(0)
  })

  test('addSpend keeps fractional sums exact and other fields intact', async () => {
    const record = ban({ uid: BIG_UID, evidence: { samples: [] }, meta: { list: [] } })
    await store.add(record)
    await store.addSpend(record.roomId, BIG_UID, 0.1)
    const result = await store.addSpend(record.roomId, BIG_UID, 0.2)
    expect(result).toEqual({ ...record, spend: 0.1 + 0.2 })
    expect(await store.get(record.id)).toEqual({ ...record, spend: 0.1 + 0.2 })
  })

  test('update racing addSpend loses neither change', async () => {
    const record = ban()
    await store.add(record)
    const spends = () => Array.from({ length: 10 }, () => store.addSpend(1000, 2000, 2))
    await Promise.all([...spends(), store.update(record.id, { meta: { note: '并发' }, expiresAt: 9000 }), ...spends()])
    expect(await store.get(record.id)).toEqual({ ...record, spend: 40, meta: { note: '并发' }, expiresAt: 9000 })
  })

  test('addSpend returns null without an active ban', async () => {
    expect(await store.addSpend(1000, 2000, 10)).toBeNull()
    const lifted = ban({ status: 'lifted' })
    const elsewhere = ban({ roomId: 1001 })
    await store.add(lifted)
    await store.add(elsewhere)

    expect(await store.addSpend(1000, 2000, 10)).toBeNull()
    expect((await store.get(lifted.id))?.spend).toBe(0)
    expect((await store.get(elsewhere.id))?.spend).toBe(0)
    await expect(store.addSpend(1001, 2000, Number.NaN)).rejects.toThrow()
  })
}

describe('MemoryBanStore', () => {
  banStoreContract(async () => new MemoryBanStore())
})

describe('SqliteBanStore', () => {
  const dir = tempDir()
  afterAll(() => dir.remove())

  banStoreContract(async () => {
    const store = new SqliteBanStore(join(dir.path, 'nested', `${crypto.randomUUID()}.db`))
    await store.init()
    return store
  })

  test('creates the database directory and survives reopening', async () => {
    const path = join(dir.path, 'a', 'b', 'bans.db')
    const record = ban({ evidence: { samples: [] } })
    const first = new SqliteBanStore(path)
    await first.init()
    await first.add(record)
    await first.close()

    const second = new SqliteBanStore(path)
    await second.init()
    expect(await second.get(record.id)).toEqual(record)
    await second.close()
  })
})

describe.skipIf(!PG_URL)('PostgresBanStore', () => {
  const suite = crypto.randomUUID().replaceAll('-', '').slice(0, 12)
  const tables: string[] = []

  afterAll(async () => {
    const admin = new SQL(PG_URL)
    for (const table of tables) await admin`DROP TABLE IF EXISTS ${admin(table)}`
    await admin.close()
  })

  banStoreContract(async () => {
    const table = `rinnegan_test_${suite}_${tables.length}`
    tables.push(table)
    const store = new PostgresBanStore(PG_URL, { table })
    await store.init()
    await store.init()
    return store
  })

  test('stores U+0000 as U+FFFD', async () => {
    const store = new PostgresBanStore(PG_URL, { table: `rinnegan_test_${suite}_nul` })
    tables.push(store.table)
    await store.init()
    const record = ban({ evidence: { samples: ['a\u0000b'] }, meta: { note: '\u0000' } })
    await store.add(record)
    await store.update(record.id, { meta: { note: 'c\u0000' } })
    expect(await store.get(record.id)).toMatchObject({ evidence: { samples: ['a\uFFFDb'] }, meta: { note: 'c\uFFFD' } })
    await store.close()
  })

  test('rejects table names that are not plain identifiers', () => {
    expect(() => new PostgresBanStore(PG_URL, { table: 'bans; DROP TABLE x' })).toThrow()
    expect(() => new PostgresBanStore(PG_URL, { table: 'a'.repeat(48) })).toThrow()
  })
})

describe.skipIf(!REDIS_URL)('RedisBanStore', () => {
  const suite = `rinnegan-test:${crypto.randomUUID()}:`
  let stores = 0

  afterAll(async () => {
    const admin = new RedisClient(REDIS_URL)
    let cursor = '0'
    do {
      const [next, keys] = await admin.scan(cursor, 'MATCH', `${suite}*`, 'COUNT', 1000)
      if (keys.length > 0) await admin.del(...keys)
      cursor = next
    } while (cursor !== '0')
    admin.close()
  })

  banStoreContract(async () => {
    const store = new RedisBanStore(REDIS_URL, { prefix: `${suite}${stores++}:` })
    await store.init()
    return store
  })

  test('sorted-set indexes follow status and expiry', async () => {
    const prefix = `${suite}indexes:`
    const client = new RedisClient(REDIS_URL)
    const store = new RedisBanStore(REDIS_URL, { prefix })
    await store.init()
    const record = ban({ expiresAt: 5000 })
    const scores = async () => ({
      bans: await client.zscore(`${prefix}bans`, record.id),
      room: await client.zscore(`${prefix}room:${record.roomId}`, record.id),
      active: await client.zscore(`${prefix}active`, record.id),
      roomActive: await client.zscore(`${prefix}active:${record.roomId}`, record.id),
      userActive: await client.zscore(`${prefix}active:${record.roomId}:${record.uid}`, record.id),
      due: await client.zscore(`${prefix}due`, record.id),
    })
    const at = record.createdAt
    const all = { bans: at, room: at, active: at, roomActive: at, userActive: at }

    await store.add(record)
    expect(await scores()).toEqual({ ...all, due: 5000 })
    await store.update(record.id, { expiresAt: null })
    expect(await scores()).toEqual({ ...all, due: null })
    await store.update(record.id, { expiresAt: 8000, status: 'lifted', liftedAt: 1, liftReason: '解除' })
    expect(await scores()).toEqual({ bans: at, room: at, active: null, roomActive: null, userActive: null, due: null })
    await store.update(record.id, { status: 'active' })
    expect(await scores()).toEqual({ ...all, due: 8000 })

    await store.close()
    client.close()
  })
})

describe('createBanStore', () => {
  const dir = tempDir()
  afterAll(() => dir.remove())

  test('picks the backend from the URL', async () => {
    for (const url of ['memory', 'memory:', ' memory: ']) {
      const store = await createBanStore(url)
      expect(store.kind).toBe('memory')
      await store.close()
    }
    for (const path of [
      `sqlite:${join(dir.path, 'x', 'a.db')}`,
      `sqlite://${join(dir.path, 'b.db')}`,
      join(dir.path, 'c.db'),
    ]) {
      const store = await createBanStore(path)
      expect(store.kind).toBe('sqlite')
      await store.close()
    }
    expect(existsSync(join(dir.path, 'x', 'a.db'))).toBe(true)
    expect(existsSync(join(dir.path, 'b.db'))).toBe(true)
    expect(existsSync(join(dir.path, 'c.db'))).toBe(true)
    await expect(createBanStore('mysql://root:secret@localhost/db')).rejects.toThrow('mysql://root:***@localhost/db')
    await expect(createBanStore('')).rejects.toThrow()
    await expect(createBanStore('sqlite:')).rejects.toThrow()
  })

  test('describeStoreUrl masks passwords only', () => {
    expect(describeStoreUrl('postgres://rinnegan:secret@127.0.0.1:5432/db')).toBe(
      'postgres://rinnegan:***@127.0.0.1:5432/db'
    )
    expect(describeStoreUrl('rediss://default:tok@cache.example.com:6380')).toBe(
      'rediss://default:***@cache.example.com:6380'
    )
    expect(describeStoreUrl('redis://:secret@127.0.0.1:6379/0')).toBe('redis://:***@127.0.0.1:6379/0')
    expect(describeStoreUrl('postgresql://db.example.com/x?sslmode=require&password=secret')).toBe(
      'postgresql://db.example.com/x?sslmode=require&password=***'
    )
    for (const url of ['valkey://127.0.0.1:6379', 'sqlite:./data/bans.db', './data/bans.db', 'memory']) {
      expect(describeStoreUrl(url)).toBe(url)
    }
  })
})
