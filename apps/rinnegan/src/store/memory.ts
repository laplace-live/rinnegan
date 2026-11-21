import type { BanPatch, BanRecord, BanStore } from '@/store/types'

import { assertAmount, cleanPatch, cloneRecord, newestFirst, resolveLimit, soonestDue } from '@/store/record'

/** Process-local store for dry runs and tests; records are deep-copied in and out. */
export class MemoryBanStore implements BanStore {
  readonly kind = 'memory'
  readonly #bans = new Map<string, BanRecord>()

  async init(): Promise<void> {}

  async add(record: BanRecord): Promise<void> {
    if (this.#bans.has(record.id)) throw new Error(`duplicate ban id ${record.id}`)
    this.#bans.set(record.id, cloneRecord(record))
  }

  async get(id: string): Promise<BanRecord | null> {
    const ban = this.#bans.get(id)
    return ban ? cloneRecord(ban) : null
  }

  async findActive(roomId: number, uid: number): Promise<BanRecord | null> {
    const ban = this.#newestActive(roomId, uid)
    return ban ? cloneRecord(ban) : null
  }

  async listActive(roomId?: number): Promise<BanRecord[]> {
    return this.#select(ban => ban.status === 'active' && (roomId === undefined || ban.roomId === roomId))
      .sort(newestFirst)
      .map(cloneRecord)
  }

  async list(options: { roomId?: number; limit?: number } = {}): Promise<BanRecord[]> {
    const { roomId } = options
    return this.#select(ban => roomId === undefined || ban.roomId === roomId)
      .sort(newestFirst)
      .slice(0, resolveLimit(options.limit))
      .map(cloneRecord)
  }

  async listDue(now: number): Promise<BanRecord[]> {
    return this.#select(ban => ban.status === 'active' && ban.expiresAt !== null && ban.expiresAt <= now)
      .sort(soonestDue)
      .map(cloneRecord)
  }

  async update(id: string, patch: BanPatch): Promise<BanRecord | null> {
    const ban = this.#bans.get(id)
    if (!ban) return null
    const next = cloneRecord({ ...ban, ...cleanPatch(patch) })
    this.#bans.set(id, next)
    return cloneRecord(next)
  }

  async addSpend(roomId: number, uid: number, amount: number): Promise<BanRecord | null> {
    assertAmount(amount)
    const ban = this.#newestActive(roomId, uid)
    if (!ban) return null
    ban.spend += amount
    return cloneRecord(ban)
  }

  async close(): Promise<void> {}

  #select(predicate: (ban: BanRecord) => boolean): BanRecord[] {
    return [...this.#bans.values()].filter(predicate)
  }

  #newestActive(roomId: number, uid: number): BanRecord | undefined {
    return this.#select(ban => ban.status === 'active' && ban.roomId === roomId && ban.uid === uid).sort(newestFirst)[0]
  }
}
