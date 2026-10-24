import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Login } from '@/commands/session'
import type { ConfigLayer } from '@/config'

import { AuditLog, readAuditEntries } from '@/audit/audit'
import { saveQRLogin } from '@/bilibili'
import { connectBilibili, resolveLogin } from '@/commands/session'
import { DEFAULT_CONFIG, mergeConfig } from '@/config'
import { recordingFetch } from '@/testing/fetch'
import { fakeBilibili } from '@/testing/login-sync'
import { QR_COOKIE, qrLogin } from '@/testing/qr-login'

describe('login session', () => {
  let dir = ''
  let loginFile = ''
  const config = (layer: ConfigLayer = {}) => mergeConfig(DEFAULT_CONFIG, { loginFile, ...layer })
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rinnegan-session-'))
    loginFile = join(dir, 'login.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('a Login Sync token wins over a saved QR login, which needs its file', async () => {
    expect(await resolveLogin(config())).toBeNull()
    await saveQRLogin(loginFile, qrLogin())
    expect(await resolveLogin(config())).toMatchObject({ method: 'qr', label: '扫码登录' })
    expect(await resolveLogin(config({ loginSync: { token: 'uuid@pw' } }))).toMatchObject({ method: 'login-sync' })
    // Only the CLI names a default file, so in-process configs never pick up a real saved login
    expect(await resolveLogin(DEFAULT_CONFIG)).toBeNull()
  })

  test('a QR login reads the saved cookies, and reads them again once Bilibili rejects them', async () => {
    await saveQRLogin(loginFile, qrLogin({ bili_jct: 'stale' }))
    const bilibili = fakeBilibili({ uid: 9, uname: '主播' })
    const server = recordingFetch(async call => {
      if (!call.body?.includes('csrf=stale')) return bilibili.fetch(call.url, { body: call.body })
      // `rinnegan login` ran again meanwhile
      await saveQRLogin(loginFile, qrLogin({ bili_jct: 'fresh' }))
      return Response.json({ code: -111, message: 'csrf 校验失败' })
    })
    const audit = new AuditLog({ dir, mode: 'test' })
    const login = (await resolveLogin(config())) as Login
    const session = await connectBilibili(login, server.fetch, audit)
    expect(session).toMatchObject({ nav: { isLogin: true, uid: 9, uname: '主播' }, cookies: 4 })

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

  test('explains an expired or missing QR login', async () => {
    await saveQRLogin(loginFile, qrLogin())
    const { fetch } = fakeBilibili({ uid: 9, uname: '主播', isLogin: false })
    const login = (await resolveLogin(config())) as Login
    await expect(connectBilibili(login, fetch)).rejects.toThrow(
      new Error('无法登录 B 站：扫码登录已失效，请重新运行 rinnegan login')
    )
    const gone = (await resolveLogin(config())) as Login
    rmSync(loginFile)
    await expect(connectBilibili(gone, fetch)).rejects.toThrow(
      new Error(`无法登录 B 站：找不到扫码登录 ${loginFile}，请先运行 rinnegan login`)
    )
  })
})
