import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ConfigLayer } from '@/config'

import { AuditLog, readAuditEntries } from '@/audit/audit'
import { saveQRLogin } from '@/bilibili'
import { connectBilibili, loginMethod } from '@/commands/session'
import { DEFAULT_CONFIG, mergeConfig } from '@/config'
import { recordingFetch } from '@/testing/fetch'
import { QR_COOKIE, qrLogin } from '@/testing/qr-login'

const NAV = { code: 0, data: { isLogin: true, mid: 9, uname: '主播' } }

describe('login session', () => {
  let dir = ''
  let loginFile = ''
  const config = (layer: ConfigLayer = {}) => mergeConfig(DEFAULT_CONFIG, { loginFile, ...layer })
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })
  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), 'rinnegan-session-'))
    loginFile = join(dir, 'login.json')
  }

  test('a Login Sync token wins over a saved QR login, which needs its file', async () => {
    setup()
    expect(await loginMethod(config())).toBeNull()
    await saveQRLogin(loginFile, qrLogin())
    expect(await loginMethod(config())).toBe('qr')
    expect(await loginMethod(config({ loginSync: { token: 'uuid@pw' } }))).toBe('login-sync')
  })

  test('a QR login reads the saved cookies, and reads them again once Bilibili rejects them', async () => {
    setup()
    await saveQRLogin(loginFile, qrLogin({ bili_jct: 'stale' }))
    const server = recordingFetch(async call => {
      if (call.url.includes('/x/web-interface/nav')) return Response.json(NAV)
      if (call.body?.includes('csrf=stale')) {
        // `rinnegan login` ran again meanwhile
        await saveQRLogin(loginFile, qrLogin({ bili_jct: 'fresh' }))
        return Response.json({ code: -111, message: 'csrf 校验失败' })
      }
      return Response.json({ code: 0, message: '0', data: {} })
    })
    const audit = new AuditLog({ dir, mode: 'test' })
    const session = await connectBilibili(config(), 'qr', server.fetch, audit)
    expect(session).toMatchObject({ nav: { isLogin: true, uid: 9, uname: '主播' }, method: 'qr', cookies: 4 })

    expect((await session.client.delSilentUser(1, 2)).ok).toBe(true)
    const stale = QR_COOKIE.replace('bili_jct=qrcsrf', 'bili_jct=stale')
    const fresh = QR_COOKIE.replace('bili_jct=qrcsrf', 'bili_jct=fresh')
    expect(server.calls.map(call => call.headers.get('cookie'))).toEqual([stale, stale, fresh])
    const entries = await readAuditEntries(audit.path)
    expect(entries.filter(entry => entry.event === 'credentials-refresh')).toMatchObject([
      { reason: '-111 csrf 校验失败' },
    ])
    expect(JSON.stringify(entries)).not.toContain('qr-sess')
  })

  test('explains an expired QR login', async () => {
    setup()
    await saveQRLogin(loginFile, qrLogin())
    const { fetch } = recordingFetch(() =>
      Response.json({ code: -101, message: '账号未登录', data: { isLogin: false } })
    )
    await expect(connectBilibili(config(), 'qr', fetch)).rejects.toThrow(
      '无法使用扫码登录：B 站登录已失效，请重新运行 rinnegan login'
    )
    rmSync(loginFile)
    await expect(connectBilibili(config(), 'qr', fetch)).rejects.toThrow(
      `无法使用扫码登录：找不到扫码登录 ${loginFile}，请先运行 rinnegan login`
    )
  })
})
