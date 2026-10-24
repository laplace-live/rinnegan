import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QR_CODE_STATUS } from '@laplace.live/bilibili-qr'

import type { ConfigLayer } from '@/config'

import { loadQRLogin } from '@/bilibili'
import { runLogin } from '@/commands/login'
import { DEFAULT_CONFIG, mergeConfig } from '@/config'
import { fakePassport, QR_COOKIE, qrCodeUrl } from '@/testing/qr-login'
import { stdoutHasColors } from '@/util/console'
import { renderQRCode } from '@/util/qr'

const { SUCCESS, WAITING_SCAN, WAITING_CONFIRM } = QR_CODE_STATUS

describe('rinnegan login', () => {
  let dir = ''
  let output: string[] = []
  let spies: { mockRestore(): void }[] = []
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rinnegan-login-'))
    output = []
    spies = (['log', 'warn', 'error'] as const).map(method =>
      spyOn(console, method).mockImplementation((...args: unknown[]) => {
        output.push(args.join(' '))
      })
    )
  })
  afterEach(() => {
    for (const spy of spies) spy.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  })

  async function login(passport: ReturnType<typeof fakePassport>, layer: ConfigLayer = {}) {
    const loginFile = join(dir, 'data', 'login.json')
    const config = mergeConfig(DEFAULT_CONFIG, { loginFile, ...layer })
    const code = await runLogin({ config, fetch: passport.fetch, pollIntervalMs: 0 })
    return { code, loginFile, out: output.join('\n') }
  }

  test('draws the code, waits for the app and saves the cookies', async () => {
    const passport = fakePassport([WAITING_SCAN, WAITING_CONFIRM, SUCCESS])
    const { code, loginFile, out } = await login(passport, { loginSync: { token: 'uuid@pw' } })
    expect(code).toBe(0)
    expect(await loadQRLogin(loginFile)).toEqual({ cookie: QR_COOKIE, csrf: 'qrcsrf', uid: 9 })
    expect(out).toContain(renderQRCode(qrCodeUrl('key1'), stdoutHasColors()))
    expect(out).toContain('已扫码，请在 App 中确认登录')
    expect(out).toContain(`登录账号 主播（9）· 已保存到 ${loginFile}`)
    expect(out).toContain('已配置 LOGIN_SYNC_TOKEN，live / bans / unban 仍会优先使用 Login Sync')
    expect(out).not.toContain('qr-sess')
  })

  test('saves the cookies when only the account check fails', async () => {
    const passport = fakePassport([SUCCESS])
    const { code, loginFile, out } = await login({
      ...passport,
      fetch: (url, init) => (url.includes('/x/web-interface/nav') ? new Response('busy') : passport.fetch(url, init)),
    })
    expect(code).toBe(0)
    expect(out).toContain('无法确认登录状态')
    expect(out).toContain(`登录账号 UID 9 · 已保存到 ${loginFile}`)
    expect((await loadQRLogin(loginFile)).csrf).toBe('qrcsrf')
  })

  test('saves nothing when Bilibili turns the cookies down', async () => {
    const { code, loginFile, out } = await login(fakePassport([SUCCESS], { isLogin: false }))
    expect(code).toBe(1)
    expect(out).toContain('扫码登录失败：B 站没有接受这次登录的 Cookie，请重试')
    expect(existsSync(loginFile)).toBe(false)
  })

  test('gives up once every code has expired', async () => {
    const { code, loginFile, out } = await login(fakePassport([]))
    expect(code).toBe(1)
    expect(out).toContain(renderQRCode(qrCodeUrl('key3'), stdoutHasColors()))
    expect(out).toContain('二维码已过期，换一个新的')
    expect(out).toContain('扫码登录失败：连续 3 个二维码都已过期')
    expect(existsSync(loginFile)).toBe(false)
  })
})
