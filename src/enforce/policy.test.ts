import { describe, expect, test } from 'bun:test'

import type { Assessment } from '@/types'

import { DEFAULT_CONFIG } from '@/config'
import { exemptionReason, formatReason } from '@/enforce/policy'

function assessment(patch: Partial<Assessment> = {}): Assessment {
  return {
    roomId: 1,
    uid: 42,
    uname: 'bot',
    at: 0,
    score: 100,
    verdict: 'spam',
    pattern: 'loop',
    repeats: 34,
    windowMessages: 35,
    automation: 0.95,
    evidence: [],
    clusters: [
      {
        key: '千舰',
        count: 35,
        variants: 12,
        invisible: 35,
        medianGapMs: 1300,
        regularity: 1,
        crowd: 3,
        firstAt: 0,
        lastAt: 1,
        samples: [{ timestamp: 0, text: '千­舰！千舰！' }],
      },
    ],
    userType: 0,
    guardType: 0,
    medalLevel: 0,
    wealthLevel: 0,
    ...patch,
  }
}

describe('exemptionReason', () => {
  const ban = DEFAULT_CONFIG.ban

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

describe('formatReason', () => {
  test('fills placeholders with the visible sample', () => {
    expect(formatReason('独轮车 ×{count}/{minutes}分钟：{sample}', assessment(), 600_000)).toBe(
      '独轮车 ×35/10分钟：千舰！千舰！'
    )
    expect(formatReason('{pattern} {score} {unknown}', assessment(), 600_000)).toBe('循环独轮车 100 {unknown}')
  })
})
