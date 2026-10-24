import type { BilibiliCredentials as QRCredentials } from '@laplace.live/bilibili-qr'
import { QR_CODE_STATUS, QR_LOGIN_ENDPOINTS } from '@laplace.live/bilibili-qr'

import type { QRLogin } from '@/bilibili'
import type { FetchLike } from '@/util/fetch'

import { fakeBilibili } from '@/testing/login-sync'

/** Cookies as a QR login hands them over, SESSDATA decoded. */
export const QR_CREDENTIALS: QRCredentials = {
  SESSDATA: 'qr-sess,1792540800,ab*cd',
  DedeUserID: 9,
  DedeUserID__ckMd5: 'ckmd5',
  bili_jct: 'qrcsrf',
}

/** The `Cookie` header for {@link QR_CREDENTIALS}, SESSDATA percent-encoded again. */
export const QR_COOKIE = 'SESSDATA=qr-sess%2C1792540800%2Cab*cd; DedeUserID=9; DedeUserID__ckMd5=ckmd5; bili_jct=qrcsrf'

/** A QR login of {@link QR_CREDENTIALS}; `patch` overrides any cookie. */
export function qrLogin(patch: Partial<QRCredentials> = {}): QRLogin {
  return { credentials: { ...QR_CREDENTIALS, ...patch }, refreshToken: 'refresh-token' }
}

/** What the QR code for `key` encodes, as Bilibili issued it in October 2026. */
export function qrCodeUrl(key: string): string {
  return `https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=close&qrcode_key=${key}&from=`
}

/**
 * `fetch` for Bilibili's QR login: issues codes `key1`, `key2`…, and answers each poll with the next of `states`
 * (`QR_CODE_STATUS` codes, expired once they run out). Success hands over {@link QR_CREDENTIALS} in the login URL, the
 * legacy way that needs no ticket exchange. Everything else goes to {@link fakeBilibili}, logged in as 主播 (uid 9).
 */
export function fakePassport(states: number[], options: { isLogin?: boolean } = {}) {
  const bilibili = fakeBilibili({ uid: 9, uname: '主播', isLogin: options.isLogin })
  const queue = [...states]
  const polls: string[] = []
  let issued = 0
  const fetch: FetchLike = (url, init) => {
    if (url === QR_LOGIN_ENDPOINTS.GENERATE) {
      const key = `key${++issued}`
      return Response.json({ code: 0, message: '0', ttl: 1, data: { url: qrCodeUrl(key), qrcode_key: key } })
    }
    if (url.startsWith(`${QR_LOGIN_ENDPOINTS.POLL}?`)) {
      polls.push(new URL(url).searchParams.get('qrcode_key') ?? '')
      const state = queue.shift() ?? QR_CODE_STATUS.EXPIRED
      const login = new URL('https://passport.biligame.com/x/passport-login/web/crossDomain')
      const success = state === QR_CODE_STATUS.SUCCESS
      if (success) for (const [name, value] of Object.entries(QR_CREDENTIALS)) login.searchParams.set(name, `${value}`)
      return Response.json({
        code: 0,
        message: '0',
        ttl: 1,
        data: {
          url: success ? login.href : '',
          refresh_token: success ? 'refresh-token' : '',
          timestamp: 0,
          code: state,
        },
      })
    }
    return bilibili.fetch(url, init)
  }
  return { fetch, polls }
}
