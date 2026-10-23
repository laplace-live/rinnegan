import { describe, expect, test } from 'bun:test'

import type { UserSummary } from '@/detect/detector'
import type { Assessment } from '@/types'

import { DEFAULT_DETECTOR_OPTIONS } from '@/detect/detector'
import { buildReport, renderConsole, renderMarkdown } from '@/report/report'
import { assessment } from '@/testing/fixtures'

function reportOf(patch: Partial<Assessment>) {
  const peak = assessment(patch)
  const summary: UserSummary = {
    roomId: 1,
    uid: peak.uid,
    uname: peak.uname,
    messages: 40,
    firstAt: peak.at,
    lastAt: peak.at,
    peak,
    episodes: [],
  }
  return buildReport({
    archive: {
      path: 'room.lca',
      format: 'gzip',
      messages: 40,
      users: 1,
      rooms: [1],
      from: peak.at,
      to: peak.at,
      skipped: {},
    },
    detector: DEFAULT_DETECTOR_OPTIONS,
    summaries: [summary],
    version: '0.0.0',
  })
}

const CONSOLE = { top: 10, suspects: true, samples: 1 }

describe('offline report', () => {
  test('names 自动融入 trigger hits as hits, not repeated messages', () => {
    const blend = reportOf({ pattern: 'blend', repeats: 33, triggerHits: true })
    expect(blend.users[0]?.triggerHits).toBe(true)
    expect(renderConsole(blend, CONSOLE)).toContain('跟风命中 33 次')
    expect(renderMarkdown(blend)).toContain('| 33（跟风命中） |')

    const loop = reportOf({ repeats: 30 })
    expect(loop.users[0]?.triggerHits).toBe(false)
    expect(renderConsole(loop, CONSOLE)).toContain('窗口内重复 30 次')
    expect(renderMarkdown(loop)).toContain('| 30 |')
  })
})
