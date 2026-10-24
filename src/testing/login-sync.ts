import type { LoginSyncCookie, LoginSyncPayload } from '@laplace.live/login-sync'
import { encrypt, parseToken } from '@laplace.live/login-sync'

import type { FetchLike } from '@/util/fetch'

const DAY_SEC = 86_400

/** A cookie as `browser.cookies.getAll()` reports it; `ttlSec` null is a session cookie. */
export function syncCookie(
  name: string,
  value: string,
  domain = '.bilibili.com',
  ttlSec: number | null = 180 * DAY_SEC
): LoginSyncCookie {
  const cookie: LoginSyncCookie = {
    name,
    value,
    domain,
    path: '/',
    secure: true,
    httpOnly: name === 'SESSDATA',
    hostOnly: !domain.startsWith('.'),
    session: ttlSec === null,
    sameSite: 'no_restriction',
    storeId: '0',
  }
  if (ttlSec !== null) cookie.expirationDate = Date.now() / 1000 + ttlSec
  return cookie
}

/** The v2 blob the extension uploads for `token` (`uuid@password`). */
export function syncBlob(payload: LoginSyncPayload, token: string): Promise<string> {
  return encrypt(payload, parseToken(token), { version: 2 })
}

/** A blob with just the cookies moderation needs: `bili_jct` is `csrf`, `DedeUserID` is `uid`. */
export function moderatorBlob(token: string, csrf: string, uid: number): Promise<string> {
  const cookies = [syncCookie('SESSDATA', 'sess'), syncCookie('bili_jct', csrf), syncCookie('DedeUserID', String(uid))]
  return syncBlob({ cookie_data: { 'bilibili.com': cookies }, local_storage_data: {} }, token)
}

/**
 * `fetch` for a fake login-sync server and Bilibili: serves `blob` for `token`'s uuid (when given), logs in as `uid`,
 * resolves every room to `roomId`, and records each POST. The silent list holds `silent`; every other POST succeeds.
 */
export function fakeBilibili(options: {
  token?: string
  blob?: string
  uid: number
  uname: string
  roomId?: number
  silent?: { tuid: number; tname: string }[]
}) {
  const uuid = options.token ? parseToken(options.token).uuid : null
  const posts: { url: string; body: string }[] = []
  const fetch: FetchLike = async (url, init) => {
    if (uuid && url.includes(`/get/${uuid}`)) return Response.json({ encrypted: options.blob })
    if (url.includes('/x/web-interface/nav')) {
      return Response.json({ code: 0, data: { isLogin: true, mid: options.uid, uname: options.uname } })
    }
    if (url.includes('room_init')) {
      return Response.json({ code: 0, data: { room_id: options.roomId ?? 1, short_id: 0, uid: 1 } })
    }
    posts.push({ url, body: String(init.body ?? '') })
    if (url.includes('GetSilentUserList')) {
      return Response.json({ code: 0, data: { data: options.silent ?? [], total_page: 1 } })
    }
    return Response.json({ code: 0, message: '0', data: {} })
  }
  return { fetch, posts }
}
