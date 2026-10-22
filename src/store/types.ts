import type { SpendEvent } from '@/types'

/** `active` until a rule or an operator lifts it; `expired` when Rinnegan's own schedule ran out. */
export type BanStatus = 'active' | 'lifted' | 'expired'

/** A ban Rinnegan placed, persisted so other tools can lift or extend it later. */
export interface BanRecord {
  /** `crypto.randomUUID()` */
  id: string
  roomId: number
  uid: number
  uname: string
  /** Text sent to Bilibili as the ban reason (`msg`) */
  reason: string
  /** Detector score at ban time, 0..100 */
  score: number
  /** Detector pattern, e.g. `loop` */
  pattern: string
  /** Assessment snapshot (evidence, samples); JSON-serializable */
  evidence: unknown
  /** Unix ms */
  createdAt: number
  /** Unix ms when Rinnegan lifts the ban itself; null for permanent */
  expiresAt: number | null
  /** `hour` sent to Bilibili; -1 is permanent */
  hours: number
  status: BanStatus
  /** Unix ms */
  liftedAt: number | null
  liftReason: string | null
  /** CNY the user spent in the room since the ban */
  spend: number
  /** Account that placed the ban */
  operatorUid: number | null
  /** Free-form data for custom rules; JSON-serializable */
  meta: Record<string, unknown>
}

/** Fields a store may patch; identity and creation time never change. */
export type BanPatch = Partial<Omit<BanRecord, 'id' | 'roomId' | 'uid' | 'createdAt'>>

export type BanStoreKind = 'memory' | 'sqlite' | 'postgres' | 'redis'

/** Persistence for ban records. Implementations must be safe to share across one process. */
export interface BanStore {
  readonly kind: BanStoreKind
  /** Create tables/indexes; idempotent. */
  init(): Promise<void>
  add(record: BanRecord): Promise<void>
  get(id: string): Promise<BanRecord | null>
  /** Newest active ban of `uid` in `roomId`. */
  findActive(roomId: number, uid: number): Promise<BanRecord | null>
  /** Active bans, newest first, optionally for one room. */
  listActive(roomId?: number): Promise<BanRecord[]>
  /** Every ban (any status), newest first, optionally for one room; `limit` defaults to 100. */
  list(options?: { roomId?: number; limit?: number }): Promise<BanRecord[]>
  /** Active bans with `expiresAt <= now`. */
  listDue(now: number): Promise<BanRecord[]>
  /** Apply `patch`; null when the id is unknown. */
  update(id: string, patch: BanPatch): Promise<BanRecord | null>
  /** Atomically add `amount` (CNY) to the user's newest active ban in the room; null when there is none. */
  addSpend(roomId: number, uid: number, amount: number): Promise<BanRecord | null>
  close(): Promise<void>
}

/** What a rule wants done with an active ban. */
export type RuleDecision =
  | { action: 'keep' }
  | { action: 'lift'; reason: string }
  | { action: 'extend'; expiresAt: number | null; reason: string }

/**
 * A condition that lifts or extends bans, e.g. "spend ¥30 to get unbanned". Rules run in order; the first decision
 * other than `keep` wins.
 */
export interface BanRule {
  name: string
  /** After a spend was added to `ban.spend`. */
  onSpend?(ban: BanRecord, event: SpendEvent): RuleDecision
  /** On the periodic tick. */
  onTick?(ban: BanRecord, now: number): RuleDecision
}

/** Performs the remote unban; resolves true when Bilibili lifted it (or it was a dry run). */
export type LiftAction = (ban: BanRecord, reason: string) => Promise<boolean>
