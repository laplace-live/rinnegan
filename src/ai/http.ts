/** OpenRouter app attribution; harmless for other hosts. */
export const ATTRIBUTION_HEADERS: Readonly<Record<string, string>> = {
  'HTTP-Referer': 'https://github.com/laplace-live/rinnegan',
  'X-Title': 'LAPLACE Rinnegan',
  'X-OpenRouter-Title': 'LAPLACE Rinnegan',
}

// Only the default hosts require a key; custom bases may be keyless local services.
const KEY_REQUIRED_HOSTS = new Set(['api.typesafe.ai', 'openrouter.ai'])
const SNIPPET_LENGTH = 200

/** Any non-null object, arrays included. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Reads `value[k0][k1]…` off untyped data; undefined once a hop isn't an object. */
export function readPath(value: unknown, ...keys: string[]): unknown {
  let current = value
  for (const key of keys) {
    if (!isRecord(current)) return undefined
    current = current[key]
  }
  return current
}

/** `text` with every occurrence of `secret` masked. */
export function redact(text: string, secret: string): string {
  return secret ? text.replaceAll(secret, '***') : text
}

/** Why `apiBase` + `apiKey` can't be called, or null; `service` names the API in the hint, e.g. `决策模型`. */
export function describeEndpointGap(service: string, apiBase: string, apiKey: string): string | null {
  const trimmed = apiBase.trim()
  if (!trimmed) return `请填写${service} API 地址`
  let base: URL
  try {
    base = new URL(trimmed)
  } catch {
    return `${service} API 地址格式无效`
  }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    return `${service} API 地址须为不含认证信息、查询参数或片段的 HTTP(S) 地址`
  }
  if (KEY_REQUIRED_HOSTS.has(base.hostname) && !apiKey.trim()) return `请填写${service} API Key`
  return null
}

/** Non-2xx reply; `snippet` is the start of the body with the API key masked. */
export class HttpStatusError extends Error {
  readonly status: number
  readonly snippet: string

  constructor(service: string, status: number, statusText: string, snippet: string) {
    super(`${service}请求失败：HTTP ${status}${statusText ? ` ${statusText}` : ''}${snippet ? `: ${snippet}` : ''}`)
    this.name = 'HttpStatusError'
    this.status = status
    this.snippet = snippet
  }
}

export interface PostJsonOptions {
  /** Names the API in error messages, e.g. `决策模型` */
  service: string
  url: string
  /** Sent as a bearer token unless blank */
  apiKey: string
  body: unknown
  timeoutMs: number
  signal?: AbortSignal
  fetch?: typeof fetch
}

function snippetOf(text: string, apiKey: string): string {
  // Mask before cutting so a key straddling the cut can't leak.
  return redact(text, apiKey).slice(0, 1000).replace(/\s+/g, ' ').trim().slice(0, SNIPPET_LENGTH)
}

/**
 * POST `body` as JSON and parse the JSON reply. Errors are readable and never contain the key; when the caller's
 * signal aborts, its reason is rethrown untouched.
 */
export async function postJson(options: PostJsonOptions): Promise<unknown> {
  const { service, url, body, timeoutMs, signal } = options
  const apiKey = options.apiKey.trim()
  signal?.throwIfAborted()
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...ATTRIBUTION_HEADERS,
  }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  const timeout = AbortSignal.timeout(timeoutMs)
  const failure = (err: unknown): unknown => {
    if (signal?.aborted) return signal.reason
    if (timeout.aborted) return new Error(`${service}请求超时（${timeoutMs / 1000} 秒）`)
    const message = err instanceof Error ? err.message : String(err)
    return new Error(`无法连接${service}：${redact(message, apiKey)}`)
  }

  let res: Response
  try {
    res = await (options.fetch ?? fetch)(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
  } catch (err) {
    throw failure(err)
  }
  let text = ''
  try {
    text = await res.text()
  } catch (err) {
    // An unreadable error body still leaves the status worth reporting.
    if (res.ok || signal?.aborted || timeout.aborted) throw failure(err)
  }
  const snippet = snippetOf(text, apiKey)
  if (!res.ok) throw new HttpStatusError(service, res.status, res.statusText, snippet)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${service}返回内容不是合法 JSON${snippet ? `：${snippet}` : ''}`)
  }
}
