import { appendFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { localDate } from '@/util/console'

/** Keys never written to disk, however deep they sit in an entry. */
const SECRET_KEYS =
  /^(cookie|cookies|csrf|csrf_token|bili_jct|sessdata|token|apikey|api_key|authkey|auth_key|password)$/i

/** Deep copy with secret-looking keys replaced, so a careless caller can't leak credentials into the log. */
export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(item => scrub(item, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_KEYS.test(key) ? '[redacted]' : scrub(item, depth + 1)
  }
  return out
}

export interface AuditLogOptions {
  dir: string
  /** `live`, `offline`, `bans`, `unban` … recorded on every entry */
  mode: string
  sessionId?: string
  now?: () => number
}

/**
 * Append-only JSONL audit trail, one file per local day (`audit-2026-10-21.jsonl`). Each entry is written
 * synchronously so a crash never loses the record of a ban that went out.
 */
export class AuditLog {
  readonly dir: string
  readonly mode: string
  readonly sessionId: string
  readonly #now: () => number

  constructor(options: AuditLogOptions) {
    this.dir = options.dir
    this.mode = options.mode
    this.sessionId = options.sessionId ?? crypto.randomUUID()
    this.#now = options.now ?? Date.now
    mkdirSync(this.dir, { recursive: true })
  }

  /** File the next entry goes to. */
  get path(): string {
    return join(this.dir, `audit-${localDate(this.#now())}.jsonl`)
  }

  write(event: string, data: Record<string, unknown> = {}): void {
    const at = this.#now()
    const entry = {
      ts: new Date(at).toISOString(),
      session: this.sessionId,
      mode: this.mode,
      event,
      ...(scrub(data) as Record<string, unknown>),
    }
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`)
  }
}

const AUDIT_FILE = /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/

/** Audit files in `dir`, oldest day first; none when the directory doesn't exist. */
export function listAuditFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter(name => AUDIT_FILE.test(name))
      .sort()
      .map(name => join(dir, name))
  } catch {
    return []
  }
}

/** Read entries back (for `unban --session` and tests). */
export async function readAuditEntries(path: string): Promise<Record<string, unknown>[]> {
  const file = Bun.file(path)
  if (!(await file.exists())) return []
  const entries: Record<string, unknown>[] = []
  for (const line of (await file.text()).split('\n')) {
    if (!line.trim()) continue
    try {
      entries.push(JSON.parse(line))
    } catch {
      // A torn final line from a crash is skipped rather than failing the whole read.
    }
  }
  return entries
}
