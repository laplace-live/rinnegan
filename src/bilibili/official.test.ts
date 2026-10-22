import { describe, expect, test } from 'bun:test'

import { BilibiliClient } from '@/bilibili'

/** The requests Bilibili's own room-admin UI sends, as captured by the maintainer. */
// Placeholder of the same shape; the captured session token stays out of the repository.
const CSRF = 'fedcba9876543210fedcba9876543210'
const OFFICIAL = {
  ban: {
    url: 'https://api.live.bilibili.com/xlive/web-ucenter/v1/banned/AddSilentUser',
    body: `room_id=456117&tuid=3493260125276695&msg=%E7%AC%AC%E4%B8%80%E5%8D%B7%20%E7%AC%AC%E4%B8%80%E7%AB%A0%20%E5%8F%8D%E6%AD%A3%E6%AF%94%E4%BC%81%E8%B0%B7%E5%85%AB%E5%B9%A1%E5%B0%B1%E6%98%AF%E4%B8%80%E5%89%AF%E6%AD%BB%E9%B1%BC%E7%9C%BC&mobile_app=web&type=1&hour=-1&csrf_token=${CSRF}&csrf=${CSRF}&visit_id=`,
  },
  unban: {
    url: 'https://api.live.bilibili.com/xlive/web-ucenter/v1/banned/DelSilentUser',
    body: `tuid=3493260125276695&room_id=456117&mobi_app=web&csrf_token=${CSRF}&csrf=${CSRF}&visit_id=`,
  },
  list: {
    url: 'https://api.live.bilibili.com/xlive/web-ucenter/v1/banned/GetSilentUserList',
    body: `room_id=456117&ps=1&csrf_token=${CSRF}&csrf=${CSRF}&visit_id=`,
  },
}

function capture() {
  const calls: { url: string; init: RequestInit }[] = []
  const client = new BilibiliClient({
    credentials: () => ({ cookie: `SESSDATA=x; bili_jct=${CSRF}`, csrf: CSRF, uid: 1 }),
    fetch: (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ code: 0, message: '0', data: {} }))
    },
  })
  return { calls, client }
}

describe('requests match Bilibili’s own frontend byte for byte', () => {
  test('AddSilentUser (ban forever)', async () => {
    const { calls, client } = capture()
    await client.addSilentUser(456117, 3493260125276695, '第一卷 第一章 反正比企谷八幡就是一副死鱼眼')
    expect(calls[0]?.url).toBe(OFFICIAL.ban.url)
    expect(calls[0]?.init.method).toBe('POST')
    expect(calls[0]?.init.body).toBe(OFFICIAL.ban.body)
    const headers = new Headers(calls[0]?.init.headers)
    expect(headers.get('referer')).toBe('https://live.bilibili.com/456117')
    expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded')
    expect(headers.get('accept')).toBe('application/json, text/plain, */*')
  })

  test('DelSilentUser', async () => {
    const { calls, client } = capture()
    await client.delSilentUser(456117, 3493260125276695)
    expect(calls[0]?.url).toBe(OFFICIAL.unban.url)
    expect(calls[0]?.init.body).toBe(OFFICIAL.unban.body)
  })

  test('GetSilentUserList', async () => {
    const { calls, client } = capture()
    await client.getSilentUsers(456117, 1)
    expect(calls[0]?.url).toBe(OFFICIAL.list.url)
    expect(calls[0]?.init.body).toBe(OFFICIAL.list.body)
  })
})
