import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { BilibiliCredentials as QRCredentials, QRLoginOptions } from '@laplace.live/bilibili-qr'
import { cookieStringFromCredentials, generateQRCode, pollQRCode, QRLoginError } from '@laplace.live/bilibili-qr'

import type { BilibiliCredentials } from '@/bilibili/types'
import type { FetchLike } from '@/util/fetch'

import { describeResult } from '@/bilibili/client'
import { errorMessage, isRecord, readPath, toId } from '@/util/guards'

/** A QR login as `rinnegan login` saves it: the session cookies, plus what Bilibili's cookie refresh would take. */
export interface QRLogin {
  credentials: QRCredentials
  refreshToken: string
}

/** How {@link loginWithQRCode} reaches Bilibili and reports progress. */
export interface QRLoginFlowOptions {
  /** Show `url` as a QR code; `attempt` counts the codes issued, from 1 */
  onCode: (url: string, attempt: number) => void
  /** The code was scanned and waits for confirmation in the app */
  onScanned?: () => void
  fetch?: FetchLike
  /** Between polls, ms */
  pollIntervalMs?: number
}

const POLL_INTERVAL_MS = 2000
/** Codes to issue before giving up; each lasts about 3 minutes */
const MAX_CODES = 3
const REQUEST_TIMEOUT_MS = 15_000

/**
 * Log in with a QR code: issue one, poll it until it's confirmed in the Bilibili app, and issue another when it
 * expires. Errors are Chinese and never carry the login.
 */
export async function loginWithQRCode(options: QRLoginFlowOptions): Promise<QRLogin> {
  const { fetch, pollIntervalMs = POLL_INTERVAL_MS } = options
  for (let attempt = 1; attempt <= MAX_CODES; attempt++) {
    const { url, qrcodeKey } = await send(fetch, generateQRCode)
    options.onCode(url, attempt)
    let status = ''
    for (;;) {
      await Bun.sleep(pollIntervalMs)
      // Never two polls at once: a successful poll can consume the key
      const result = await send(fetch, request => pollQRCode(qrcodeKey, request))
      if (result.status === 'success') return { credentials: result.credentials, refreshToken: result.refreshToken }
      if (result.status === 'expired') break
      if (result.status === 'unknown') {
        const { code, message } = result.response.data
        throw new Error(`B 站返回了未知的扫码状态：${describeResult({ code, message, status: 0 })}`)
      }
      if (result.status === 'waiting_confirm' && status !== result.status) options.onScanned?.()
      status = result.status
    }
  }
  throw new Error(`连续 ${MAX_CODES} 个二维码都已过期`)
}

/** Request credentials for a QR login's cookies. */
export function credentialsFromQRLogin(credentials: QRCredentials): BilibiliCredentials {
  return { cookie: cookieStringFromCredentials(credentials), csrf: credentials.bili_jct, uid: credentials.DedeUserID }
}

/** Save `login` to `path`, readable by the owner only; an earlier login is replaced in one step. */
export async function saveQRLogin(path: string, login: QRLogin): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${crypto.randomUUID()}.tmp`
  try {
    // writeFile, not Bun.write: Bun 1.4 ignores Bun.write's mode
    await writeFile(temp, `${JSON.stringify(login, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    await rename(temp, path)
  } finally {
    await rm(temp, { force: true })
  }
}

/** Request credentials from the QR login saved at `path`; throws in Chinese when it's missing or damaged. */
export async function loadQRLogin(path: string): Promise<BilibiliCredentials> {
  const file = Bun.file(path)
  if (!(await file.exists())) throw new Error(`找不到扫码登录 ${path}，请先运行 rinnegan login`)
  const credentials = parseSaved(await file.text())
  // Never quote the file: it holds the cookies
  if (!credentials) throw new Error(`扫码登录 ${path} 已损坏，请重新运行 rinnegan login`)
  return credentialsFromQRLogin(credentials)
}

/** One login request with a timeout, its failure described in Chinese. */
async function send<T>(fetch: FetchLike | undefined, call: (options: QRLoginOptions) => Promise<T>): Promise<T> {
  try {
    return await call({
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      // The ticket exchange passes a URL, which FetchLike doesn't take
      fetch: fetch && (async (input, init) => fetch(String(input), init)),
    })
  } catch (error) {
    throw new Error(describeQRLoginError(error), { cause: error })
  }
}

function describeQRLoginError(error: unknown): string {
  if (error instanceof QRLoginError) {
    switch (error.reason) {
      case 'http':
        return `B 站返回 HTTP ${error.status}${error.status === 412 ? '，可能被风控拦截' : ''}`
      case 'api':
        return `B 站拒绝了请求：${describeResult({ code: error.code ?? 0, message: error.apiMessage ?? '', status: 0 })}`
      case 'response':
        return 'B 站的响应格式无法识别'
      case 'credentials':
        return '已确认登录，但没能取得 Cookie'
    }
  }
  if (error instanceof Error && error.name === 'TimeoutError') return '请求 B 站超时'
  return `无法连接 B 站：${errorMessage(error)}`
}

function parseSaved(text: string): QRCredentials | null {
  let saved: unknown
  try {
    saved = JSON.parse(text)
  } catch {
    return null
  }
  const credentials = readPath(saved, 'credentials')
  if (!isRecord(credentials)) return null
  const { SESSDATA, bili_jct, DedeUserID__ckMd5 } = credentials
  const DedeUserID = toId(credentials.DedeUserID)
  if (typeof SESSDATA !== 'string' || !SESSDATA || !isHeaderSafe(bili_jct) || DedeUserID === null) return null
  if (DedeUserID__ckMd5 !== undefined && !isHeaderSafe(DedeUserID__ckMd5)) return null
  return { SESSDATA, bili_jct, DedeUserID, DedeUserID__ckMd5 }
}

// SESSDATA is percent-encoded into the Cookie header; the others go in as they are
function isHeaderSafe(value: unknown): value is string {
  return typeof value === 'string' && /^[^\s;]+$/.test(value)
}
