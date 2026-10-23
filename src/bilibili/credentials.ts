import type {
  LoginSyncClientOptions,
  LoginSyncCookie,
  LoginSyncError,
  LoginSyncPayload,
} from '@laplace.live/login-sync'
import { isLoginSyncError, LoginSyncClient, parseToken } from '@laplace.live/login-sync'

import type { BilibiliCredentials } from '@/bilibili/types'
import type { FetchLike } from '@/util/fetch'

/** Where and how to pull a LAPLACE Login Sync blob. */
export interface LoadCredentialsOptions {
  /** `uuid@password` as the LAPLACE Login Sync extension shows it */
  token: string
  /** Sync server; the SDK's public one by default */
  baseURL?: string
  /** For a server in private mode */
  authKey?: string
  /** Sent with every request, e.g. a token for a firewall in front of the server */
  headers?: LoginSyncClientOptions['headers']
  fetch?: FetchLike
  signal?: AbortSignal
}

/** {@link LoadCredentialsOptions} plus caching; each pull gets its own timeout instead of a signal. */
export interface CredentialProviderOptions extends Omit<LoadCredentialsOptions, 'signal'> {
  /** How long a pull is reused, ms */
  ttlMs?: number
  /** Per pull, ms */
  timeoutMs?: number
  /** Called when a refresh fails and the previous credentials are served instead */
  onStale?: (error: unknown) => void
}

/** What's safe to log about {@link BilibiliCredentials}. */
export interface CredentialSummary {
  uid: number | null
  /** Cookies in the header */
  cookies: number
  /** First and last two characters of `bili_jct`, e.g. `ab…yz` */
  csrfPreview: string
}

const DEFAULT_TTL_MS = 30 * 60_000
const DEFAULT_PULL_TIMEOUT_MS = 10_000
const STALE_RETRY_MS = 60_000
const REQUIRED_COOKIES = ['SESSDATA', 'bili_jct'] as const

/** Pull the login-sync blob for `token` and build Bilibili credentials. Errors are Chinese and never carry secrets. */
export async function loadCredentials(options: LoadCredentialsOptions): Promise<BilibiliCredentials> {
  let client: LoginSyncClient
  try {
    client = new LoginSyncClient({
      baseURL: options.baseURL,
      authKey: options.authKey,
      headers: options.headers,
      fetch: options.fetch,
    })
  } catch (cause) {
    throw new Error(`登录同步服务器地址无效：${options.baseURL}`, { cause })
  }
  let payload: LoginSyncPayload
  try {
    payload = (await client.pull(parseToken(options.token), { signal: options.signal })).payload
  } catch (error) {
    if (isLoginSyncError(error)) throw new Error(describeLoginSyncError(error, client.baseURL), { cause: error })
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(`登录同步服务器 ${client.baseURL} 响应超时`, { cause: error })
    }
    throw error
  }
  return credentialsFromPayload(payload)
}

/**
 * Credentials from a decrypted login-sync payload. Takes every unexpired cookie for bilibili.com or a subdomain; for a
 * repeated name the `.bilibili.com` copy wins, then the later expiry. Throws in Chinese without SESSDATA or bili_jct.
 * @param now Unix ms
 */
export function credentialsFromPayload(payload: LoginSyncPayload, now = Date.now()): BilibiliCredentials {
  const cookies = new Map<string, LoginSyncCookie>()
  const expired = new Set<string>()
  for (const [key, entries] of Object.entries(payload.cookie_data)) {
    const keyMatches = isBilibiliDomain(key)
    for (const cookie of entries) {
      if (!isUsable(cookie) || (!keyMatches && !isBilibiliDomain(cookie.domain))) continue
      if (typeof cookie.expirationDate === 'number' && cookie.expirationDate * 1000 < now) {
        expired.add(cookie.name)
        continue
      }
      const current = cookies.get(cookie.name)
      if (!current || isPreferred(cookie, current)) cookies.set(cookie.name, cookie)
    }
  }

  const problems = REQUIRED_COOKIES.filter(name => !cookies.get(name)?.value).map(name =>
    expired.has(name) ? `${name} 已过期` : `缺少 ${name}`
  )
  if (problems.length > 0) {
    throw new Error(
      `登录同步数据中的 Bilibili Cookie 不可用：${problems.join('，')}。请在浏览器登录 bilibili.com 后用 LAPLACE Login Sync 重新同步`
    )
  }

  const uid = cookies.get('DedeUserID')?.value ?? ''
  return {
    cookie: [...cookies.values()].map(cookie => `${cookie.name}=${cookie.value}`).join('; '),
    csrf: cookies.get('bili_jct')?.value ?? '',
    uid: /^[1-9]\d*$/.test(uid) && Number.isSafeInteger(Number(uid)) ? Number(uid) : null,
  }
}

/** Log-safe view of credentials: never a cookie or the full csrf. */
export function credentialSummary(credentials: BilibiliCredentials): CredentialSummary {
  const { csrf } = credentials
  return {
    uid: credentials.uid,
    cookies: credentials.cookie.split(';').filter(pair => pair.includes('=')).length,
    csrfPreview: csrf.length >= 8 ? `${csrf.slice(0, 2)}…${csrf.slice(-2)}` : csrf ? '…' : '',
  }
}

/**
 * Login-sync credentials cached for `ttlMs` (30 min by default); hand `() => provider.get()` to the client. A failed
 * refresh keeps serving the previous credentials, retrying a minute later, until `invalidate()` drops them.
 */
export class CredentialProvider {
  readonly #load: Omit<LoadCredentialsOptions, 'signal'>
  readonly #ttlMs: number
  readonly #timeoutMs: number
  readonly #onStale: ((error: unknown) => void) | undefined
  #value: BilibiliCredentials | null = null
  #expiresAt = 0
  #pending: Promise<BilibiliCredentials> | null = null
  /** Bumped by `invalidate()` so pulls started earlier can't repopulate the cache */
  #generation = 0

  constructor(options: CredentialProviderOptions) {
    const { ttlMs = DEFAULT_TTL_MS, timeoutMs = DEFAULT_PULL_TIMEOUT_MS, onStale, ...load } = options
    this.#load = load
    this.#ttlMs = ttlMs
    this.#timeoutMs = timeoutMs
    this.#onStale = onStale
  }

  /** Cached credentials, pulled again once the TTL lapses or after `invalidate()`; concurrent calls share a pull. */
  get(): Promise<BilibiliCredentials> {
    if (this.#value && Date.now() < this.#expiresAt) return Promise.resolve(this.#value)
    if (!this.#pending) {
      const pending = this.#refresh(this.#generation)
      const settle = () => {
        if (this.#pending === pending) this.#pending = null
      }
      pending.then(settle, settle)
      this.#pending = pending
    }
    return this.#pending
  }

  /** Forget the cached credentials, e.g. after Bilibili rejected them; the next `get()` pulls again. */
  invalidate(): void {
    this.#generation++
    this.#value = null
    this.#expiresAt = 0
    this.#pending = null
  }

  async #refresh(generation: number): Promise<BilibiliCredentials> {
    try {
      const value = await loadCredentials({ ...this.#load, signal: AbortSignal.timeout(this.#timeoutMs) })
      if (generation === this.#generation) {
        this.#value = value
        this.#expiresAt = Date.now() + this.#ttlMs
      }
      return value
    } catch (error) {
      const stale = generation === this.#generation ? this.#value : null
      if (!stale) throw error
      this.#expiresAt = Date.now() + Math.min(STALE_RETRY_MS, this.#ttlMs)
      this.#onStale?.(error)
      return stale
    }
  }
}

function describeLoginSyncError(error: LoginSyncError, baseURL: string): string {
  switch (error.code) {
    case 'invalid_token':
      return '登录同步令牌无效：应为扩展显示的 uuid@password'
    case 'not_found':
      return `登录同步服务器 ${baseURL} 上没有这个令牌的数据，请在 LAPLACE Login Sync 扩展里重新同步`
    case 'bad_credentials':
      return '登录同步令牌无法解密数据：密码不对，或数据已损坏'
    case 'unauthorized':
      return `登录同步服务器 ${baseURL} 处于私有模式，auth key 缺失或错误`
    case 'network_error':
      return `无法连接登录同步服务器 ${baseURL}`
    case 'server_error':
      return `登录同步服务器 ${baseURL} 返回错误（HTTP ${error.status ?? '未知'}）${error.status === 403 ? '，可能被防火墙拦截' : ''}`
    case 'malformed':
      return '登录同步数据格式无效'
    case 'unsupported_version':
      return '登录同步数据的协议版本比当前 SDK 新，请升级 @laplace.live/login-sync'
    default:
      return `登录同步失败：${error.message}`
  }
}

function isBilibiliDomain(domain: unknown): boolean {
  if (typeof domain !== 'string') return false
  const host = domain.trim().toLowerCase().replace(/^\./, '')
  return host === 'bilibili.com' || host.endsWith('.bilibili.com')
}

// The SDK only checks that cookies are objects; a name or value that breaks the header would fail every request
function isUsable(cookie: LoginSyncCookie): boolean {
  return (
    typeof cookie.name === 'string' &&
    typeof cookie.value === 'string' &&
    /^[^\s;,=]+$/.test(cookie.name) &&
    !/[;\r\n]/.test(cookie.value)
  )
}

function isPreferred(candidate: LoginSyncCookie, current: LoginSyncCookie): boolean {
  const candidateRoot = candidate.domain === '.bilibili.com'
  if (candidateRoot !== (current.domain === '.bilibili.com')) return candidateRoot
  return expiry(candidate) > expiry(current)
}

/** Session cookies have no expiry and count as the latest. */
function expiry(cookie: LoginSyncCookie): number {
  return typeof cookie.expirationDate === 'number' ? cookie.expirationDate : Number.POSITIVE_INFINITY
}
