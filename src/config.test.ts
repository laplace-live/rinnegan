import { describe, expect, test } from 'bun:test'

import { configFromFlags, parseTime } from '@/cli'
import {
  configFromEnv,
  DEFAULT_CONFIG,
  mergeConfig,
  parseIdList,
  parseNumber,
  parsePatterns,
  validateConfig,
} from '@/config'

describe('parsers', () => {
  test('parseIdList accepts commas, spaces and full-width commas', () => {
    expect(parseIdList('25034104, 456117，1', '--room')).toEqual([25034104, 456117, 1])
    expect(() => parseIdList('25034104,abc', '--room')).toThrow('abc')
    expect(() => parseIdList('-5', '--room')).toThrow()
  })

  test('parseNumber rejects blanks and junk', () => {
    expect(parseNumber('1.5', 'x')).toBe(1.5)
    expect(() => parseNumber('', 'x')).toThrow()
    expect(() => parseNumber('ten', 'x')).toThrow()
  })

  test('parsePatterns validates names', () => {
    expect(parsePatterns('loop,burst')).toEqual(['loop', 'burst'])
    expect(() => parsePatterns('loop,spam')).toThrow('spam')
  })

  test('parseTime reads local dates and times', () => {
    expect(parseTime('2026-10-20', 'x')).toBe(new Date(2026, 9, 20, 0, 0).getTime())
    expect(parseTime('2026-10-20 20:30', 'x')).toBe(new Date(2026, 9, 20, 20, 30).getTime())
    expect(parseTime('2026-10-20T12:00:00Z', 'x')).toBe(Date.UTC(2026, 9, 20, 12))
    expect(() => parseTime('yesterday', 'x')).toThrow()
  })
})

describe('config layers', () => {
  test('env fills credentials, source and AI settings', () => {
    const layer = configFromEnv({
      LOGIN_SYNC_TOKEN: 'abc@pw',
      RINNEGAN_EVENT_URL: 'ws://lef:8080',
      RINNEGAN_ROOMS: '25034104',
      RINNEGAN_AI_MODE: 'confirm',
      RINNEGAN_AI_API_KEY: 'sk-test',
      RINNEGAN_STORE_URL: 'memory:',
      UNRELATED: 'x',
    })
    expect(layer.loginSync?.token).toBe('abc@pw')
    expect(layer.live).toEqual({ url: 'ws://lef:8080', rooms: [25034104] })
    expect(layer.ai).toEqual({ mode: 'confirm', apiKey: 'sk-test' })
    expect(layer.storeUrl).toBe('memory:')
    expect(() => configFromEnv({ RINNEGAN_AI_MODE: 'yolo' })).toThrow('RINNEGAN_AI_MODE')
  })

  test('flags override file and env, nested sections merge', () => {
    const file = { ban: { exemptGuards: true, maxPerMinute: 2 }, live: { url: 'ws://file:1' } }
    const env = configFromEnv({ RINNEGAN_EVENT_URL: 'ws://env:2', LOGIN_SYNC_TOKEN: 'a@b' })
    const flags = configFromFlags({ url: 'ws://flag:3', room: ['1,2', '3'], window: '5', 'dry-run': true })
    const config = mergeConfig(DEFAULT_CONFIG, file, env, flags)
    expect(config.live.url).toBe('ws://flag:3')
    expect(config.live.rooms).toEqual([1, 2, 3])
    expect(config.detector.windowMs).toBe(300_000)
    expect(config.ban).toMatchObject({ dryRun: true, exemptGuards: true, maxPerMinute: 2, hours: -1 })
    expect(config.loginSync.token).toBe('a@b')
    expect(DEFAULT_CONFIG.ban.dryRun).toBe(false)
  })

  test('validateConfig rejects unsafe values', () => {
    expect(() => validateConfig(mergeConfig(DEFAULT_CONFIG, { ban: { hours: 0 } }))).toThrow('ban.hours')
    expect(() => validateConfig(mergeConfig(DEFAULT_CONFIG, { ban: { maxPerSession: 0 } }))).toThrow()
    expect(() => validateConfig(mergeConfig(DEFAULT_CONFIG, { detector: { windowMs: 1000 } }))).toThrow()
    expect(() => validateConfig(DEFAULT_CONFIG)).not.toThrow()
  })
})
