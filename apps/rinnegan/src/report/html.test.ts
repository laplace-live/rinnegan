import { describe, expect, test } from 'bun:test'
import type { ChatMessage } from '@laplace.live/rinnegan-sdk'
import { Detector } from '@laplace.live/rinnegan-sdk'

import type { Persona } from '@/testing/simulate'

import { buildActivity } from '@/report/activity'
import { renderHtml } from '@/report/html'
import { buildReport } from '@/report/report'
import { mergeStreams, simulateChatterboxLoop, simulateHumanChat } from '@/testing/simulate'

const T0 = Date.parse('2026-10-20T12:00:00Z')

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
  })
  return renderHtml(report, buildActivity(messages, report.users), { archives: ['room.lca'], samples: 2 })
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
