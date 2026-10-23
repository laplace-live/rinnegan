import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import type { LoginSyncCookie, LoginSyncPayload } from '@laplace.live/login-sync'
import { isLoginSyncError } from '@laplace.live/login-sync'

import type { CredentialProviderOptions, LoadCredentialsOptions } from '@/bilibili/credentials'
import type { FetchCall } from '@/testing/fetch'

import { CredentialProvider, credentialSummary, credentialsFromPayload, loadCredentials } from '@/bilibili/credentials'
import { hang, recordingFetch } from '@/testing/fetch'
import { syncCookie as cookie, syncBlob } from '@/testing/login-sync'

const BASE = 'https://login-sync.test'
const UUID = 'rinneganTest01'
const PASSWORD = 'hunter2-correct-horse'
const TOKEN = `${UUID}@${PASSWORD}`
const SESSDATA = 'a1b2c3d4%2C1792540800%2Ce5f6a*a1CjBxyz'
const BILI_JCT = '0123456789abcdef0123456789abcdef'
const DAY = 86_400

function payload(cookieData: LoginSyncPayload['cookie_data']): LoginSyncPayload {
  return { cookie_data: cookieData, local_storage_data: { 'laplace.live': { theme: 'dark' } } }
}

function realisticPayload(jct = BILI_JCT): LoginSyncPayload {
  return payload({
    'bilibili.com': [
      cookie('buvid3', 'B3C4D5E6-1234-5678-9ABC-DEF012345678infoc', '.bilibili.com', 365 * DAY),
      cookie('b_nut', '1760947200', '.bilibili.com', 365 * DAY),
      cookie('SESSDATA', SESSDATA),
      cookie('bili_jct', jct),
      cookie('DedeUserID', '12345678'),
      cookie('DedeUserID__ckMd5', '0f1e2d3c4b5a6978'),
      cookie('sid', 'abcd1234'),
      cookie('bili_ticket', 'eyJhbGciOiJIUzI1NiJ9.e30.sig', '.bilibili.com', 3 * DAY),
      cookie('b_lsid', 'ABC123_19A0B1C2D3E', '.bilibili.com', null),
      cookie('home_feed_column', '5', 'www.bilibili.com', 365 * DAY),
    ],
    'live.bilibili.com': [
      cookie('LIVE_BUVID', 'AUTO1234567890123456', 'live.bilibili.com', 365 * DAY),
      cookie('SESSDATA', SESSDATA),
    ],
    'laplace.live': [cookie('laplace_session', 'not-for-bilibili', '.laplace.live')],
  })
}

const REALISTIC_COOKIE = [
  'buvid3=B3C4D5E6-1234-5678-9ABC-DEF012345678infoc',
  'b_nut=1760947200',
  `SESSDATA=${SESSDATA}`,
  `bili_jct=${BILI_JCT}`,
  'DedeUserID=12345678',
  'DedeUserID__ckMd5=0f1e2d3c4b5a6978',
  'sid=abcd1234',
  'bili_ticket=eyJhbGciOiJIUzI1NiJ9.e30.sig',
  'b_lsid=ABC123_19A0B1C2D3E',
  'home_feed_column=5',
  'LIVE_BUVID=AUTO1234567890123456',
].join('; ')

function blob(data: LoginSyncPayload, token = TOKEN): Promise<string> {
  return syncBlob(data, token)
}

/** Serves `encrypted` at `/get/<uuid>` and answers like the real server for any other uuid. */
function serving(encrypted: () => string) {
  return recordingFetch(call =>
    call.url === `${BASE}/get/${UUID}`
      ? Response.json({ encrypted: encrypted() })
      : Response.json({ message: 'Invalid credentials' }, { status: 403 })
  )
}

async function loadError(options: Partial<LoadCredentialsOptions>): Promise<Error> {
  const error = await loadCredentials({ token: TOKEN, baseURL: BASE, ...options }).then(
    () => {
      throw new Error('expected loadCredentials to reject')
    },
    (error: unknown) => error
  )
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).not.toContain(PASSWORD)
  return error as Error
}

function thrown(fn: () => unknown): Error {
  try {
    fn()
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a throw')
}

describe('loadCredentials', () => {
  test('pulls and decrypts a v2 blob into credentials', async () => {
    const encrypted = await blob(realisticPayload())
    const server = serving(() => encrypted)
    expect(await loadCredentials({ token: TOKEN, baseURL: BASE, fetch: server.fetch })).toEqual({
      cookie: REALISTIC_COOKIE,
      csrf: BILI_JCT,
      uid: 12345678,
    })
    expect(server.calls).toMatchObject([{ url: `${BASE}/get/${UUID}`, method: 'GET', body: null }])
  })

  test('sends the auth key in a POST body for a private server', async () => {
    const encrypted = await blob(realisticPayload())
    const server = recordingFetch(() => Response.json({ encrypted }))
    await loadCredentials({ token: TOKEN, baseURL: BASE, authKey: 'private-key', fetch: server.fetch })
    expect(server.calls).toMatchObject([
      { url: `${BASE}/get/${UUID}`, method: 'POST', body: JSON.stringify({ auth: 'private-key' }) },
    ])
  })

  test('maps an unusable token without a request', async () => {
    const server = serving(() => 'unused')
    const error = await loadError({ token: 'not-a-token', fetch: server.fetch })
    expect(error.message).toBe('登录同步令牌无效：应为扩展显示的 uuid@password')
    expect(isLoginSyncError(error.cause, 'invalid_token')).toBe(true)
    expect(server.calls).toHaveLength(0)
  })

  test('maps server answers to Chinese errors', async () => {
    const answers: [() => Response, RegExp][] = [
      [() => Response.json({ message: 'Invalid credentials' }, { status: 403 }), /上没有这个令牌的数据/],
      [() => Response.json({ message: 'Unauthorized' }, { status: 403 }), /处于私有模式，auth key 缺失或错误/],
      [() => new Response('<html>challenge</html>', { status: 403 }), /返回错误（HTTP 403），可能被防火墙拦截/],
      [() => new Response('oops', { status: 500 }), /返回错误（HTTP 500）$/],
      [() => Response.json({ encrypted: 'garbage' }), /^登录同步数据格式无效$/],
      [() => Response.json({ encrypted: 'v9:future' }), /协议版本比当前 SDK 新/],
      [
        () => {
          throw new TypeError('fetch failed')
        },
        /^无法连接登录同步服务器 https:\/\/login-sync\.test$/,
      ],
    ]
    for (const [answer, message] of answers) {
      const error = await loadError({ fetch: recordingFetch(answer).fetch })
      expect(error.message).toMatch(message)
      expect(isLoginSyncError(error.cause)).toBe(true)
    }
  })

  test('maps a token that cannot open the blob', async () => {
    const encrypted = await blob(realisticPayload(), `${UUID}@another-password`)
    const error = await loadError({ fetch: serving(() => encrypted).fetch })
    expect(error.message).toBe('登录同步令牌无法解密数据：密码不对，或数据已损坏')
    expect(isLoginSyncError(error.cause, 'bad_credentials')).toBe(true)
  })

  test('maps a timeout and an invalid server address', async () => {
    const timedOut = await loadError({ fetch: recordingFetch(hang).fetch, signal: AbortSignal.timeout(20) })
    expect(timedOut.message).toBe('登录同步服务器 https://login-sync.test 响应超时')
    const invalid = await loadError({ baseURL: 'not a url' })
    expect(invalid.message).toBe('登录同步服务器地址无效：not a url')
  })

  test('rejects a payload without the required cookies', async () => {
    const encrypted = await blob(payload({ 'bilibili.com': [cookie('buvid3', 'B3')] }))
    const error = await loadError({ fetch: serving(() => encrypted).fetch })
    expect(error.message).toContain('缺少 SESSDATA，缺少 bili_jct')
  })
})

describe('credentialsFromPayload', () => {
  const required = () => [cookie('SESSDATA', SESSDATA), cookie('bili_jct', BILI_JCT)]

  test('names each missing cookie without leaking values', () => {
    const noSessdata = thrown(() => credentialsFromPayload(payload({ 'bilibili.com': [cookie('bili_jct', BILI_JCT)] })))
    expect(noSessdata.message).toBe(
      '登录同步数据中的 Bilibili Cookie 不可用：缺少 SESSDATA。请在浏览器登录 bilibili.com 后用 LAPLACE Login Sync 重新同步'
    )
    expect(noSessdata.message).not.toContain(BILI_JCT)
    const noJct = thrown(() => credentialsFromPayload(payload({ 'bilibili.com': [cookie('SESSDATA', SESSDATA)] })))
    expect(noJct.message).toContain('：缺少 bili_jct。')
    expect(noJct.message).not.toContain(SESSDATA)
    const empty = thrown(() => credentialsFromPayload(payload({ 'bilibili.com': [cookie('SESSDATA', '')] })))
    expect(empty.message).toContain('：缺少 SESSDATA，缺少 bili_jct。')
  })

  test('drops expired cookies and says when a required one expired', () => {
    const stale = thrown(() =>
      credentialsFromPayload(
        payload({ 'bilibili.com': [cookie('SESSDATA', SESSDATA, '.bilibili.com', -DAY), cookie('bili_jct', BILI_JCT)] })
      )
    )
    expect(stale.message).toContain('：SESSDATA 已过期。')
    const credentials = credentialsFromPayload(
      payload({ 'bilibili.com': [...required(), cookie('bili_ticket', 'old', '.bilibili.com', -60)] })
    )
    expect(credentials.cookie).toBe(`SESSDATA=${SESSDATA}; bili_jct=${BILI_JCT}`)
  })

  test('honours the now parameter for expiry', () => {
    const data = payload({ 'bilibili.com': [...required(), cookie('short', '1', '.bilibili.com', 60)] })
    expect(credentialsFromPayload(data).cookie).toContain('short=1')
    expect(credentialsFromPayload(data, Date.now() + 120_000).cookie).not.toContain('short=1')
  })

  test('prefers the .bilibili.com copy of a name, then the later expiry', () => {
    const credentials = credentialsFromPayload(
      payload({
        'bilibili.com': [
          cookie('SESSDATA', 'host-only', 'www.bilibili.com', 365 * DAY),
          cookie('SESSDATA', SESSDATA, '.bilibili.com', 30 * DAY),
          cookie('bili_jct', 'expired-root', '.bilibili.com', -DAY),
          cookie('bili_jct', BILI_JCT, 'live.bilibili.com', 30 * DAY),
          cookie('buvid3', 'older', 'live.bilibili.com', 10 * DAY),
          cookie('buvid3', 'newer', 'www.bilibili.com', 20 * DAY),
          cookie('buvid3', 'oldest', 'm.bilibili.com', 5 * DAY),
        ],
      })
    )
    expect(credentials).toEqual({
      cookie: `SESSDATA=${SESSDATA}; bili_jct=${BILI_JCT}; buvid3=newer`,
      csrf: BILI_JCT,
      uid: null,
    })
  })

  test('takes bilibili.com and subdomains by entry key or cookie domain', () => {
    const credentials = credentialsFromPayload(
      payload({
        'bilibili.com': required(),
        'laplace.live': [cookie('stray', '1', '.bilibili.com'), cookie('laplace', 'x', '.laplace.live')],
        'evilbilibili.com': [cookie('evil', '1', 'evilbilibili.com')],
        'live.bilibili.com': [cookie('LIVE_BUVID', 'AUTO1', 'live.bilibili.com')],
      })
    )
    expect(credentials.cookie).toBe(`SESSDATA=${SESSDATA}; bili_jct=${BILI_JCT}; stray=1; LIVE_BUVID=AUTO1`)
  })

  test('reads the uid from DedeUserID', () => {
    const withUid = (value: string) =>
      credentialsFromPayload(payload({ 'bilibili.com': [...required(), cookie('DedeUserID', value)] })).uid
    expect(withUid('3493260125276695')).toBe(3493260125276695)
    expect(withUid('abc')).toBeNull()
    expect(withUid('0')).toBeNull()
    expect(credentialsFromPayload(payload({ 'bilibili.com': required() })).uid).toBeNull()
  })

  test('skips cookies that would break the header', () => {
    const broken = [
      cookie('bad', 'a;b'),
      cookie('bad name', '1'),
      { value: 'nameless', domain: '.bilibili.com' } as unknown as LoginSyncCookie,
    ]
    const credentials = credentialsFromPayload(payload({ 'bilibili.com': [...required(), ...broken] }))
    expect(credentials.cookie).toBe(`SESSDATA=${SESSDATA}; bili_jct=${BILI_JCT}`)
  })
})

describe('credentialSummary', () => {
  test('summarizes without secrets', () => {
    const summary = credentialSummary({ cookie: REALISTIC_COOKIE, csrf: BILI_JCT, uid: 12345678 })
    expect(summary).toEqual({ uid: 12345678, cookies: 11, csrfPreview: '01…ef' })
    expect(JSON.stringify(summary)).not.toContain(BILI_JCT)
    expect(JSON.stringify(summary)).not.toContain(SESSDATA)
    expect(credentialSummary({ cookie: '', csrf: 'abc', uid: null })).toEqual({
      uid: null,
      cookies: 0,
      csrfPreview: '…',
    })
  })
})

describe('CredentialProvider', () => {
  afterEach(() => setSystemTime())

  function setup(
    reply: (call: FetchCall) => Response | Promise<Response>,
    options: Partial<CredentialProviderOptions> = {}
  ) {
    const server = recordingFetch(reply)
    const provider = new CredentialProvider({ token: TOKEN, baseURL: BASE, fetch: server.fetch, ...options })
    return { server, provider }
  }

  test('caches one pull for the TTL and shares concurrent pulls', async () => {
    const encrypted = await blob(realisticPayload())
    const { server, provider } = setup(() => Response.json({ encrypted }))
    const [first, second] = await Promise.all([provider.get(), provider.get()])
    expect(first).toBe(second)
    expect(first.csrf).toBe(BILI_JCT)
    setSystemTime(Date.now() + 30 * 60_000 - 1000)
    expect(await provider.get()).toBe(first)
    expect(server.calls).toHaveLength(1)
    setSystemTime(Date.now() + 2000)
    expect(await provider.get()).not.toBe(first)
    expect(server.calls).toHaveLength(2)
  })

  test('invalidate forces a fresh pull', async () => {
    let encrypted = await blob(realisticPayload())
    const { server, provider } = setup(() => Response.json({ encrypted }))
    const first = await provider.get()
    encrypted = await blob(realisticPayload('fedcba9876543210fedcba9876543210'))
    expect(await provider.get()).toBe(first)
    provider.invalidate()
    expect((await provider.get()).csrf).toBe('fedcba9876543210fedcba9876543210')
    expect(server.calls).toHaveLength(2)
  })

  test('a pull started before invalidate does not refill the cache', async () => {
    const encrypted = await blob(realisticPayload())
    const { server, provider } = setup(() => Response.json({ encrypted }))
    const pending = provider.get()
    provider.invalidate()
    await pending
    await provider.get()
    expect(server.calls).toHaveLength(2)
  })

  test('does not cache a failed pull', async () => {
    const encrypted = await blob(realisticPayload())
    let up = false
    const { server, provider } = setup(() =>
      up ? Response.json({ encrypted }) : new Response('bad gateway', { status: 502 })
    )
    await expect(provider.get()).rejects.toThrow('返回错误（HTTP 502）')
    up = true
    expect((await provider.get()).csrf).toBe(BILI_JCT)
    expect(server.calls).toHaveLength(2)
  })

  test('serves stale credentials while a refresh fails, until invalidated', async () => {
    const encrypted = await blob(realisticPayload())
    let up = true
    const stale: unknown[] = []
    const { server, provider } = setup(
      () => (up ? Response.json({ encrypted }) : new Response('bad gateway', { status: 502 })),
      { onStale: (error: unknown) => stale.push(error) }
    )
    const first = await provider.get()
    up = false
    setSystemTime(Date.now() + 30 * 60_000 + 1)
    expect(await provider.get()).toBe(first)
    expect(stale).toHaveLength(1)
    expect(String(stale[0])).toContain('HTTP 502')
    expect(await provider.get()).toBe(first)
    expect(server.calls).toHaveLength(2)
    setSystemTime(Date.now() + 60_001)
    expect(await provider.get()).toBe(first)
    expect(server.calls).toHaveLength(3)
    provider.invalidate()
    await expect(provider.get()).rejects.toThrow('HTTP 502')
    expect(server.calls).toHaveLength(4)
  })

  test('times out a hung pull', async () => {
    const { provider } = setup(hang, { timeoutMs: 20 })
    await expect(provider.get()).rejects.toThrow('登录同步服务器 https://login-sync.test 响应超时')
  })
})
