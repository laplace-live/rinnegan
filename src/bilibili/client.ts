import type { ApiResult, BilibiliCredentials, NavInfo, RoomInfo, SilentUser } from '@/bilibili/types'

/** `fetch` or anything shaped like it. Bun's `typeof fetch` also demands `fetch.preconnect`, which fakes lack. */
export type FetchLike = (input: string, init: RequestInit) => Response | Promise<Response>

/** How {@link BilibiliClient} reaches Bilibili. */
export interface BilibiliClientOptions {
  /** Called before every authenticated request, so rotated cookies apply without a new client */
  credentials: () => BilibiliCredentials | Promise<BilibiliCredentials>
  fetch?: FetchLike
  /** Desktop Chrome by default */
  userAgent?: string
  /** Per request, ms */
  timeoutMs?: number
}

/** One page of a room's silent-user list. */
export interface SilentUserPage {
  result: ApiResult
  /** Empty when `result.ok` is false */
  users: SilentUser[]
  /** Null when Bilibili doesn't say */
  totalPages: number | null
}

/** {@link ApiResult.code} for a network failure or timeout. */
export const NETWORK_ERROR = -1
/** {@link ApiResult.code} for a body that isn't Bilibili's JSON envelope, e.g. a WAF or risk-control page. */
export const BAD_RESPONSE = -2
/** {@link ApiResult.code} when the `credentials` callback threw. */
export const NO_CREDENTIALS = -3

/** Sent unless {@link BilibiliClientOptions.userAgent} overrides it. */
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_REASON_GRAPHEMES = 60
const DEFAULT_REASON = '独轮车'

const LIVE_ORIGIN = 'https://live.bilibili.com'
const LIVE_API = 'https://api.live.bilibili.com'
const BANNED_API = `${LIVE_API}/xlive/web-ucenter/v1/banned`
const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav'

type FormField = [name: string, value: string | number]

/** Thrown by the client methods that can't return an {@link ApiResult}; carries the failed one. */
export class BilibiliApiError extends Error {
  override readonly name = 'BilibiliApiError'
  readonly result: ApiResult

  constructor(message: string, result: ApiResult) {
    super(message)
    this.result = result
  }
}

/** Bilibili web APIs for room moderation. The silent-user methods never throw: check the returned {@link ApiResult}. */
export class BilibiliClient {
  readonly #credentials: BilibiliClientOptions['credentials']
  readonly #fetch: FetchLike | undefined
  readonly #userAgent: string
  readonly #timeoutMs: number

  constructor(options: BilibiliClientOptions) {
    this.#credentials = options.credentials
    this.#fetch = options.fetch
    this.#userAgent = options.userAgent ?? DEFAULT_USER_AGENT
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** Login state of the current cookies; `isLogin: false` when Bilibili says 未登录, throws on any other failure. */
  async nav(): Promise<NavInfo> {
    const { cookie } = await this.#credentials()
    const result = await this.#send(NAV_URL, { method: 'GET', headers: this.#headers(`${LIVE_ORIGIN}/`, cookie) })
    const data = isRecord(result.data) ? result.data : null
    if (result.ok && data?.isLogin === true) {
      return { isLogin: true, uid: toId(data.mid) ?? 0, uname: toText(data.uname) ?? '' }
    }
    if (result.code === -101 || data?.isLogin === false) return { isLogin: false, uid: 0, uname: '' }
    throw new BilibiliApiError(`获取 Bilibili 登录状态失败：${describeResult(result)}`, result)
  }

  /** Canonical ids for a short or long room id. Needs no cookies; throws when the room can't be resolved. */
  async resolveRoom(id: number): Promise<RoomInfo> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`无效的直播间号：${id}`)
    const result = await this.#send(`${LIVE_API}/room/v1/Room/room_init?id=${id}`, {
      method: 'GET',
      headers: this.#headers(`${LIVE_ORIGIN}/${id}`),
    })
    const data = isRecord(result.data) ? result.data : null
    const roomId = toId(data?.room_id)
    if (!result.ok || roomId === null) {
      throw new BilibiliApiError(`无法解析直播间 ${id}：${describeResult(result)}`, result)
    }
    return { roomId, shortId: toCount(data?.short_id) ?? 0, uid: toId(data?.uid) ?? 0 }
  }

  /** 禁言 `uid` in `roomId` for `hours` (-1 is permanent). The reason goes through {@link normalizeReason}. */
  addSilentUser(roomId: number, uid: number, reason: string, hours = -1): Promise<ApiResult> {
    return this.#post('AddSilentUser', roomId, [
      ['room_id', roomId],
      ['tuid', uid],
      ['msg', normalizeReason(reason)],
      ['mobile_app', 'web'],
      ['type', 1],
      ['hour', hours],
    ])
  }

  /** Lift a 禁言. */
  delSilentUser(roomId: number, uid: number): Promise<ApiResult> {
    // `mobi_app` here but `mobile_app` when banning: that's what Bilibili's own frontend sends
    return this.#post('DelSilentUser', roomId, [
      ['tuid', uid],
      ['room_id', roomId],
      ['mobi_app', 'web'],
    ])
  }

  /** One page (1-based) of the room's 禁言 list. */
  async getSilentUsers(roomId: number, page = 1): Promise<SilentUserPage> {
    // `ps` is the page number, not the page size, in Bilibili's frontend
    const result = await this.#post('GetSilentUserList', roomId, [
      ['room_id', roomId],
      ['ps', page],
    ])
    if (!result.ok) return { result, users: [], totalPages: null }
    return { result, users: parseSilentUsers(result.data), totalPages: parseTotalPages(result.data) }
  }

  /**
   * Every page of the room's 禁言 list, de-duplicated by uid. Stops at the last page, on an empty page, or on a page
   * with nothing new (an API that ignores the page number). Throws {@link BilibiliApiError} on a failed page.
   */
  async getAllSilentUsers(roomId: number, maxPages = 50): Promise<SilentUser[]> {
    const users = new Map<number, SilentUser>()
    for (let page = 1; page <= maxPages; page++) {
      const { result, users: batch, totalPages } = await this.getSilentUsers(roomId, page)
      if (!result.ok) {
        throw new BilibiliApiError(`获取直播间 ${roomId} 禁言列表第 ${page} 页失败：${describeResult(result)}`, result)
      }
      const before = users.size
      for (const user of batch) if (!users.has(user.uid)) users.set(user.uid, user)
      if (users.size === before || (totalPages !== null && page >= totalPages)) break
    }
    return [...users.values()]
  }

  async #post(endpoint: string, roomId: number, fields: FormField[]): Promise<ApiResult> {
    let credentials: BilibiliCredentials
    try {
      credentials = await this.#credentials()
    } catch (error) {
      return failure(NO_CREDENTIALS, `无法获取 Bilibili 登录凭据：${errorMessage(error)}`, 0)
    }
    const { cookie, csrf } = credentials
    const form: FormField[] = [...fields, ['csrf_token', csrf], ['csrf', csrf], ['visit_id', '']]
    return this.#send(`${BANNED_API}/${endpoint}`, {
      method: 'POST',
      headers: this.#headers(`${LIVE_ORIGIN}/${roomId}`, cookie, true),
      // encodeURIComponent, not URLSearchParams: Bilibili's own frontend sends spaces as %20, not +
      body: form.map(([name, value]) => `${name}=${encodeURIComponent(String(value))}`).join('&'),
    })
  }

  async #send(url: string, init: RequestInit): Promise<ApiResult> {
    // Called through a local so the client isn't the receiver
    const fetchImpl: FetchLike = this.#fetch ?? fetch
    let signal: AbortSignal | undefined
    let status = 0
    let text: string
    try {
      signal = AbortSignal.timeout(this.#timeoutMs)
      const response = await fetchImpl(url, { ...init, signal })
      status = response.status
      text = await response.text()
    } catch (error) {
      const message = signal?.aborted ? `请求超时（${this.#timeoutMs} ms）` : `网络错误：${errorMessage(error)}`
      return failure(NETWORK_ERROR, message, status)
    }
    return parseEnvelope(text, status)
  }

  #headers(referer: string, cookie?: string, form = false): Record<string, string> {
    return {
      accept: 'application/json, text/plain, */*',
      ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      Referer: referer,
      Origin: LIVE_ORIGIN,
      'User-Agent': this.#userAgent,
      ...(cookie ? { Cookie: cookie } : {}),
    }
  }
}

const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' })

/**
 * The `msg` actually sent for a ban reason: invisible format characters dropped, whitespace collapsed, trimmed and
 * capped at 60 graphemes; `独轮车` when nothing is left.
 */
export function normalizeReason(reason: string): string {
  const text = reason
    .replace(/\p{Cf}/gu, '')
    .replace(/[\s\p{Cc}]+/gu, ' ')
    .trim()
  let capped = ''
  let count = 0
  for (const { segment } of segmenter.segment(text)) {
    if (count++ === MAX_REASON_GRAPHEMES) break
    capped += segment
  }
  return capped.trimEnd() || DEFAULT_REASON
}

/** Bilibili rejected the cookies (-101 未登录, -111 csrf 校验失败, or HTTP 401/403): refresh credentials and retry. */
export function isAuthFailure(result: ApiResult): boolean {
  if (result.ok) return false
  if (result.code === -101 || result.code === -111) return true
  return (result.status === 401 || result.status === 403) && result.code < 0
}

// Bilibili doesn't document these messages. Both halves must sit in one clause at most three characters apart, and
// permission or inability wording ("没有权限禁言", "未被授权", "无法禁言") never counts.
const CLAUSE_GAP = '[^，。；：,.;:!！?？]{0,3}'
const PERMISSION_DENIED = /权限|授权|允许|无法|不能/
const ALREADY_BANNED = new RegExp(`(?:已经|已被|已在|重复)${CLAUSE_GAP}禁言|禁言${CLAUSE_GAP}已存在`)
const NOT_BANNED = new RegExp(
  `(?:不在|未在|未被|没有|没被|未找到|找不到)${CLAUSE_GAP}禁言|禁言${CLAUSE_GAP}(?:不存在|已解除|已过期)`
)

/** Heuristic: a failed ban whose message says the user is already silenced, e.g. `该用户已经被禁言`. */
export function isAlreadyBanned(result: ApiResult): boolean {
  return !result.ok && !PERMISSION_DENIED.test(result.message) && ALREADY_BANNED.test(result.message)
}

/** Heuristic: a failed unban whose message says the user isn't silenced, e.g. `该用户未被禁言`. */
export function isNotBanned(result: ApiResult): boolean {
  return !result.ok && !PERMISSION_DENIED.test(result.message) && NOT_BANNED.test(result.message)
}

/** One-line description of a failed result for logs, e.g. `账号未登录（code -101）`. */
export function describeResult(result: ApiResult): string {
  const http = result.status !== 0 && (result.status < 200 || result.status >= 300) ? `，HTTP ${result.status}` : ''
  return `${result.message || '未知错误'}（code ${result.code}${http}）`
}

function failure(code: number, message: string, status: number): ApiResult {
  return { ok: false, code, message, data: null, status }
}

function parseEnvelope(text: string, status: number): ApiResult {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return failure(BAD_RESPONSE, '响应不是 JSON，可能被风控或防火墙拦截', status)
  }
  const code = isRecord(body) ? toNumber(body.code) : null
  if (!isRecord(body) || code === null) {
    return failure(BAD_RESPONSE, '响应缺少 code 字段，不是 Bilibili API 的格式', status)
  }
  const ok = code === 0 && status >= 200 && status < 300
  return { ok, code, message: toText(body.message) ?? toText(body.msg) ?? '', data: body.data ?? null, status }
}

// GetSilentUserList isn't documented, so every field is optional and items without a usable uid are skipped
function parseSilentUsers(data: unknown): SilentUser[] {
  const items = Array.isArray(data)
    ? data
    : isRecord(data)
      ? [data.data, data.list, data.items].find(value => Array.isArray(value))
      : undefined
  if (!Array.isArray(items)) return []
  const users: SilentUser[] = []
  for (const raw of items) {
    const user = parseSilentUser(raw)
    if (user) users.push(user)
  }
  return users
}

function parseSilentUser(raw: unknown): SilentUser | null {
  if (!isRecord(raw)) return null
  // With `tuid`/`tname` for the target, `uid`/`name` are the operator; never fall back from a present `tuid`
  const uid = toId(raw.tuid ?? raw.uid)
  if (uid === null) return null
  const hasTarget = raw.tname !== undefined && raw.tname !== null
  const remaining = toNumber(raw.left_time ?? raw.remain_time)
  return {
    uid,
    uname: toText(raw.tname ?? raw.uname ?? raw.name) ?? '',
    operatorName: toText(raw.admin_name ?? raw.operator_name ?? (hasTarget ? raw.name : null)) || null,
    createdAt: toTimestamp(raw.ctime ?? raw.created_at),
    remainingSec: remaining !== null && remaining > 0 ? remaining : null,
    raw,
  }
}

function parseTotalPages(data: unknown): number | null {
  if (!isRecord(data)) return null
  const page: Record<string, unknown> = isRecord(data.page) ? data.page : {}
  const explicit = toCount(data.total_page ?? page.total_page)
  if (explicit !== null) return explicit
  const total = toCount(data.total ?? page.total)
  const size = toCount(data.page_size ?? page.page_size)
  return total !== null && size ? Math.ceil(total / size) : null
}

/** Bilibili's own string as-is; unix seconds or ms become `YYYY-MM-DD HH:mm:ss` in Beijing time. */
function toTimestamp(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  const n = toNumber(value)
  if (n === null || n <= 0) return null
  const date = new Date((n < 1e12 ? n * 1000 : n) + 8 * 3_600_000)
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 19).replace('T', ' ')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Finite number from a number or a numeric string. */
function toNumber(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

/** Positive safe integer, e.g. a uid or room id. */
function toId(value: unknown): number | null {
  const n = toNumber(value)
  return n !== null && Number.isSafeInteger(n) && n > 0 ? n : null
}

function toCount(value: unknown): number | null {
  const n = toNumber(value)
  return n !== null && Number.isSafeInteger(n) && n >= 0 ? n : null
}

function toText(value: unknown): string | null {
  if (typeof value === 'string') return value
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
