import { describe, expect, test } from 'bun:test'

import type { BilibiliClientOptions } from '@/bilibili/client'
import type { ApiResult, BilibiliCredentials } from '@/bilibili/types'
import type { FetchCall } from '@/testing/fetch'

import {
  BAD_RESPONSE,
  BilibiliApiError,
  BilibiliClient,
  DEFAULT_USER_AGENT,
  describeResult,
  isAlreadyBanned,
  isAuthFailure,
  isNotBanned,
  NETWORK_ERROR,
  NO_CREDENTIALS,
  normalizeReason,
} from '@/bilibili/client'
import { hang, only, recordingFetch } from '@/testing/fetch'

const ROOM = 456117
const UID = 3493260125276695
const CSRF = '0123456789abcdef0123456789abcdef'
const CREDENTIALS: BilibiliCredentials = {
  cookie: `buvid3=B3C4D5E6infoc; SESSDATA=a1b2c3d4%2C1792540800%2Ce5f6a*a1; bili_jct=${CSRF}; DedeUserID=12345678`,
  csrf: CSRF,
  uid: 12345678,
}
const OK = { code: 0, message: '0', ttl: 1, data: {} }

function setup(
  handler: (call: FetchCall) => Response | Promise<Response> = () => Response.json(OK),
  options: Partial<BilibiliClientOptions> = {}
) {
  const { fetch, calls } = recordingFetch(handler)
  let credentialCalls = 0
  const client = new BilibiliClient({
    credentials: () => {
      credentialCalls++
      return CREDENTIALS
    },
    fetch,
    ...options,
  })
  return { client, calls, credentialCalls: () => credentialCalls }
}

function field(call: FetchCall, name: string): string | null {
  return new URLSearchParams(call.body ?? '').get(name)
}

function expectFormHeaders(call: FetchCall, room: number) {
  expect(Object.fromEntries(call.headers)).toEqual({
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/x-www-form-urlencoded',
    referer: `https://live.bilibili.com/${room}`,
    origin: 'https://live.bilibili.com',
    'user-agent': DEFAULT_USER_AGENT,
    cookie: CREDENTIALS.cookie,
  })
}

function apiResult(patch: Partial<ApiResult>): ApiResult {
  return { ok: false, code: 0, message: '', data: null, status: 200, ...patch }
}

describe('silent-user requests', () => {
  test('addSilentUser posts the official ban form', async () => {
    const { client, calls } = setup()
    const result = await client.addSilentUser(ROOM, UID, '独轮车 loop')
    expect(result).toEqual({ ok: true, code: 0, message: '0', data: {}, status: 200 })
    const call = only(calls)
    expect(call.url).toBe('https://api.live.bilibili.com/xlive/web-ucenter/v1/banned/AddSilentUser')
    expect(call.method).toBe('POST')
    expect(call.body).toBe(
      'room_id=456117&tuid=3493260125276695&msg=%E7%8B%AC%E8%BD%AE%E8%BD%A6%20loop&mobile_app=web&type=1&hour=-1' +
        `&csrf_token=${CSRF}&csrf=${CSRF}&visit_id=`
    )
    expectFormHeaders(call, ROOM)
  })

  test('addSilentUser sends a custom duration and user agent', async () => {
    const { client, calls } = setup(undefined, { userAgent: 'TestAgent/1.0' })
    await client.addSilentUser(ROOM, UID, '刷屏', 720)
    const call = only(calls)
    expect(field(call, 'hour')).toBe('720')
    expect(call.headers.get('user-agent')).toBe('TestAgent/1.0')
  })

  test('delSilentUser posts the official unban form', async () => {
    const { client, calls } = setup()
    const result = await client.delSilentUser(ROOM, UID)
    expect(result.ok).toBe(true)
    const call = only(calls)
    expect(call.url).toBe('https://api.live.bilibili.com/xlive/web-ucenter/v1/banned/DelSilentUser')
    expect(call.method).toBe('POST')
    expect(call.body).toBe(
      `tuid=3493260125276695&room_id=456117&mobi_app=web&csrf_token=${CSRF}&csrf=${CSRF}&visit_id=`
    )
    expectFormHeaders(call, ROOM)
  })

  test('getSilentUsers posts the official list form with the page number in ps', async () => {
    const { client, calls } = setup()
    await client.getSilentUsers(23058)
    await client.getSilentUsers(23058, 3)
    expect(calls).toHaveLength(2)
    const [first, third] = calls as [FetchCall, FetchCall]
    expect(first.url).toBe('https://api.live.bilibili.com/xlive/web-ucenter/v1/banned/GetSilentUserList')
    expect(first.method).toBe('POST')
    expect(first.body).toBe(`room_id=23058&ps=1&csrf_token=${CSRF}&csrf=${CSRF}&visit_id=`)
    expect(third.body).toBe(`room_id=23058&ps=3&csrf_token=${CSRF}&csrf=${CSRF}&visit_id=`)
    expectFormHeaders(first, 23058)
  })

  test('resolves credentials for every request so rotated cookies apply', async () => {
    let version = 0
    const { client, calls } = setup(undefined, {
      credentials: async () => {
        version++
        return { cookie: `SESSDATA=s${version}`, csrf: `c${version}`, uid: null }
      },
    })
    await client.delSilentUser(ROOM, UID)
    await client.delSilentUser(ROOM, UID)
    expect(calls.map(call => call.headers.get('cookie'))).toEqual(['SESSDATA=s1', 'SESSDATA=s2'])
    expect(calls.map(call => [field(call, 'csrf_token'), field(call, 'csrf')])).toEqual([
      ['c1', 'c1'],
      ['c2', 'c2'],
    ])
  })
})

describe('auth failures', () => {
  const DENIED = { code: -101, message: '账号未登录', ttl: 1 }

  test('refresh once through onAuthFailure, then retry with the new cookies', async () => {
    let version = 1
    const failures: number[] = []
    const { client, calls } = setup(call => Response.json(call.headers.get('cookie') === 'SESSDATA=s1' ? DENIED : OK), {
      credentials: () => ({ cookie: `SESSDATA=s${version}`, csrf: `c${version}`, uid: null }),
      onAuthFailure: result => {
        failures.push(result.code)
        version++
      },
    })
    expect((await client.addSilentUser(ROOM, UID, '独轮车')).ok).toBe(true)
    expect(failures).toEqual([-101])
    expect(calls.map(call => field(call, 'csrf'))).toEqual(['c1', 'c2'])
  })

  test('give up after one retry', async () => {
    let failures = 0
    const { client, calls } = setup(() => Response.json(DENIED), {
      onAuthFailure: () => {
        failures++
      },
    })
    expect((await client.delSilentUser(ROOM, UID)).code).toBe(-101)
    expect(failures).toBe(1)
    expect(calls).toHaveLength(2)
  })
})

describe('ban reason', () => {
  test('trims, collapses whitespace and drops invisible characters', () => {
    expect(normalizeReason('  独轮车：刷屏  ')).toBe('独轮车：刷屏')
    expect(normalizeReason('第一行\n\n第二行\t第三行')).toBe('第一行 第二行 第三行')
    expect(normalizeReason('独\u200b轮\u200d车\ufeff')).toBe('独轮车')
    expect(normalizeReason('千\u3164舰')).toBe('千舰')
  })

  test('keeps emoji sequences intact', () => {
    expect(normalizeReason('独轮车 👨‍👩‍👧 🏴󠁧󠁢󠁳󠁣󠁴󠁿')).toBe('独轮车 👨‍👩‍👧 🏴󠁧󠁢󠁳󠁣󠁴󠁿')
  })

  test('falls back to 独轮车 when nothing is left', () => {
    for (const reason of ['', '   ', '\n\t', '\u200b\u200c\u2060']) expect(normalizeReason(reason)).toBe('独轮车')
  })

  test('caps at 60 graphemes without splitting one', () => {
    expect(normalizeReason('刷'.repeat(70))).toBe('刷'.repeat(60))
    expect(normalizeReason('🇨🇳'.repeat(61))).toBe('🇨🇳'.repeat(60))
    expect(normalizeReason('e\u0301'.repeat(61))).toBe('e\u0301'.repeat(60))
    expect(normalizeReason(`${'a'.repeat(59)} b`)).toBe('a'.repeat(59))
  })

  test('addSilentUser sends the normalized reason', async () => {
    const { client, calls } = setup()
    await client.addSilentUser(ROOM, UID, ` ${'刷'.repeat(80)} `)
    await client.addSilentUser(ROOM, UID, '  \n ')
    expect(calls.map(call => field(call, 'msg'))).toEqual(['刷'.repeat(60), '独轮车'])
    expect(calls[1]?.body).toContain('&msg=%E7%8B%AC%E8%BD%AE%E8%BD%A6&')
  })
})

describe('silent-user list parsing', () => {
  async function listPage(body: unknown) {
    const { client } = setup(() => Response.json(body))
    return client.getSilentUsers(ROOM)
  }

  test('tuid/tname items with the operator in uid/name', async () => {
    const item = {
      id: 9,
      tuid: UID,
      tname: '复读机',
      uid: 12345678,
      name: '房管A',
      ctime: '2026-10-20 12:00:00',
      face: 'https://i0.hdslb.com/bfs/face/x.jpg',
    }
    const page = await listPage({ code: 0, message: '0', ttl: 1, data: { data: [item], total: 1, total_page: 1 } })
    expect(page.result.ok).toBe(true)
    expect(page.users).toEqual([
      {
        uid: UID,
        uname: '复读机',
        operatorName: '房管A',
        createdAt: '2026-10-20 12:00:00',
        remainingSec: null,
      },
    ])
    expect(page.totalPages).toBe(1)
  })

  test('list items with uid/uname, admin_name and left_time', async () => {
    const item = { uid: 42, uname: 'spammer', admin_name: '主播', created_at: '2026-10-21 08:30:00', left_time: 3600 }
    const page = await listPage({ code: 0, data: { list: [item], page: { total_page: 4 } } })
    expect(page.users).toEqual([
      {
        uid: 42,
        uname: 'spammer',
        operatorName: '主播',
        createdAt: '2026-10-21 08:30:00',
        remainingSec: 3600,
      },
    ])
    expect(page.totalPages).toBe(4)
  })

  test('a bare array with string uids, a name without tname and unix ctime', async () => {
    const ctime = Date.UTC(2026, 9, 20, 4, 0, 0) / 1000
    const seconds = { uid: '3493260125276695', name: '路人', ctime, remain_time: '120' }
    const millis = { uid: 7, uname: 'b', operator_name: '房管B', ctime: ctime * 1000, left_time: -1 }
    const page = await listPage({ code: 0, data: [seconds, millis] })
    expect(page.users).toEqual([
      {
        uid: UID,
        uname: '路人',
        operatorName: null,
        createdAt: '2026-10-20 12:00:00',
        remainingSec: 120,
      },
      { uid: 7, uname: 'b', operatorName: '房管B', createdAt: '2026-10-20 12:00:00', remainingSec: null },
    ])
    expect(page.totalPages).toBeNull()
  })

  test('items with total pages derived from total and page_size', async () => {
    const page = await listPage({ code: 0, data: { items: [{ uid: 1 }], page: { total: 45, page_size: 20 } } })
    expect(page.users.map(user => user.uid)).toEqual([1])
    expect(page.totalPages).toBe(3)
    expect((await listPage({ code: 0, data: { items: [], total: 0, page_size: 20 } })).totalPages).toBe(0)
  })

  test('skips items without a usable target uid', async () => {
    const items = [null, 'x', 7, { uname: 'no uid' }, { tuid: 0, uid: 5, tname: 'bad' }, { uid: -1 }, { uid: 1.5 }]
    const page = await listPage({ code: 0, data: { data: [...items, { tuid: 77, tname: 'ok', left_time: 0 }] } })
    expect(page.users).toHaveLength(1)
    expect(page.users[0]).toMatchObject({ uid: 77, uname: 'ok', operatorName: null, remainingSec: null })
  })

  test('no users for a failed or unrecognized page', async () => {
    expect(await listPage({ code: -403, message: '访问权限不足' })).toEqual({
      result: { ok: false, code: -403, message: '访问权限不足', data: null, status: 200 },
      users: [],
      totalPages: null,
    })
    const odd = await listPage({ code: 0, data: { something: 'else' } })
    expect(odd.users).toEqual([])
    expect(odd.totalPages).toBeNull()
  })
})

describe('getAllSilentUsers', () => {
  const user = (uid: number) => ({ tuid: uid, tname: `u${uid}`, uid: 1, name: 'admin' })

  function paged(reply: (page: number) => unknown) {
    return setup(call => Response.json(reply(Number(field(call, 'ps')))))
  }

  test('follows total_page', async () => {
    const { client, calls } = paged(page => ({
      code: 0,
      data: { data: page === 1 ? [user(1), user(2)] : [user(3)], total_page: 2 },
    }))
    expect((await client.getAllSilentUsers(ROOM)).map(u => u.uid)).toEqual([1, 2, 3])
    expect(calls.map(call => field(call, 'ps'))).toEqual(['1', '2'])
  })

  test('stops on an empty page when the total is unknown', async () => {
    const { client, calls } = paged(page => ({ code: 0, data: { data: page <= 2 ? [user(page)] : [] } }))
    expect((await client.getAllSilentUsers(ROOM)).map(u => u.uid)).toEqual([1, 2])
    expect(calls).toHaveLength(3)
  })

  test('stops when a page brings nothing new', async () => {
    const { client, calls } = paged(() => ({ code: 0, data: { data: [user(1), user(2)] } }))
    expect((await client.getAllSilentUsers(ROOM)).map(u => u.uid)).toEqual([1, 2])
    expect(calls).toHaveLength(2)
  })

  test('stops at maxPages', async () => {
    const { client, calls } = paged(page => ({ code: 0, data: { data: [user(page)] } }))
    expect((await client.getAllSilentUsers(ROOM, 3)).map(u => u.uid)).toEqual([1, 2, 3])
    expect(calls).toHaveLength(3)
  })

  test('throws BilibiliApiError on a failed page', async () => {
    const { client } = paged(page =>
      page === 1 ? { code: 0, data: { data: [user(1)] } } : { code: -101, message: '账号未登录', ttl: 1 }
    )
    const error = await client.getAllSilentUsers(ROOM).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(BilibiliApiError)
    expect((error as BilibiliApiError).result.code).toBe(-101)
    expect((error as BilibiliApiError).message).toBe('获取直播间 456117 禁言列表第 2 页失败：账号未登录（code -101）')
  })
})

describe('transport failures become results', () => {
  test('a network error is code -1', async () => {
    const { client } = setup(() => {
      throw new TypeError('fetch failed')
    })
    expect(await client.addSilentUser(ROOM, UID, '独轮车')).toEqual({
      ok: false,
      code: NETWORK_ERROR,
      message: '网络错误：fetch failed',
      data: null,
      status: 0,
    })
  })

  test('a timeout is code -1', async () => {
    const { client, calls } = setup(hang, { timeoutMs: 20 })
    const result = await client.delSilentUser(ROOM, UID)
    expect(result).toEqual({ ok: false, code: NETWORK_ERROR, message: '请求超时（20 ms）', data: null, status: 0 })
    expect(only(calls).signal?.aborted).toBe(true)
  })

  test('a WAF page is code -2 with the HTTP status', async () => {
    const { client } = setup(
      () =>
        new Response('<html><body>412 Precondition Failed</body></html>', {
          status: 412,
          headers: { 'content-type': 'text/html' },
        })
    )
    const page = await client.getSilentUsers(ROOM)
    expect(page.users).toEqual([])
    expect(page.result).toMatchObject({ ok: false, code: BAD_RESPONSE, data: null, status: 412 })
    expect(describeResult(page.result)).toBe('响应不是 JSON，可能被风控或防火墙拦截（code -2，HTTP 412）')
  })

  test('JSON without a code is code -2', async () => {
    const { client } = setup(() => Response.json({ hello: 'world' }))
    expect(await client.addSilentUser(ROOM, UID, '独轮车')).toMatchObject({
      ok: false,
      code: BAD_RESPONSE,
      status: 200,
    })
  })

  test('a failing credentials callback is code -3 and sends nothing', async () => {
    const { client, calls } = setup(undefined, {
      credentials: () => {
        throw new Error('登录同步令牌无效')
      },
    })
    expect(await client.addSilentUser(ROOM, UID, '独轮车')).toEqual({
      ok: false,
      code: NO_CREDENTIALS,
      message: '无法获取 Bilibili 登录凭据：登录同步令牌无效',
      data: null,
      status: 0,
    })
    expect((await client.getSilentUsers(ROOM)).result.code).toBe(NO_CREDENTIALS)
    expect(calls).toHaveLength(0)
  })

  test('business errors keep their code, msg and data', async () => {
    const { client } = setup(() => Response.json({ code: 1, msg: '房间不存在', data: [] }))
    expect(await client.delSilentUser(ROOM, UID)).toEqual({
      ok: false,
      code: 1,
      message: '房间不存在',
      data: [],
      status: 200,
    })
  })

  test('an HTTP error status fails even with code 0', async () => {
    const { client } = setup(() => Response.json(OK, { status: 500 }))
    expect(await client.delSilentUser(ROOM, UID)).toMatchObject({ ok: false, code: 0, status: 500 })
  })
})

describe('result helpers', () => {
  test('isAuthFailure', () => {
    expect(isAuthFailure(apiResult({ code: -101, message: '账号未登录' }))).toBe(true)
    expect(isAuthFailure(apiResult({ code: -111, message: 'csrf 校验失败' }))).toBe(true)
    expect(isAuthFailure(apiResult({ code: BAD_RESPONSE, status: 403 }))).toBe(true)
    expect(isAuthFailure(apiResult({ code: -401, status: 401 }))).toBe(true)
    expect(isAuthFailure(apiResult({ code: -403, message: '访问权限不足' }))).toBe(false)
    expect(isAuthFailure(apiResult({ code: 1, status: 403 }))).toBe(false)
    expect(isAuthFailure(apiResult({ code: BAD_RESPONSE, status: 412 }))).toBe(false)
    expect(isAuthFailure(apiResult({ code: NETWORK_ERROR, status: 0 }))).toBe(false)
    expect(isAuthFailure(apiResult({ ok: true }))).toBe(false)
  })

  test('isAlreadyBanned', () => {
    const banned = [
      '该用户已经被禁言',
      '用户已被禁言',
      '该用户已被房管禁言了',
      '已在禁言列表中',
      '请勿重复禁言',
      '禁言记录已存在',
    ]
    for (const message of banned) expect(isAlreadyBanned(apiResult({ code: 1, message }))).toBe(true)
    const other = [
      '禁言失败',
      '该用户未被禁言',
      '没有权限禁言',
      '已经是房管无法禁言',
      '已经超过上限，禁言失败',
      '已经到达本日禁言上限',
      '账号未登录',
      '',
    ]
    for (const message of other) expect(isAlreadyBanned(apiResult({ code: 1, message }))).toBe(false)
    expect(isAlreadyBanned(apiResult({ ok: true, message: '已被禁言' }))).toBe(false)
  })

  test('isNotBanned', () => {
    const notBanned = [
      '该用户未被禁言',
      '用户不在禁言列表中',
      '该用户没有被禁言',
      '没有禁言记录',
      '未找到禁言记录',
      '禁言记录不存在',
      '禁言已解除',
    ]
    for (const message of notBanned) expect(isNotBanned(apiResult({ code: 1, message }))).toBe(true)
    const other = ['该用户已被禁言', '没有权限解除禁言', '未被授权禁言', '解除禁言失败', '用户不在房间，禁言失败', '']
    for (const message of other) expect(isNotBanned(apiResult({ code: 1, message }))).toBe(false)
    expect(isNotBanned(apiResult({ ok: true, message: '未被禁言' }))).toBe(false)
  })

  test('describeResult', () => {
    expect(describeResult(apiResult({ code: -101, message: '账号未登录' }))).toBe('账号未登录（code -101）')
    expect(describeResult(apiResult({ code: 5 }))).toBe('未知错误（code 5）')
    expect(describeResult(apiResult({ code: NETWORK_ERROR, message: '网络错误：x', status: 0 }))).toBe(
      '网络错误：x（code -1）'
    )
  })
})

describe('nav', () => {
  test('reports the logged-in account, sending the cookie', async () => {
    const { client, calls } = setup(() =>
      Response.json({
        code: 0,
        message: '0',
        ttl: 1,
        data: { isLogin: true, mid: 12345678, uname: '测试账号', money: 0 },
      })
    )
    expect(await client.nav()).toEqual({ isLogin: true, uid: 12345678, uname: '测试账号' })
    const call = only(calls)
    expect(call.url).toBe('https://api.bilibili.com/x/web-interface/nav')
    expect(call.method).toBe('GET')
    expect(call.body).toBeNull()
    expect(call.headers.get('cookie')).toBe(CREDENTIALS.cookie)
    expect(call.headers.get('content-type')).toBeNull()
  })

  test('reports 未登录 as isLogin false', async () => {
    const { client } = setup(() =>
      Response.json({ code: -101, message: '账号未登录', ttl: 1, data: { isLogin: false } })
    )
    expect(await client.nav()).toEqual({ isLogin: false, uid: 0, uname: '' })
  })

  test('throws on any other failure', async () => {
    const { client } = setup(() => new Response('<html>blocked</html>', { status: 412 }))
    const error = await client.nav().catch((error: unknown) => error)
    expect(error).toBeInstanceOf(BilibiliApiError)
    expect((error as BilibiliApiError).result).toMatchObject({ code: BAD_RESPONSE, status: 412 })
    expect((error as Error).message).toStartWith('获取 Bilibili 登录状态失败：')
  })
})

describe('resolveRoom', () => {
  test('resolves a short id without cookies', async () => {
    const { client, calls, credentialCalls } = setup(() =>
      Response.json({
        code: 0,
        msg: 'ok',
        message: 'ok',
        data: { room_id: 23058, short_id: 3, uid: 11153765, need_p2p: 0, is_hidden: false, live_status: 1 },
      })
    )
    expect(await client.resolveRoom(3)).toEqual({ roomId: 23058, shortId: 3, uid: 11153765 })
    const call = only(calls)
    expect(call.url).toBe('https://api.live.bilibili.com/room/v1/Room/room_init?id=3')
    expect(call.method).toBe('GET')
    expect(call.headers.get('cookie')).toBeNull()
    expect(call.headers.get('referer')).toBe('https://live.bilibili.com/3')
    expect(credentialCalls()).toBe(0)
  })

  test('throws a Chinese error for a missing room', async () => {
    const { client } = setup(() =>
      Response.json({ code: 60004, msg: '直播间不存在', message: '直播间不存在', data: [] })
    )
    const error = await client.resolveRoom(999999999).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(BilibiliApiError)
    expect((error as Error).message).toBe('无法解析直播间 999999999：直播间不存在（code 60004）')
    expect((error as BilibiliApiError).result.code).toBe(60004)
  })

  test('throws on a transport failure', async () => {
    const { client } = setup(() => {
      throw new TypeError('fetch failed')
    })
    await expect(client.resolveRoom(3)).rejects.toThrow('无法解析直播间 3：网络错误：fetch failed（code -1）')
  })

  test('rejects invalid ids without a request', async () => {
    const { client, calls } = setup()
    for (const id of [0, -1, 1.5, Number.NaN]) await expect(client.resolveRoom(id)).rejects.toThrow('无效的直播间号')
    expect(calls).toHaveLength(0)
  })
})
