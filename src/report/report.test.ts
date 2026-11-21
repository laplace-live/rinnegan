import { describe, expect, test } from 'bun:test'
import { stripVTControlCharacters } from 'node:util'

import type { UserSummary } from '@/detect/detector'
import type { ManualBlend } from '@/detect/manual'
import type { Assessment } from '@/types'

import { DEFAULT_DETECTOR_OPTIONS } from '@/detect/detector'
import { buildReport, renderConsole, renderMarkdown } from '@/report/report'
import { assessment } from '@/testing/fixtures'

function reportOf(patch: Partial<Assessment>, manualBlends: ManualBlend[] = []) {
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
    manualBlends,
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

  test('lists 手动融入 viewers and tags a flagged one', () => {
    const at = 1_760_000_000_000
    const copier: ManualBlend = {
      roomId: 1,
      uid: 42,
      uname: 'bot',
      sends: 86,
      copies: 55,
      chants: 18,
      sources: 31,
      switches: 84,
      ownSwitches: 31,
      plusOneLagMs: 5800,
      samples: [
        { at, text: '才八点', senders: 22, from: 'crowd', lagMs: 280 },
        { at: at + 60_000, text: '你太云了，没玩过没发言权', senders: 1, from: '路人', lagMs: 5600 },
      ],
    }
    const chanter: ManualBlend = { ...copier, uid: 43, uname: 'fan', chants: 55, sources: 0, plusOneLagMs: null }
    const report = reportOf({ verdict: 'suspect', score: 70, evidence: [], proof: 0 }, [copier, chanter])
    expect(report.totals.manualBlend).toBe(2)
    expect(report.users[0]?.manualBlend).toBe(true)

    // Plain text whether or not the terminal running the tests takes colors
    const text = stripVTControlCharacters(renderConsole(report, { ...CONSOLE, samples: 2 }))
    expect(text).toContain('手动融入 2 人')
    expect(text).toContain('uid 42 · 房间 1 · 手动融入')
    expect(text).toContain('复读 55/86 条（跟队形 18 条，+1 了 31 人的 37 条，通常比原弹幕晚 5.8s），自己说的 31 条')
    expect(text).toContain('「才八点」 跟 22 人一起刷')
    expect(text).toContain('「你太云了，没玩过没发言权」 复读 路人，晚 5.6s')
    expect(text).toContain('复读 55/86 条（跟队形 55 条），自己说的 31 条')
    expect(renderConsole(report, { ...CONSOLE, suspects: false })).not.toContain('── 手动融入')
    const quiet = stripVTControlCharacters(renderConsole(report, { ...CONSOLE, samples: 0 }))
    expect(quiet).toContain('复读 55/86 条')
    expect(quiet).not.toContain('一起刷')
    expect(quiet).not.toContain('复读 路人')

    const markdown = renderMarkdown(report)
    expect(markdown).toContain('手动融入 **2** 人')
    expect(markdown).toContain('| 可疑（手动融入） |')
    expect(markdown).toContain('- 手动融入：复读 55/86 条')
    expect(markdown).toContain(
      '| 1 | bot | 42 | 55/86 | 18 | 37（31 人） | 31 | 5.8s | 「你太云了，没玩过没发言权」 复读 路人，晚 5.6s |'
    )
    expect(markdown).toContain('| 2 | fan | 43 | 55/86 | 55 | 0 | 31 | — |')
  })
})
