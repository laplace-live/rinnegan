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
    env: {
      ...hostEnv,
      NO_COLOR: '1',
      LOGIN_SYNC_TOKEN: '',
      RINNEGAN_LOG_DIR: join(dir, 'logs'),
      // A machine off China time, which --since and the output must not follow
      TZ: 'America/Los_Angeles',
    },
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out, err }
}

/** A gzip archive in the temp dir holding a one-minute soft-hyphen loop at 20:00 China time on 2026-10-20. */
async function loopArchive(name: string): Promise<string> {
  const messages = simulateChatterboxLoop({
    persona: { uid: 4242, uname: 'loop-bot', roomId: 1 },
    template: '关注主播谢谢喵',
    startAt: Date.parse('2026-10-20T12:00:00Z'),
    durationMs: 60_000,
    randomChar: '­',
  })
  const events = messages.map(message => messageEvent(message))
  const archive = join(dir, name)
  await Bun.write(archive, Bun.gzipSync(new TextEncoder().encode(JSON.stringify([{ name: 'main', data: events }]))))
  return archive
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
    const zone = await cli('offline', '--timezone', 'Mars/Olympus', 'x.lca')
    expect(zone.code).toBe(1)
    expect(zone.err).toContain('未知的时区「Mars/Olympus」')
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
    const archive = await loopArchive('room.lca')
    const reports = join(dir, 'reports')
    // The loop runs at 20:00 China time (05:00 in Los Angeles), so a Los Angeles --since would drop it
    const result = await cli('offline', archive, '--report-dir', reports, '--since', '2026-10-20 19:59')
    expect(result.code).toBe(0)
    expect(result.out).toContain('独轮车 1 人')
    expect(result.out).toContain('loop-bot')
    expect(result.out).toContain('⟨U+00AD⟩')
    expect(result.out).toContain('时间 2026-10-20 20:00:0')
    expect(result.out).toContain('（UTC+08:00）')
    const eastern = await cli(
      'offline',
      archive,
      '--no-report',
      '--timezone',
      'America/New_York',
      '--until',
      '2026-10-20 08:02'
    )
    expect(eastern.out).toContain('独轮车 1 人')
    expect(eastern.out).toContain('时间 2026-10-20 08:00:0')
    expect(eastern.out).toContain('（UTC-04:00）')
    const files = readdirSync(reports).sort()
    expect(files.map(name => name.split('.').pop())).toEqual(['html', 'json', 'md'])
    const html = await Bun.file(join(reports, files[0] as string)).text()
    expect(html).toContain('loop-bot')
    expect(html).not.toContain(dir)
  })

  test('offline keeps the 手动融入 history its HTML report draws on, whatever the config says', async () => {
    const archive = await loopArchive('history.lca')
    const config = join(dir, 'no-history.json')
    await Bun.write(config, JSON.stringify({ detector: { manualHistory: false } }))
    const reports = join(dir, 'history-reports')
    const result = await cli('offline', archive, '-c', config, '--report-dir', reports)
    expect(result.code).toBe(0)
    const page = readdirSync(reports).find(name => name.endsWith('.html')) as string
    const html = await Bun.file(join(reports, page)).text()
    // Every send of the loop is a line of its own, which only the tally can tell
    expect(html).toMatch(/aria-label="(\d+) 条弹幕：自己说的 \1 条（100%）"/)
  })
})
