import type { BanPatch, BanRecord, BanStatus } from '@/store/types'

/** A database row keyed by column name. */
export type Row = Record<string, unknown>

/** SQL value as bound by `bun:sqlite` and `Bun.SQL`. */
export type SqlValue = string | number | null

/** BanRecord field → SQL column, shared by the SQLite and Postgres schemas. */
export const SQL_COLUMNS = {
  id: 'id',
  roomId: 'room_id',
  uid: 'uid',
  uname: 'uname',
  reason: 'reason',
  score: 'score',
  pattern: 'pattern',
  evidence: 'evidence',
  createdAt: 'created_at',
  expiresAt: 'expires_at',
  hours: 'hours',
  status: 'status',
  liftedAt: 'lifted_at',
  liftReason: 'lift_reason',
  spend: 'spend',
  operatorUid: 'operator_uid',
  meta: 'meta',
} as const satisfies { [K in keyof BanRecord]-?: string }

/** Fields stored as JSON text. */
export const JSON_FIELDS: ReadonlySet<string> = new Set(['evidence', 'meta'])

const PATCH_FIELDS = [
  'uname',
  'reason',
  'score',
  'pattern',
  'evidence',
  'expiresAt',
  'hours',
  'status',
  'liftedAt',
  'liftReason',
  'spend',
  'operatorUid',
  'meta',
] as const satisfies readonly (keyof BanPatch)[]

/** Default page size of `BanStore.list`. */
export const DEFAULT_LIST_LIMIT = 100

/** `record` in canonical field order with unknown keys dropped and missing nullables set to null; JSON fields are shared. */
export function normalizeRecord(record: BanRecord): BanRecord {
  return {
    id: record.id,
    roomId: record.roomId,
    uid: record.uid,
    uname: record.uname,
    reason: record.reason,
    score: record.score,
    pattern: record.pattern,
    evidence: record.evidence ?? null,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt ?? null,
    hours: record.hours,
    status: record.status,
    liftedAt: record.liftedAt ?? null,
    liftReason: record.liftReason ?? null,
    spend: record.spend ?? 0,
    operatorUid: record.operatorUid ?? null,
    meta: record.meta ?? {},
  }
}

/** Deep copy with JSON semantics for `evidence`/`meta`, so it matches what the persistent backends return. */
export function cloneRecord(record: BanRecord): BanRecord {
  const ban = normalizeRecord(record)
  return { ...ban, evidence: jsonClone(ban.evidence), meta: (jsonClone(ban.meta) ?? {}) as Record<string, unknown> }
}

/** JSON text of `value`; `undefined` and other unserializable values become `null`. */
export function toJson(value: unknown): string {
  return JSON.stringify(value) ?? 'null'
}

function jsonClone(value: unknown): unknown {
  return JSON.parse(toJson(value))
}

/** `patch` limited to patchable fields with `undefined` values dropped; both mean "leave unchanged". */
export function cleanPatch(patch: BanPatch): BanPatch {
  return Object.fromEntries(PATCH_FIELDS.filter(key => patch[key] !== undefined).map(key => [key, patch[key]]))
}

/** Clamps a `list` limit to a non-negative integer. */
export function resolveLimit(limit: number = DEFAULT_LIST_LIMIT): number {
  if (Number.isNaN(limit)) return DEFAULT_LIST_LIMIT
  return Math.min(Math.max(0, Math.trunc(limit)), Number.MAX_SAFE_INTEGER)
}

/** Rejects amounts that would poison `spend`. */
export function assertAmount(amount: number): void {
  if (!Number.isFinite(amount)) throw new TypeError(`spend amount must be a finite number, got ${amount}`)
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Newest first, ties by id descending: the order of `ORDER BY created_at DESC, id DESC` and Redis `ZREVRANGE`. */
export function newestFirst(a: BanRecord, b: BanRecord): number {
  return b.createdAt - a.createdAt || compareIds(b.id, a.id)
}

/** Soonest expiry first, ties by id: the order of `ORDER BY expires_at, id` and Redis `ZRANGEBYSCORE`. */
export function soonestDue(a: BanRecord, b: BanRecord): number {
  return (a.expiresAt ?? 0) - (b.expiresAt ?? 0) || compareIds(a.id, b.id)
}

/** Column → SQL value for the given fields, JSON fields as text; `undefined` values are skipped. */
export function toColumns(fields: Partial<BanRecord>): Record<string, SqlValue> {
  const row: Record<string, SqlValue> = {}
  for (const [key, value] of Object.entries(fields)) {
    const column = SQL_COLUMNS[key as keyof BanRecord]
    if (column === undefined || value === undefined) continue
    row[column] = JSON_FIELDS.has(key) ? toJson(value) : (value as SqlValue)
  }
  return row
}

/** Decodes a row whose JSON columns are text and whose BIGINTs may be strings. */
export function fromRow(row: Row): BanRecord {
  return {
    id: String(row.id),
    roomId: Number(row.room_id),
    uid: Number(row.uid),
    uname: String(row.uname),
    reason: String(row.reason),
    score: Number(row.score),
    pattern: String(row.pattern),
    evidence: parseJson(row.evidence),
    createdAt: Number(row.created_at),
    expiresAt: nullableNumber(row.expires_at),
    hours: Number(row.hours),
    status: String(row.status) as BanStatus,
    liftedAt: nullableNumber(row.lifted_at),
    liftReason: row.lift_reason == null ? null : String(row.lift_reason),
    spend: Number(row.spend),
    operatorUid: nullableNumber(row.operator_uid),
    meta: (parseJson(row.meta) ?? {}) as Record<string, unknown>,
  }
}

function nullableNumber(value: unknown): number | null {
  return value == null ? null : Number(value)
}

function parseJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : (value ?? null)
}
