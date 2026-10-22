import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import type { Row, SqlValue } from '@/store/record'
import type { BanPatch, BanRecord, BanStore } from '@/store/types'

import {
  assertAmount,
  cleanPatch,
  fromRow,
  normalizeRecord,
  resolveLimit,
  SQL_COLUMNS,
  toColumns,
} from '@/store/record'

type Params = Record<string, SqlValue>

const TABLE = 'rinnegan_bans'
const NEWEST = 'ORDER BY created_at DESC, id DESC'
const COLUMNS = Object.values(SQL_COLUMNS)

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ${TABLE} (
    id TEXT PRIMARY KEY,
    room_id INTEGER NOT NULL,
    uid INTEGER NOT NULL,
    uname TEXT NOT NULL,
    reason TEXT NOT NULL,
    score REAL NOT NULL,
    pattern TEXT NOT NULL,
    evidence TEXT NOT NULL DEFAULT 'null',
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    hours INTEGER NOT NULL,
    status TEXT NOT NULL,
    lifted_at INTEGER,
    lift_reason TEXT,
    spend REAL NOT NULL DEFAULT 0,
    operator_uid INTEGER,
    meta TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE INDEX IF NOT EXISTS ${TABLE}_room_uid_status ON ${TABLE} (room_id, uid, status)`,
  `CREATE INDEX IF NOT EXISTS ${TABLE}_status_expires ON ${TABLE} (status, expires_at)`,
]

const QUERIES = {
  insert: `INSERT INTO ${TABLE} (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(column => `$${column}`).join(', ')})`,
  get: `SELECT * FROM ${TABLE} WHERE id = $id`,
  findActive: `SELECT * FROM ${TABLE} WHERE room_id = $roomId AND uid = $uid AND status = 'active' ${NEWEST} LIMIT 1`,
  listActive: `SELECT * FROM ${TABLE} WHERE status = 'active' ${NEWEST}`,
  listActiveInRoom: `SELECT * FROM ${TABLE} WHERE status = 'active' AND room_id = $roomId ${NEWEST}`,
  list: `SELECT * FROM ${TABLE} ${NEWEST} LIMIT $limit`,
  listInRoom: `SELECT * FROM ${TABLE} WHERE room_id = $roomId ${NEWEST} LIMIT $limit`,
  listDue: `SELECT * FROM ${TABLE}
    WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= $now
    ORDER BY expires_at, id`,
  // One statement, so the lookup and the increment cannot interleave with another writer
  addSpend: `UPDATE ${TABLE} SET spend = spend + $amount WHERE id = (
    SELECT id FROM ${TABLE} WHERE room_id = $roomId AND uid = $uid AND status = 'active' ${NEWEST} LIMIT 1
  ) RETURNING *`,
}

/** Ban records in a local SQLite database (WAL mode). */
export class SqliteBanStore implements BanStore {
  readonly kind = 'sqlite'
  readonly path: string
  readonly #db: Database

  /** @param path Database file, created with its directory when missing; `:memory:` for a throwaway database */
  constructor(path: string) {
    this.path = path
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.#db = new Database(path, { create: true, strict: true })
  }

  async init(): Promise<void> {
    this.#db.run('PRAGMA journal_mode = WAL')
    this.#db.run('PRAGMA busy_timeout = 5000')
    for (const statement of SCHEMA) this.#db.run(statement)
  }

  async add(record: BanRecord): Promise<void> {
    this.#db.query(QUERIES.insert).run(toColumns(normalizeRecord(record)))
  }

  async get(id: string): Promise<BanRecord | null> {
    return this.#one(QUERIES.get, { id })
  }

  async findActive(roomId: number, uid: number): Promise<BanRecord | null> {
    return this.#one(QUERIES.findActive, { roomId, uid })
  }

  async listActive(roomId?: number): Promise<BanRecord[]> {
    return roomId === undefined ? this.#all(QUERIES.listActive, {}) : this.#all(QUERIES.listActiveInRoom, { roomId })
  }

  async list(options: { roomId?: number; limit?: number } = {}): Promise<BanRecord[]> {
    const { roomId } = options
    const limit = resolveLimit(options.limit)
    return roomId === undefined ? this.#all(QUERIES.list, { limit }) : this.#all(QUERIES.listInRoom, { roomId, limit })
  }

  async listDue(now: number): Promise<BanRecord[]> {
    return this.#all(QUERIES.listDue, { now })
  }

  async update(id: string, patch: BanPatch): Promise<BanRecord | null> {
    const row = toColumns(cleanPatch(patch))
    const columns = Object.keys(row)
    if (columns.length === 0) return this.get(id)
    // Column names come from SQL_COLUMNS, never from the caller
    const assignments = columns.map(column => `${column} = $${column}`).join(', ')
    return this.#one(`UPDATE ${TABLE} SET ${assignments} WHERE id = $id RETURNING *`, { ...row, id })
  }

  async addSpend(roomId: number, uid: number, amount: number): Promise<BanRecord | null> {
    assertAmount(amount)
    return this.#one(QUERIES.addSpend, { amount, roomId, uid })
  }

  async close(): Promise<void> {
    this.#db.close()
  }

  #one(sql: string, params: Params): BanRecord | null {
    const row = this.#db.query<Row, Params>(sql).get(params)
    return row ? fromRow(row) : null
  }

  #all(sql: string, params: Params): BanRecord[] {
    return this.#db.query<Row, Params>(sql).all(params).map(fromRow)
  }
}
