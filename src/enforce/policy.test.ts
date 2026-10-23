import { describe, expect, test } from 'bun:test'

import type { Assessment } from '@/types'

import { DEFAULT_CONFIG } from '@/config'
import { banEligibility, exemptionReason, formatReason } from '@/enforce/policy'
import { assessment } from '@/testing/fixtures'

const ban = DEFAULT_CONFIG.ban

describe('exemptionReason', () => {
  test('never bans the streamer or room admins', () => {
    expect(exemptionReason(assessment({ userType: 100 }), ban)).toBe('主播')
    expect(exemptionReason(assessment({ userType: 1 }), ban)).toBe('房管')
  })

  test('honours allowlist, guard and medal exemptions', () => {
    expect(exemptionReason(assessment(), { ...ban, exemptUids: [42] })).toBe('白名单')
    expect(exemptionReason(assessment({ guardType: 3 }), ban)).toBeNull()
    expect(exemptionReason(assessment({ guardType: 3 }), { ...ban, exemptGuards: true })).toBe('大航海成员')
    expect(exemptionReason(assessment({ medalLevel: 21 }), { ...ban, exemptMedalLevel: 20 })).toBe('粉丝牌 21 级')
  })

  test('only bans configured patterns', () => {
    expect(exemptionReason(assessment({ pattern: 'blend' }), { ...ban, patterns: ['loop'] })).toContain('不在封禁范围')
    expect(exemptionReason(assessment({ pattern: 'flood' }), ban)).toContain('不在封禁范围')
    expect(exemptionReason(assessment(), ban)).toBeNull()
  })
})

describe('banEligibility', () => {
  const suspect = assessment({ verdict: 'suspect', score: 85, proof: 0.6 })

  test('bans spam outright unless every ban needs the reviewer', () => {
    expect(banEligibility(assessment(), ban, 'off')).toEqual({ action: 'ban', exempt: null })
    expect(banEligibility(assessment(), ban, 'assist')).toEqual({ action: 'ban', exempt: null })
    expect(banEligibility(assessment(), ban, 'confirm')).toEqual({ action: 'review', exempt: null })
  })

  test('offers only strong, partly automated suspects to the reviewer in assist mode', () => {
    expect(banEligibility(suspect, ban, 'assist')).toEqual({ action: 'review', exempt: null })
    expect(banEligibility(suspect, ban, 'off').action).toBeNull()
    expect(banEligibility(suspect, ban, 'confirm').action).toBeNull()
    expect(banEligibility({ ...suspect, proof: 0.3 }, ban, 'assist').action).toBeNull()
    expect(banEligibility({ ...suspect, score: 70 }, ban, 'assist').action).toBeNull()
  })

  test('reports exemptions only for users it would act on', () => {
    expect(banEligibility(assessment({ userType: 1 }), ban, 'off')).toEqual({ action: null, exempt: '房管' })
    expect(banEligibility({ ...suspect, userType: 1 }, ban, 'assist')).toEqual({ action: null, exempt: '房管' })
    expect(banEligibility({ ...suspect, userType: 1 }, ban, 'off')).toEqual({ action: null, exempt: null })
  })
})

describe('formatReason', () => {
  test('fills placeholders with the visible sample', () => {
    expect(formatReason('独轮车 ×{count}/{minutes}分钟：{sample}', assessment(), 600_000)).toBe(
      '独轮车 ×31/10分钟：千舰'
    )
    expect(formatReason('{pattern} {score} {unknown}', assessment(), 600_000)).toBe('循环独轮车 100 {unknown}')
  })

  test('returns exactly what Bilibili receives', () => {
    const top = assessment().clusters[0] as Assessment['clusters'][number]
    const long = assessment({ clusters: [{ ...top, samples: [{ timestamp: 0, text: '刷'.repeat(80) }] }] })
    expect(formatReason('独轮车：{sample}', long, 600_000)).toBe(`独轮车：${'刷'.repeat(56)}`)
    expect(formatReason('  ', assessment(), 600_000)).toBe('独轮车')
  })
})
