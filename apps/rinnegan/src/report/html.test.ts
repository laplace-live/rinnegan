import { describe, expect, test } from 'bun:test'
import type { Assessment, ChatMessage, ManualBlend, UserSummary } from '@laplace.live/rinnegan-sdk'
import { DEFAULT_DETECTOR_OPTIONS, Detector } from '@laplace.live/rinnegan-sdk'

import type { OfflineReport } from '@/report/report'
import type { Persona } from '@/testing/simulate'

import { buildActivity } from '@/report/activity'
import { renderHtml } from '@/report/html'
import { buildReport } from '@/report/report'
import { assessment, manualBlend } from '@/testing/fixtures'
import { mergeStreams, simulateChatterboxLoop, simulateHumanChat } from '@/testing/simulate'

const T0 = Date.parse('2026-10-20T12:00:00Z')

/** As offline mode renders it. */
function renderPage(report: OfflineReport, messages: readonly ChatMessage[] = []): string {
  const activity = buildActivity(messages, report.users, report.manualBlends)
  return renderHtml(report, activity, { archives: ['room.lca'] })
}

function render(messages: ChatMessage[]): string {
  const detector = new Detector()
  for (const message of messages) detector.ingest(message)
  const report = buildReport({
    version: '0.0.0',
    archive: {
      path: '/home/moderator/room.lca',
      format: 'gzip',
      messages: messages.length,
      users: new Set(messages.map(message => message.uid)).size,
      rooms: [1],
      from: messages[0]?.timestamp ?? 0,
      to: messages[messages.length - 1]?.timestamp ?? 0,
      skipped: { mirror: 2 },
    },
    detector: detector.options,
    summaries: detector.summaries(),
    manualBlends: detector.manualBlends(),
  })
  return renderPage(report, messages)
}

/** A 100-user archive with these 手动融入 viewers and flagged peaks. */
function renderMarked(manualBlends: ManualBlend[], peaks: Partial<Assessment>[] = []): string {
  const summaries = peaks.map((patch): UserSummary => {
    const peak = assessment({ at: T0, ...patch })
    return { roomId: 1, uid: peak.uid, uname: peak.uname, messages: 40, firstAt: T0, lastAt: T0, peak, episodes: [] }
  })
  const report = buildReport({
    version: '0.0.0',
    archive: {
      path: 'room.lca',
      format: 'gzip',
      messages: 5000,
      users: 100,
      rooms: [1],
      from: T0,
      to: T0 + 3_600_000,
      skipped: {},
    },
    detector: DEFAULT_DETECTOR_OPTIONS,
    summaries,
    manualBlends,
  })
  return renderPage(report)
}

function loop(persona: Persona, template: string): ChatMessage[] {
  return simulateChatterboxLoop({ persona, template, startAt: T0, durationMs: 2 * 60_000, randomChar: '­' })
}

function chartData(html: string): {
  periods: {
    span: number
    lanes: { name: string; href: string; sends: number[]; flagged: [number, number, string][] }[]
  }[]
  gaps: Record<string, { tick: number | null }>
} {
  const json = html.match(/<script type="application\/json" id="report-data">(.*?)<\/script>/s)?.[1]
  return JSON.parse(json ?? 'null')
}

describe('renderHtml', () => {
  test('renders a flagged loop with its evidence, samples and chart data', () => {
    const html = render(loop({ uid: 4242, uname: 'loop-bot', roomId: 1 }, '关注主播谢谢喵'))
    expect(html).toStartWith('<!doctype html>')
    expect(html).toContain('独轮车 · 1 人')
    expect(html).toContain('<h3>loop-bot</h3>')
    expect(html).toContain('<span class="cp">U+00AD</span>')
    expect(html).toContain('跨房弹幕 2')
    expect(html).toContain('id="u-1-4242"')

    const data = chartData(html)
    expect(data.periods).toHaveLength(1)
    const period = data.periods[0]
    const lane = period?.lanes[0]
    expect(lane).toMatchObject({ name: 'loop-bot', href: '#u-1-4242' })
    // Whole seconds into the period
    const inPeriod = (s: number) => Number.isInteger(s) && s >= 0 && s <= Math.round(period?.span ?? 0)
    expect(lane?.sends.length).toBeGreaterThan(2)
    expect(lane?.sends.every(inPeriod)).toBe(true)
    expect(lane?.flagged.length).toBeGreaterThan(0)
    expect(lane?.flagged.every(([from, to]) => from <= to && inPeriod(from) && inPeriod(to))).toBe(true)
    expect(data.gaps['1:4242']?.tick).toBeGreaterThan(1)
  })

  test('escapes viewer-controlled text, in markup and in the chart data', () => {
    const uname = '<img src=x onerror=alert(1)>'
    const html = render(loop({ uid: 7, uname, roomId: 1 }, '</script><script>alert(1)</script>'))
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    // Only the data block and the chart script close a script element
    expect(html.match(/<\/script>/g)).toHaveLength(2)
    expect(chartData(html).periods[0]?.lanes[0]?.name).toBe(uname)
  })

  test('chips only real invisible chars, counting runs, and leaves look-alike text alone', () => {
    const persona = { uid: 9, uname: 'bot', roomId: 1 }
    const template = '关注⟨U+200B⟩主播\u00AD\u00AD喵'
    const html = render(simulateChatterboxLoop({ persona, template, startAt: T0, durationMs: 2 * 60_000 }))
    expect(html).toContain('关注⟨U+200B⟩主播<span class="cp">U+00AD ×2</span>喵')
    expect(html).not.toContain('class="cp">U+200B')
  })

  test('loads nothing from the network and never names local paths', () => {
    const html = render(loop({ uid: 8, uname: 'bot', roomId: 1 }, '千舰之夜'))
    expect(html).not.toMatch(/<link|<script[^>]*\ssrc=|@import|url\(/)
    expect(html).toContain('room.lca')
    expect(html).not.toContain('/home/moderator')
  })

  test('opens each line’s samples, and every danmaku a flagged user sent, on click', () => {
    const messages = loop({ uid: 4242, uname: 'loop-bot', roomId: 1 }, '关注主播谢谢喵')
    const last = messages.at(-1) as ChatMessage
    const sticker = { ...last, id: 'sticker', text: '[明前奶绿_MA]', isEmote: true, timestamp: last.timestamp + 1000 }
    const page = render([...messages, sticker])
    // Every kept sample, not just the first few the console prints
    const line = page.match(/<details class="line"><summary class="line-k"><b>「.*?<\/details>/s)?.[0] ?? ''
    expect(line.match(/<li>/g)).toHaveLength(DEFAULT_DETECTOR_OPTIONS.samplesPerCluster)
    expect(page).toContain(`<details class="all"><summary>全部 ${messages.length + 1} 条弹幕</summary>`)
    expect(page).toContain('[明前奶绿_MA]<span class="via">表情</span>')
  })

  test('lists 手动融入 viewers with what they copied, linked both ways to a flagged one', () => {
    const copier = manualBlend({
      history: [
        { at: T0, text: '才八点', senders: 22 },
        { at: T0 + 30_000, text: '我自己想说的话', senders: 0 },
        { at: T0 + 60_000, text: '你太云了，没玩过没发言权', senders: 1, from: '路人', lagMs: 5600 },
      ],
    })
    const chanter = manualBlend({ uid: 43, uname: 'chanter', chants: 55, sources: 0, plusOneLagMs: null })
    const page = renderMarked([copier, chanter], [{ verdict: 'suspect', score: 70, evidence: [], proof: 0 }])
    expect(page).toContain('手动融入 · 2 人')
    expect(page).toContain('其中 1 人也被判为可疑')
    // 100 users, less the suspect and the chanter, who are both marked
    expect(page).toContain('<span class="num">98</span><span class="lbl"><i class="dot none"></i>正常')

    expect(page).toContain(
      '<p class="manual-note"><a href="#m-1-42"><b>手动融入</b></a>复读 55/86 条（跟队形 18 条，+1 了 31 人的 37 条，通常比原弹幕晚 5.8s），自己说的 31 条</p>'
    )
    expect(page).toContain('<li id="m-1-42">')
    expect(page).toContain('<a class="pill suspect" href="#u-1-42">可疑 70.0</a>')
    expect(page).toContain('<li id="m-1-43">')
    expect(page).not.toContain('href="#u-1-43"')

    // Every part's count and share; a part at zero draws nothing
    expect(page).toContain('aria-label="86 条文字弹幕：跟队形 18 条（21%），+1 37 条（43%），自己说的 31 条（36%）"')
    expect(page).toContain('aria-label="86 条文字弹幕：跟队形 55 条（64%），自己说的 31 条（36%）"')

    // Every counted send, tagged; the chanter has no history, so no list
    expect(page.match(/<details class="all">/g)).toHaveLength(1)
    expect(page).toContain('<summary>全部 3 条文字弹幕</summary>')
    expect(page).toContain('才八点<span class="via"><i class="kind chant"></i>跟 22 人一起刷</span>')
    expect(page).toContain('我自己想说的话<span class="via"><i class="kind own"></i>自己说的</span>')
    expect(page).toContain(
      '你太云了，没玩过没发言权<span class="via"><i class="kind plus-one"></i>复读 路人，晚 5.6s</span>'
    )
  })

  test('escapes 手动融入 names and copied lines, and chips their invisible chars', () => {
    const page = renderMarked([
      manualBlend({
        uname: '<img src=x onerror=alert(1)>',
        history: [{ at: T0, text: '</script>千\u00AD舰', senders: 1, from: '<i>路人</i>', lagMs: 1000 }],
      }),
    ])
    expect(page).not.toContain('<img')
    expect(page).toContain('<h3>&lt;img src=x onerror=alert(1)&gt;</h3>')
    expect(page).toContain(
      '&lt;/script&gt;千<span class="cp">U+00AD</span>舰<span class="via"><i class="kind plus-one"></i>复读 &lt;i&gt;路人&lt;/i&gt;，晚 1.0s</span>'
    )
    expect(page.match(/<\/script>/g)).toHaveLength(2)
  })

  test('leaves the 手动融入 list out when nobody earns the mark', () => {
    const page = renderMarked([], [{ verdict: 'suspect', score: 70, evidence: [], proof: 0 }])
    expect(page).toContain('<span class="num">0</span><span class="lbl"><i class="dot manual"></i>手动融入')
    expect(page).not.toContain('id="h-manual"')
    expect(page).not.toContain('class="manual-note"')
  })

  test('says so when nobody is flagged', () => {
    const lines = ['晚上好', '哈哈哈', '好听', '来了']
    const viewers = [1, 2, 3].map(uid =>
      simulateHumanChat({ persona: { uid, uname: `viewer${uid}`, roomId: 1 }, lines, startAt: T0, sends: 20 })
    )
    const html = render(mergeStreams(...viewers))
    expect(html).toContain('没有发现独轮车或可疑用户')
    expect(html).not.toContain('data-period=')
    expect(chartData(html).periods).toEqual([])
  })
})
