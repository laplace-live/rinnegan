import type { NavInfo, QRLogin } from '@/bilibili'
import type { RinneganConfig } from '@/config'
import type { FetchLike } from '@/util/fetch'

import { BilibiliClient, credentialsFromQRLogin, loginWithQRCode, saveQRLogin } from '@/bilibili'
import { fail, log, stdoutHasColors, style, warn } from '@/util/console'
import { errorMessage } from '@/util/guards'
import { renderQRCode } from '@/util/qr'
import { VERSION } from '@/version'

export interface LoginOptions {
  config: RinneganConfig
  /** Injected Bilibili fetch, for tests */
  fetch?: FetchLike
  /** Between polls, ms */
  pollIntervalMs?: number
}

/** Log in by scanning a QR code in the Bilibili app and save the cookies to `config.loginFile`. Returns the exit code. */
export async function runLogin(options: LoginOptions): Promise<number> {
  const { config } = options
  log(style.bold(`LAPLACE Rinnegan 輪廻眼 ${VERSION} · 扫码登录`))
  let login: QRLogin
  try {
    login = await loginWithQRCode({
      fetch: options.fetch,
      pollIntervalMs: options.pollIntervalMs,
      onCode: (url, attempt) => {
        if (attempt > 1) log(style.yellow('二维码已过期，换一个新的'))
        log(renderQRCode(url, stdoutHasColors()))
        log('请用哔哩哔哩 App 扫描二维码，并在 App 中确认登录')
      },
      onScanned: () => log('已扫码，请在 App 中确认登录'),
    })
  } catch (error) {
    fail(`扫码登录失败：${errorMessage(error)}`)
    return 1
  }

  const credentials = credentialsFromQRLogin(login.credentials)
  const client = new BilibiliClient({ credentials: () => credentials, fetch: options.fetch })
  let nav: NavInfo | null = null
  try {
    nav = await client.nav()
  } catch (error) {
    // The cookies come straight from Bilibili's login, so a failed check doesn't discard them
    warn(`无法确认登录状态：${errorMessage(error)}`)
  }
  if (nav && !nav.isLogin) {
    fail('扫码登录失败：B 站没有接受这次登录的 Cookie，请重试')
    return 1
  }

  try {
    await saveQRLogin(config.loginFile, login)
  } catch (error) {
    fail(`无法保存扫码登录到 ${config.loginFile}：${errorMessage(error)}`)
    return 1
  }
  const saved = `已保存到 ${config.loginFile}`
  log(nav ? `登录账号 ${nav.uname}（${nav.uid}）· ${saved}` : `登录账号 UID ${credentials.uid} · ${saved}`)
  if (config.loginSync.token) warn('已配置 LOGIN_SYNC_TOKEN，live / bans / unban 仍会优先使用 Login Sync')
  return 0
}
