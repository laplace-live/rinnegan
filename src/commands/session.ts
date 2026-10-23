import type { AuditLog } from '@/audit/audit'
import type { NavInfo } from '@/bilibili'
import type { RinneganConfig } from '@/config'
import type { BanStore } from '@/store/types'
import type { FetchLike } from '@/util/fetch'

import { BilibiliClient, CredentialProvider, credentialSummary } from '@/bilibili'
import { createBanStore, describeStoreUrl } from '@/store'
import { errorMessage } from '@/util/guards'

/** A Bilibili client on the login-sync cookies, and who they log in as. */
export interface LoginSession {
  client: BilibiliClient
  nav: NavInfo
  /** Cookies in the header */
  cookies: number
}

/**
 * Pull the login-sync cookies and check them with `nav()`; throws in Chinese when they don't log in. Cookies Bilibili
 * rejects later are pulled again once per request, audited as `credentials-refresh`.
 */
export async function connectLoginSync(
  config: RinneganConfig,
  fetch?: FetchLike,
  audit?: AuditLog
): Promise<LoginSession> {
  const { loginSync } = config
  const credentials = new CredentialProvider({
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
  const { cookies } = credentialSummary(await credentials.get())
  const nav = await client.nav()
  if (!nav.isLogin) throw new Error('Login Sync 中的 B 站登录已失效，请在浏览器重新登录后同步')
  return { client, nav, cookies }
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
