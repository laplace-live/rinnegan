import { describe, expect, test } from 'bun:test'

import type { DecisionProtocol } from '@/ai/types'
import type { ConfigLayer } from '@/config'
import type { Pattern } from '@/types'

import { configFromFlags } from '@/cli'
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
      RINNEGAN_LOGIN_FILE: 'secrets/login.json',
      RINNEGAN_TIMEZONE: 'UTC',
      UNRELATED: 'x',
    })
    expect(layer.loginSync?.token).toBe('abc@pw')
    expect(layer.live).toEqual({ url: 'ws://lef:8080', rooms: [25034104] })
    expect(layer.ai).toEqual({ mode: 'confirm', apiKey: 'sk-test' })
    expect(layer.storeUrl).toBe('memory:')
    expect(layer.loginFile).toBe('secrets/login.json')
    expect(layer.timeZone).toBe('UTC')
    expect(configFromEnv({ UNRELATED: 'x', LOGIN_SYNC_TOKEN: ' ' })).toEqual({})
  })

  test('flags override file and env, nested sections merge', () => {
    const file = { ban: { exemptGuards: true, maxPerMinute: 2 }, live: { url: 'ws://file:1' }, loginFile: 'file.json' }
    const env = configFromEnv({ RINNEGAN_EVENT_URL: 'ws://env:2', LOGIN_SYNC_TOKEN: 'a@b', RINNEGAN_TIMEZONE: 'UTC' })
    const flags = configFromFlags({
      url: 'ws://flag:3',
      room: ['1,2', '3'],
      window: '5',
      'dry-run': true,
      'login-file': 'flag.json',
      timezone: 'America/Los_Angeles',
    })
    const config = mergeConfig(DEFAULT_CONFIG, file, env, flags)
    expect(config.live.url).toBe('ws://flag:3')
    expect(config.live.rooms).toEqual([1, 2, 3])
    expect(config.detector.windowMs).toBe(300_000)
    expect(config.ban).toMatchObject({ dryRun: true, exemptGuards: true, maxPerMinute: 2, hours: -1 })
    expect(config.loginSync.token).toBe('a@b')
    expect(config.loginFile).toBe('flag.json')
    expect(config.timeZone).toBe('America/Los_Angeles')
    expect(DEFAULT_CONFIG.ban.dryRun).toBe(false)
    expect(DEFAULT_CONFIG.timeZone).toBe('Asia/Shanghai')
  })

  test('validateConfig rejects unsafe values', () => {
    expect(() => validateConfig(mergeConfig(DEFAULT_CONFIG, { ban: { hours: 0 } }))).toThrow('ban.hours')
    expect(() => validateConfig(mergeConfig(DEFAULT_CONFIG, { ban: { maxPerSession: 0 } }))).toThrow()
    expect(() => validateConfig(mergeConfig(DEFAULT_CONFIG, { detector: { windowMs: 1000 } }))).toThrow()
    expect(() => validateConfig(DEFAULT_CONFIG)).not.toThrow()
  })

  test('validateConfig checks enums from every layer the same way', () => {
    const load = (layer: ConfigLayer) => () => validateConfig(mergeConfig(DEFAULT_CONFIG, layer))
    expect(load(configFromEnv({ RINNEGAN_AI_MODE: 'yolo' }))).toThrow('ai.mode')
    expect(load(configFromFlags({ 'ai-provider': 'gpt' }))).toThrow('ai.provider 只能是 jev / llm')
    expect(load({ ai: { mode: 'off', protocol: 'grpc' as DecisionProtocol } })).toThrow('ai.protocol')
    expect(load({ ban: { patterns: ['spam' as Pattern] } })).toThrow('ban.patterns')
    expect(load(configFromFlags({ timezone: 'Mars/Olympus' }))).toThrow('未知的时区「Mars/Olympus」')
    expect(load({ timeZone: -5 as unknown as string })).toThrow('timeZone 必须是字符串')
    expect(load(configFromEnv({ RINNEGAN_TIMEZONE: 'UTC+8' }))).not.toThrow()
    expect(load(configFromFlags({ 'ai-provider': 'llm', 'ai-protocol': ' ' }))).not.toThrow()
  })
})
