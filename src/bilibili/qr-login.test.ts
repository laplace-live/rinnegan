import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QR_CODE_STATUS, QR_LOGIN_ENDPOINTS } from '@laplace.live/bilibili-qr'

import type { FetchLike } from '@/util/fetch'

import { credentialsFromQRLogin, loadQRLogin, loginWithQRCode, saveQRLogin } from '@/bilibili/qr-login'
import { fakePassport, QR_COOKIE, QR_CREDENTIALS, qrLogin } from '@/testing/qr-login'

const { SUCCESS, WAITING_SCAN, WAITING_CONFIRM, EXPIRED } = QR_CODE_STATUS

/** Logs in without waiting between polls, noting each code shown and each scan. */
function login(fetch: FetchLike) {
  const shown: string[] = []
  const result = loginWithQRCode({
    fetch,
    pollIntervalMs: 0,
    onCode: (url, attempt) => shown.push(`code ${attempt}: ${new URL(url).searchParams.get('qrcode_key')}`),
    onScanned: () => shown.push('scanned'),
  })
  return { result, shown }
}

/** Expects the login to reject with exactly `message` once Bilibili answers a poll with `poll`. */
function pollFails(poll: () => Response | Promise<Response>, message: string) {
  const passport = fakePassport([])
  const fetch: FetchLike = (url, init) => (url.startsWith(QR_LOGIN_ENDPOINTS.POLL) ? poll() : passport.fetch(url, init))
  return expect(login(fetch).result).rejects.toThrow(new Error(message))
}

describe('loginWithQRCode', () => {
  test('polls one code at a time until the app confirms it', async () => {
    const passport = fakePassport([WAITING_SCAN, WAITING_CONFIRM, WAITING_CONFIRM, SUCCESS])
    const { result, shown } = login(passport.fetch)
    expect(await result).toEqual({ credentials: QR_CREDENTIALS, refreshToken: 'refresh-token' })
    expect(shown).toEqual(['code 1: key1', 'scanned'])
    expect(passport.polls).toEqual(['key1', 'key1', 'key1', 'key1'])
  })

  test('shows a new code when one expires and gives up after the third', async () => {
    const renewed = login(fakePassport([WAITING_CONFIRM, EXPIRED, WAITING_CONFIRM, SUCCESS]).fetch)
    expect((await renewed.result).credentials).toEqual(QR_CREDENTIALS)
    expect(renewed.shown).toEqual(['code 1: key1', 'scanned', 'code 2: key2', 'scanned'])

    const passport = fakePassport([WAITING_SCAN, EXPIRED, EXPIRED, EXPIRED, SUCCESS])
    const expired = login(passport.fetch)
    await expect(expired.result).rejects.toThrow(new Error('连续 3 个二维码都已过期'))
    expect(expired.shown).toEqual(['code 1: key1', 'code 2: key2', 'code 3: key3'])
    expect(passport.polls).toEqual(['key1', 'key1', 'key2', 'key3'])
  })

  test('describes failures in Chinese', async () => {
    await pollFails(() => new Response('', { status: 412 }), 'B 站返回 HTTP 412，可能被风控拦截')
    await pollFails(() => Response.json({ code: -400, message: '请求错误' }), 'B 站拒绝了请求：请求错误（code -400）')
    await pollFails(() => Response.json({ code: -400 }), 'B 站拒绝了请求：未知错误（code -400）')
    await pollFails(() => new Response('<html>'), 'B 站的响应格式无法识别')
    await pollFails(() => Response.json({ code: 0, data: { code: SUCCESS, url: '' } }), '已确认登录，但没能取得 Cookie')
    await pollFails(
      () => Response.json({ code: 0, data: { code: 86039, message: '二维码已失效' } }),
      'B 站返回了未知的扫码状态：二维码已失效（code 86039）'
    )
    await pollFails(() => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')), '请求 B 站超时')
    await pollFails(() => Promise.reject(new TypeError('Unable to connect')), '无法连接 B 站：Unable to connect')
  })
})

describe('saved QR login', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  test('credentialsFromQRLogin builds the Cookie header and leaves out a missing ckMd5', () => {
    expect(credentialsFromQRLogin(QR_CREDENTIALS)).toEqual({ cookie: QR_COOKIE, csrf: 'qrcsrf', uid: 9 })
    expect(credentialsFromQRLogin({ ...QR_CREDENTIALS, DedeUserID__ckMd5: undefined }).cookie).toBe(
      'SESSDATA=qr-sess%2C1792540800%2Cab*cd; DedeUserID=9; bili_jct=qrcsrf'
    )
  })

  test('saves owner-only, replacing the previous login in one step', async () => {
    dir = mkdtempSync(join(tmpdir(), 'rinnegan-qr-'))
    const path = join(dir, 'data', 'login.json')
    await saveQRLogin(path, qrLogin({ bili_jct: 'old' }))
    chmodSync(path, 0o644)
    await saveQRLogin(path, qrLogin())
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(dir, 'data'))).toEqual(['login.json'])
    expect(await Bun.file(path).json()).toEqual({ credentials: QR_CREDENTIALS, refreshToken: 'refresh-token' })
    expect(await loadQRLogin(path)).toEqual({ cookie: QR_COOKIE, csrf: 'qrcsrf', uid: 9 })
  })

  test('explains a missing or damaged login without quoting it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'rinnegan-qr-'))
    const path = join(dir, 'login.json')
    await expect(loadQRLogin(path)).rejects.toThrow(new Error(`找不到扫码登录 ${path}，请先运行 rinnegan login`))
    const { DedeUserID__ckMd5, ...withoutCkMd5 } = QR_CREDENTIALS
    await saveQRLogin(path, { credentials: withoutCkMd5, refreshToken: '' })
    expect((await loadQRLogin(path)).uid).toBe(9)

    const damaged = [
      '{"credentials": {"SESSDATA": "secret-sess"',
      JSON.stringify({ credentials: { SESSDATA: 'secret-sess', DedeUserID: 9 } }),
      JSON.stringify(qrLogin({ SESSDATA: '' })),
      JSON.stringify(qrLogin({ bili_jct: 'a;b' })),
      JSON.stringify(qrLogin({ DedeUserID__ckMd5: 'x\r\ny' })),
      JSON.stringify(qrLogin({ DedeUserID: 0 })),
    ]
    for (const text of damaged) {
      writeFileSync(path, text)
      await expect(loadQRLogin(path)).rejects.toThrow(new Error(`扫码登录 ${path} 已损坏，请重新运行 rinnegan login`))
    }
  })
})
