import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { messageEvent } from '@/testing/events'
import { simulateChatterboxLoop } from '@/testing/simulate'

const dir = mkdtempSync(join(tmpdir(), 'rinnegan-cli-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** The test's env without the settings `configFromEnv` reads. */
const hostEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !/^(RINNEGAN|LOGIN_SYNC)_/.test(name))
)

async function cli(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  // Run from the temp dir so a local rinnegan.config.json can't filter rooms or change thresholds either.
  const proc = Bun.spawn(['bun', join(import.meta.dir, 'cli.ts'), ...args], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...hostEnv, NO_COLOR: '1', LOGIN_SYNC_TOKEN: '', RINNEGAN_LOG_DIR: join(dir, 'logs') },
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out, err }
}

describe('rinnegan CLI', () => {
  test('help and version', async () => {
    const help = await cli('--help')
    expect(help.code).toBe(0)
    expect(help.out).toContain('rinnegan offline')
    expect(help.out).toContain('--login-sync-token')
    expect(help.out).toContain('rinnegan login')
    expect(help.out).toContain('--login-file')
    const version = await cli('--version')
    expect(version.out.trim()).toMatch(/^\d+\.\d+\.\d+$/)
  })

  test('rejects unknown commands, flags and missing files', async () => {
    expect((await cli('frobnicate')).code).toBe(2)
    const flag = await cli('offline', '--bogus', 'x.lca')
    expect(flag.code).toBe(1)
    const missing = await cli('offline', join(dir, 'nope.lca'))
    expect(missing.code).toBe(1)
    expect(missing.err).toContain('找不到归档文件')
  })

  test('looks for a saved QR login in data/bilibili-login.json', async () => {
    const none = await cli('bans', '--room', '1', '--remote')
    expect(none.code).toBe(1)
    expect(none.err).toContain('未提供 LOGIN_SYNC_TOKEN，也未扫码登录（rinnegan login），无法访问禁言接口')
    // Damaged, so it fails before any request
    const path = join(dir, 'data', 'bilibili-login.json')
    await Bun.write(path, '{}')
    const damaged = await cli('bans', '--room', '1', '--remote')
    rmSync(path)
    expect(damaged.code).toBe(1)
    expect(damaged.err).toContain('无法登录 B 站：扫码登录 data/bilibili-login.json 已损坏')
  })

  test('offline ranks an injected loop and writes reports', async () => {
    const messages = simulateChatterboxLoop({
      persona: { uid: 4242, uname: 'loop-bot', roomId: 1 },
      template: '关注主播谢谢喵',
      startAt: Date.parse('2026-10-20T12:00:00Z'),
      durationMs: 60_000,
      randomChar: '­',
    })
    const events = messages.map(message => messageEvent(message))
    const archive = join(dir, 'room.lca')
    await Bun.write(archive, Bun.gzipSync(new TextEncoder().encode(JSON.stringify([{ name: 'main', data: events }]))))
    const reports = join(dir, 'reports')
    const result = await cli('offline', archive, '--report-dir', reports)
    expect(result.code).toBe(0)
    expect(result.out).toContain('独轮车 1 人')
    expect(result.out).toContain('loop-bot')
    expect(result.out).toContain('⟨U+00AD⟩')
    expect(
      readdirSync(reports)
        .sort()
        .map(name => name.split('.').pop())
    ).toEqual(['json', 'md'])
  })
})
