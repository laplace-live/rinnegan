import type { AuditLog } from '@/audit/audit'
import type { NavInfo } from '@/bilibili'
import type { RinneganConfig } from '@/config'
import type { BanStore } from '@/store/types'
import type { FetchLike } from '@/util/fetch'

import { BilibiliClient, CredentialProvider, credentialSummary, QRLoginProvider } from '@/bilibili'
import { createBanStore, describeStoreUrl } from '@/store'
import { errorMessage } from '@/util/guards'

/** Where the Bilibili cookies come from: LAPLACE Login Sync, or the QR login `rinnegan login` saved. */
export type LoginMethod = 'login-sync' | 'qr'

export const LOGIN_METHOD_LABELS: Record<LoginMethod, string> = { 'login-sync': 'Login Sync', qr: '扫码登录' }

/** A Bilibili client on the configured cookies, and who they log in as. */
export interface LoginSession {
  client: BilibiliClient
  nav: NavInfo
  method: LoginMethod
  /** Cookies in the header */
  cookies: number
}

/** A Login Sync token wins over a saved QR login; null when there's neither. */
export async function loginMethod(config: RinneganConfig): Promise<LoginMethod | null> {
  if (config.loginSync.token) return 'login-sync'
  return (await Bun.file(config.loginFile).exists()) ? 'qr' : null
}

/**
 * Load the cookies and check them with `nav()`; throws in Chinese when they don't log in. Cookies Bilibili rejects
 * later are loaded again once per request, audited as `credentials-refresh`.
 */
export async function connectBilibili(
  config: RinneganConfig,
  method: LoginMethod,
  fetch?: FetchLike,
  audit?: AuditLog
): Promise<LoginSession> {
  const { loginSync } = config
  const credentials =
    method === 'qr'
      ? new QRLoginProvider(config.loginFile)
      : new CredentialProvider({
          token: loginSync.token,
          baseURL: loginSync.baseURL || undefined,
          authKey: loginSync.authKey || undefined,
          ttlMs: loginSync.refreshMinutes * 60_000,
          fetch,
        })
  const client = new BilibiliClient({
    credentials: () => credentials.get(),
    onAuthFailure: result => {
      credentials.invalidate()
      audit?.write('credentials-refresh', { reason: `${result.code} ${result.message}` })
    },
    fetch,
  })
  const failure = (reason: string, cause?: unknown) =>
    new Error(`${method === 'qr' ? '无法使用扫码登录' : '无法使用 Login Sync 凭据'}：${reason}`, { cause })
  let cookies: number
  let nav: NavInfo
  try {
    cookies = credentialSummary(await credentials.get()).cookies
    nav = await client.nav()
  } catch (error) {
    throw failure(errorMessage(error), error)
  }
  if (!nav.isLogin) {
    throw failure(
      method === 'qr'
        ? 'B 站登录已失效，请重新运行 rinnegan login'
        : 'Login Sync 中的 B 站登录已失效，请在浏览器重新登录后同步'
    )
  }
  return { client, nav, method, cookies }
}

/** The configured ban store, or null after reporting why it can't be opened. */
export async function openStore(config: RinneganConfig, report: (line: string) => void): Promise<BanStore | null> {
  try {
    return await createBanStore(config.storeUrl)
  } catch (error) {
    report(`无法打开封禁记录存储 ${describeStoreUrl(config.storeUrl)}：${errorMessage(error)}`)
    return null
  }
}
