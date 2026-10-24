/** Cookies for Bilibili web APIs, from LAPLACE Login Sync or a QR login. */
export interface BilibiliCredentials {
  /** `Cookie` header value */
  cookie: string
  /** `bili_jct`, sent as `csrf` / `csrf_token` */
  csrf: string
  /** `DedeUserID`; null when the cookie is missing */
  uid: number | null
}

/** Bilibili's `{ code, message, data }` envelope plus the HTTP status. */
export interface ApiResult<T = unknown> {
  ok: boolean
  /** Bilibili business code; 0 is success, negative for transport-level failures we synthesize */
  code: number
  message: string
  data: T | null
  /** HTTP status, 0 when no response arrived */
  status: number
}

/** One entry of a room's silent-user (禁言) list. */
export interface SilentUser {
  uid: number
  uname: string
  /** Who banned them, when Bilibili says */
  operatorName: string | null
  /** Bilibili's own timestamp string, e.g. `2026-10-20 12:00:00` */
  createdAt: string | null
  /** Seconds until the ban ends, when Bilibili says; null for permanent or unknown */
  remainingSec: number | null
}

export interface NavInfo {
  isLogin: boolean
  uid: number
  uname: string
}

export interface RoomInfo {
  /** Canonical (long) room id */
  roomId: number
  shortId: number
  /** Streamer uid */
  uid: number
}
