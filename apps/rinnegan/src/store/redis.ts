import { RedisClient } from 'bun'

import type { BanPatch, BanRecord, BanStore } from '@/store/types'

import { assertAmount, cleanPatch, normalizeRecord, resolveLimit } from '@/store/record'

export interface RedisBanStoreOptions {
  /** Prepended to every key; defaults to `rinnegan:` */
  prefix?: string
}

const DEFAULT_PREFIX = 'rinnegan:'

/** Compare-and-set retries before `update` gives up on a ban that keeps changing. */
const MAX_UPDATE_ATTEMPTS = 50

// ARGV: prefix, id, json, roomId, uid, createdAt, status, expiresAt ('' when none) and, for updates, the expected json
const REINDEX = `
local p, id, json, room, uid, created, status, expires = unpack(ARGV, 1, 8)
local key = p .. 'ban:' .. id
local function reindex()
  for _, index in ipairs({ p .. 'active', p .. 'active:' .. room, p .. 'active:' .. room .. ':' .. uid }) do
    if status == 'active' then redis.call('ZADD', index, created, id) else redis.call('ZREM', index, id) end
  end
  if status == 'active' and expires ~= '' then
    redis.call('ZADD', p .. 'due', expires, id)
  else
    redis.call('ZREM', p .. 'due', id)
  end
end
`

const ADD_SCRIPT = `${REINDEX}
if redis.call('EXISTS', key) == 1 then return redis.error_reply('ERR duplicate ban id ' .. id) end
redis.call('SET', key, json)
redis.call('ZADD', p .. 'bans', created, id)
redis.call('ZADD', p .. 'room:' .. room, created, id)
reindex()
return 1
`

const UPDATE_SCRIPT = `${REINDEX}
if redis.call('GET', key) ~= ARGV[9] then return 0 end
redis.call('SET', key, json)
reindex()
return 1
`

// cjson would turn [] into {} and round numbers to 14 digits (16-digit uids!), so `spend` is rewritten in place
const ADD_SPEND_SCRIPT = `
local p = ARGV[1]
local id = redis.call('ZREVRANGE', p .. 'active:' .. ARGV[2] .. ':' .. ARGV[3], 0, 0)[1]
if not id then return false end
local key = p .. 'ban:' .. id
local json = redis.call('GET', key)
if not json then return false end
local spend, rest = string.match(json, '^{"spend":([^,]*)(,.*)$')
if not spend then return redis.error_reply('ERR malformed ban record ' .. id) end
json = '{"spend":' .. string.format('%.17g', (tonumber(spend) or 0) + tonumber(ARGV[4])) .. rest
redis.call('SET', key, json)
return json
`

/**
 * Ban records in Redis or Valkey. Each ban is JSON at `{prefix}ban:{id}`, indexed by sorted sets: `bans` and
 * `room:{roomId}` (all, by createdAt), `active`, `active:{roomId}` and `active:{roomId}:{uid}` (by createdAt), and
 * `due` (active with an expiry, by expiresAt). Writes are Lua scripts, so a record and its indexes change atomically.
 */
export class RedisBanStore implements BanStore {
  readonly kind = 'redis'
  readonly prefix: string
  readonly #client: RedisClient

  constructor(url: string, options: RedisBanStoreOptions = {}) {
    this.prefix = options.prefix ?? DEFAULT_PREFIX
    this.#client = new RedisClient(url)
  }

  async init(): Promise<void> {
    await this.#client.connect()
  }

  async add(record: BanRecord): Promise<void> {
    const ban = normalizeRecord(record)
    await this.#client.eval(ADD_SCRIPT, 0, ...this.#args(ban, encode(ban)))
  }

  async get(id: string): Promise<BanRecord | null> {
    const json = await this.#client.get(this.#key(id))
    return json === null ? null : decode(json)
  }

  async findActive(roomId: number, uid: number): Promise<BanRecord | null> {
    const ids = await this.#client.zrevrange(`${this.prefix}active:${roomId}:${uid}`, 0, 0)
    const [ban] = (await this.#fetch(ids)).filter(isActive)
    return ban ?? null
  }

  async listActive(roomId?: number): Promise<BanRecord[]> {
    const key = roomId === undefined ? `${this.prefix}active` : `${this.prefix}active:${roomId}`
    return (await this.#fetch(await this.#client.zrevrange(key, 0, -1))).filter(isActive)
  }

  async list(options: { roomId?: number; limit?: number } = {}): Promise<BanRecord[]> {
    const limit = resolveLimit(options.limit)
    if (limit === 0) return []
    const key = options.roomId === undefined ? `${this.prefix}bans` : `${this.prefix}room:${options.roomId}`
    return this.#fetch(await this.#client.zrevrange(key, 0, limit - 1))
  }

  async listDue(now: number): Promise<BanRecord[]> {
    const ids = await this.#client.zrangebyscore(`${this.prefix}due`, '-inf', now)
    return (await this.#fetch(ids)).filter(ban => isActive(ban) && ban.expiresAt !== null && ban.expiresAt <= now)
  }

  async update(id: string, patch: BanPatch): Promise<BanRecord | null> {
    const changes = cleanPatch(patch)
    for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt++) {
      const current = await this.#client.get(this.#key(id))
      if (current === null) return null
      if (Object.keys(changes).length === 0) return decode(current)
      const next = normalizeRecord({ ...decode(current), ...changes })
      const json = encode(next)
      // Fails when a concurrent addSpend or update got there first; retry on the fresh record
      if (await this.#client.eval(UPDATE_SCRIPT, 0, ...this.#args(next, json), current)) return decode(json)
    }
    throw new Error(`ban ${id} kept changing; update gave up after ${MAX_UPDATE_ATTEMPTS} attempts`)
  }

  async addSpend(roomId: number, uid: number, amount: number): Promise<BanRecord | null> {
    assertAmount(amount)
    const args = [this.prefix, String(roomId), String(uid), String(amount)]
    const json: string | null = await this.#client.eval(ADD_SPEND_SCRIPT, 0, ...args)
    return json === null ? null : decode(json)
  }

  async close(): Promise<void> {
    this.#client.close()
  }

  #key(id: string): string {
    return `${this.prefix}ban:${id}`
  }

  #args(ban: BanRecord, json: string): string[] {
    const expires = ban.expiresAt === null ? '' : String(ban.expiresAt)
    return [this.prefix, ban.id, json, String(ban.roomId), String(ban.uid), String(ban.createdAt), ban.status, expires]
  }

  async #fetch(ids: string[]): Promise<BanRecord[]> {
    if (ids.length === 0) return []
    const values = await this.#client.mget(...ids.map(id => this.#key(id)))
    return values.filter(json => json !== null).map(decode)
  }
}

/** `spend` leads so {@link ADD_SPEND_SCRIPT} can find it without parsing. */
function encode(ban: BanRecord): string {
  const { spend, ...rest } = ban
  return JSON.stringify({ spend, ...rest })
}

function decode(json: string): BanRecord {
  return normalizeRecord(JSON.parse(json) as BanRecord)
}

function isActive(ban: BanRecord): boolean {
  return ban.status === 'active'
}
