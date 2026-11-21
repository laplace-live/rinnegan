import { SQL } from 'bun'

import type { Row } from '@/store/record'
import type { BanPatch, BanRecord, BanStore } from '@/store/types'

import {
  assertAmount,
  cleanPatch,
  fromRow,
  JSON_FIELDS,
  normalizeRecord,
  resolveLimit,
  SQL_COLUMNS,
} from '@/store/record'

const DEFAULT_TABLE = 'rinnegan_bans'

export interface PostgresBanStoreOptions {
  /** Table name, a lowercase identifier of at most 47 characters; defaults to `rinnegan_bans` */
  table?: string
}

/** Ban records in PostgreSQL through `Bun.SQL`. */
export class PostgresBanStore implements BanStore {
  readonly kind = 'postgres'
  readonly table: string
  readonly #sql: SQL

  constructor(url: string, options: PostgresBanStoreOptions = {}) {
    const table = options.table ?? DEFAULT_TABLE
    // 47 leaves room for the index-name suffixes within Postgres' 63-byte identifier limit
    if (!/^[a-z_][a-z0-9_]{0,46}$/.test(table)) throw new Error(`invalid Postgres table name: ${table}`)
    this.table = table
    this.#sql = new SQL(url)
  }

  async init(): Promise<void> {
    const sql = this.#sql
    await sql`
      CREATE TABLE IF NOT EXISTS ${this.#table} (
        id TEXT PRIMARY KEY,
        room_id BIGINT NOT NULL,
        uid BIGINT NOT NULL,
        uname TEXT NOT NULL,
        reason TEXT NOT NULL,
        score DOUBLE PRECISION NOT NULL,
        pattern TEXT NOT NULL,
        evidence JSONB NOT NULL DEFAULT 'null',
        created_at BIGINT NOT NULL,
        expires_at BIGINT,
        hours INTEGER NOT NULL,
        status TEXT NOT NULL,
        lifted_at BIGINT,
        lift_reason TEXT,
        spend DOUBLE PRECISION NOT NULL DEFAULT 0,
        operator_uid BIGINT,
        meta JSONB NOT NULL DEFAULT '{}'
      )
    `
    await sql`CREATE INDEX IF NOT EXISTS ${sql(`${this.table}_room_uid_status`)} ON ${this.#table} (room_id, uid, status)`
    await sql`CREATE INDEX IF NOT EXISTS ${sql(`${this.table}_status_expires`)} ON ${this.#table} (status, expires_at)`
  }

  async add(record: BanRecord): Promise<void> {
    const ban = normalizeRecord(record)
    await this.#sql`
      INSERT INTO ${this.#table} (id, room_id, uid, uname, reason, score, pattern, evidence, created_at, expires_at, hours,
        status, lifted_at, lift_reason, spend, operator_uid, meta)
      VALUES (${ban.id}, ${ban.roomId}, ${ban.uid}, ${ban.uname}, ${ban.reason}, ${ban.score}, ${ban.pattern},
        ${pgJson(ban.evidence)}::text::jsonb, ${ban.createdAt}, ${ban.expiresAt}, ${ban.hours}, ${ban.status},
        ${ban.liftedAt}, ${ban.liftReason}, ${ban.spend}, ${ban.operatorUid}, ${pgJson(ban.meta)}::text::jsonb)
    `
  }

  async get(id: string): Promise<BanRecord | null> {
    return first(await this.#sql<Row[]>`SELECT ${this.#columns} FROM ${this.#table} WHERE id = ${id}`)
  }

  async findActive(roomId: number, uid: number): Promise<BanRecord | null> {
    return first(
      await this.#sql<Row[]>`
        SELECT ${this.#columns} FROM ${this.#table}
        WHERE room_id = ${roomId} AND uid = ${uid} AND status = 'active'
        ${this.#newest} LIMIT 1
      `
    )
  }

  async listActive(roomId?: number): Promise<BanRecord[]> {
    const sql = this.#sql
    const room = roomId === undefined ? sql`` : sql`AND room_id = ${roomId}`
    const rows = await sql<Row[]>`
      SELECT ${this.#columns} FROM ${this.#table} WHERE status = 'active' ${room} ${this.#newest}
    `
    return rows.map(fromRow)
  }

  async list(options: { roomId?: number; limit?: number } = {}): Promise<BanRecord[]> {
    const sql = this.#sql
    const { roomId } = options
    const room = roomId === undefined ? sql`` : sql`WHERE room_id = ${roomId}`
    const rows = await sql<Row[]>`
      SELECT ${this.#columns} FROM ${this.#table} ${room} ${this.#newest} LIMIT ${resolveLimit(options.limit)}
    `
    return rows.map(fromRow)
  }

  async listDue(now: number): Promise<BanRecord[]> {
    const rows = await this.#sql<Row[]>`
      SELECT ${this.#columns} FROM ${this.#table}
      WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ${now}
      ORDER BY expires_at, id COLLATE "C"
    `
    return rows.map(fromRow)
  }

  async update(id: string, patch: BanPatch): Promise<BanRecord | null> {
    const sql = this.#sql
    const assignments = Object.entries(cleanPatch(patch)).map(([field, value]) => {
      const column = sql(SQL_COLUMNS[field as keyof BanPatch])
      return JSON_FIELDS.has(field) ? sql`${column} = ${pgJson(value)}::text::jsonb` : sql`${column} = ${value}`
    })
    if (assignments.length === 0) return this.get(id)
    const set = assignments.reduce((list, assignment) => sql`${list}, ${assignment}`)
    return first(await sql<Row[]>`UPDATE ${this.#table} SET ${set} WHERE id = ${id} RETURNING ${this.#columns}`)
  }

  async addSpend(roomId: number, uid: number, amount: number): Promise<BanRecord | null> {
    assertAmount(amount)
    // The row lock makes concurrent calls re-read `spend` and re-check `status`, so no increment is lost
    return first(
      await this.#sql<Row[]>`
        UPDATE ${this.#table} SET spend = spend + ${amount}
        WHERE status = 'active' AND id = (
          SELECT id FROM ${this.#table}
          WHERE room_id = ${roomId} AND uid = ${uid} AND status = 'active'
          ${this.#newest} LIMIT 1
        )
        RETURNING ${this.#columns}
      `
    )
  }

  async close(): Promise<void> {
    await this.#sql.close()
  }

  get #table() {
    return this.#sql(this.table)
  }

  /** JSONB read back as text so decoding never depends on the driver's JSON handling. */
  get #columns() {
    return this.#sql`
      id, room_id, uid, uname, reason, score, pattern, evidence::text AS evidence, created_at, expires_at, hours, status,
      lifted_at, lift_reason, spend, operator_uid, meta::text AS meta
    `
  }

  /** `C` collation so ties break bytewise, like the other backends. */
  get #newest() {
    return this.#sql`ORDER BY created_at DESC, id COLLATE "C" DESC`
  }
}

/** JSON text for a `::text::jsonb` cast; U+0000 becomes U+FFFD since Postgres text and JSONB cannot hold it. */
function pgJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === 'string' ? v.replaceAll('\u0000', '\uFFFD') : v)) ?? 'null'
}

function first(rows: Row[]): BanRecord | null {
  const [row] = rows
  return row ? fromRow(row) : null
}
