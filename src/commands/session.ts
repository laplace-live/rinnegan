import type { AuditLog } from '@/audit/audit'
import type { NavInfo } from '@/bilibili'
import type { RinneganConfig } from '@/config'
import type { BanStore } from '@/store/types'
import type { FetchLike } from '@/util/fetch'

import { BilibiliClient, CredentialProvider, credentialSummary, loadCredentials, loadQRLogin } from '@/bilibili'
import { createBanStore, describeStoreUrl } from '@/store'
import { errorMessage } from '@/util/guards'

/** How Rinnegan logs in to Bilibili, from {@link resolveLogin}. */
export interface Login {
  method: 'login-sync' | 'qr'
  /** Names the method in output */
  label: string
  credentials: CredentialProvider
  /** What to do once Bilibili stops accepting the cookies */
  expired: string
}

/** A Bilibili client on a login's cookies, and who they log in as. */
export interface LoginSession {
  client: BilibiliClient
  nav: NavInfo
  /** Cookies in the header */
  cookies: number
}

export const NO_LOGIN = '未提供 LOGIN_SYNC_TOKEN，也未扫码登录（rinnegan login）'

/** The configured login: a Login Sync token wins over a saved QR login; null when there's neither. */
export async function resolveLogin(config: RinneganConfig, fetch?: FetchLike): Promise<Login | null> {
  const { loginSync, loginFile } = config
  if (loginSync.token) {
    const load = (signal: AbortSignal) =>
      loadCredentials({
        token: loginSync.token,
        baseURL: loginSync.baseURL || undefined,
        authKey: loginSync.authKey || undefined,
        fetch,
        signal,
      })
    return {
      method: 'login-sync',
      label: 'Login Sync',
      credentials: new CredentialProvider({ load, ttlMs: loginSync.refreshMinutes * 60_000 }),
      expired: 'Login Sync 中的 B 站登录已失效，请在浏览器重新登录后同步',
    }
  }
  if (!loginFile || !(await Bun.file(loginFile).exists())) return null
  return {
    method: 'qr',
    label: '扫码登录',
    // Nothing renews a QR login, so it's read again only once Bilibili rejects it
    credentials: new CredentialProvider({ load: () => loadQRLogin(loginFile), ttlMs: Number.POSITIVE_INFINITY }),
    expired: '扫码登录已失效，请重新运行 rinnegan login',
  }
}

/**
 * Load `login`'s cookies and check them with `nav()`; throws in Chinese when they don't log in. Cookies Bilibili
 * rejects later are loaded again once per request, audited as `credentials-refresh`.
 */
export async function connectBilibili(login: Login, fetch?: FetchLike, audit?: AuditLog): Promise<LoginSession> {
  const { credentials } = login
  const client = new BilibiliClient({
    credentials: () => credentials.get(),
    onAuthFailure: result => {
      credentials.invalidate()
      audit?.write('credentials-refresh', { reason: `${result.code} ${result.message}` })
    },
    fetch,
  })
  try {
    const { cookies } = credentialSummary(await credentials.get())
    const nav = await client.nav()
    if (!nav.isLogin) throw new Error(login.expired)
    return { client, nav, cookies }
  } catch (error) {
    throw new Error(`无法登录 B 站：${errorMessage(error)}`, { cause: error })
  }
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
