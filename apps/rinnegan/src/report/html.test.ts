import { describe, expect, test } from 'bun:test'
import type { Assessment, ChatMessage, ManualBlend, TalliedSend, UserSummary } from '@laplace.live/rinnegan-sdk'
import { DEFAULT_DETECTOR_OPTIONS, Detector } from '@laplace.live/rinnegan-sdk'

import type { OfflineReport } from '@/report/report'
import type { Persona } from '@/testing/simulate'

import { buildActivity } from '@/report/activity'
import { renderHtml } from '@/report/html'
import { buildReport, userKey } from '@/report/report'
import { assessment, manualBlend } from '@/testing/fixtures'
import { mergeStreams, simulateChatterboxLoop, simulateHumanChat } from '@/testing/simulate'

const T0 = Date.parse('2026-10-20T12:00:00Z')

/** As offline mode renders it. */
function renderPage(
  report: OfflineReport,
  messages: readonly ChatMessage[] = [],
  histories = new Map<string, TalliedSend[]>()
): string {
  const activity = buildActivity(messages, report.users, report.manualBlends, histories)
  return renderHtml(report, activity, { archives: ['room.lca'] })
}

function render(messages: ChatMessage[]): string {
  const detector = new Detector()
  for (const message of messages) detector.ingest(message)
  const summaries = detector.summaries()
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
    summaries,
    manualBlends: detector.manualBlends(),
  })
  const listed = [...summaries, ...report.manualBlends]
  return renderPage(report, messages, new Map(listed.map(user => [userKey(user), user.history ?? []])))
}

/** A 100-user archive with these 手动融入 viewers and flagged peaks, the flagged users' `messages` and tallies. */
function renderMarked(
  manualBlends: ManualBlend[],
  peaks: Partial<Assessment>[] = [],
  { messages = [], histories }: { messages?: ChatMessage[]; histories?: Map<string, TalliedSend[]> } = {}
): string {
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
  return renderPage(report, messages, histories)
}

/** A danmaku from the fixtures' flagged user, uid 42, `seconds` into the archive. */
function said(seconds: number, text: string, patch: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `s${seconds}`,
    roomId: 1,
    uid: 42,
    uname: 'bot',
    text,
    timestamp: T0 + seconds * 1000,
    userType: 0,
    guardType: 0,
    isEmote: false,
    medalLevel: 0,
    isReply: false,
    ...patch,
  }
}

function loop(persona: Persona, template: string): ChatMessage[] {
  return simulateChatterboxLoop({ persona, template, startAt: T0, durationMs: 2 * 60_000, randomChar: '­' })
}

function chartData(html: string): {
  periods: {
    span: number
    lanes: { name: string; href: string; sends: number[]; flagged: [number, number, string][]; tip: string }[]
  }[]
  gaps: Record<string, { max: number; bin: number; counts: number[] }>
} {
  const json = html.match(/<script type="application\/json" id="report-data">(.*?)<\/script>/s)?.[1]
  return JSON.parse(json ?? 'null')
}

describe('renderHtml', () => {
  test('renders a flagged loop with its evidence, samples and chart data', () => {
    const messages = loop({ uid: 4242, uname: 'loop-bot', roomId: 1 }, '关注主播谢谢喵')
    const html = render(messages)
    expect(html).toStartWith('<!doctype html>')
    expect(html).toContain('独轮车 · 1 人')
    expect(html).toContain('<h3 class="pii">loop-bot</h3>')
    expect(html).toContain('<span class="cp">U+00AD</span>')
    expect(html).toContain('跨房弹幕 2')
    expect(html).toContain('id="u-1"')

    const data = chartData(html)
    expect(data.periods).toHaveLength(1)
    const period = data.periods[0]
    const lane = period?.lanes[0]
    expect(lane).toMatchObject({ name: 'loop-bot', href: '#u-1' })
    // Whole seconds into the period
    const inPeriod = (s: number) => Number.isInteger(s) && s >= 0 && s <= Math.round(period?.span ?? 0)
    expect(lane?.sends.length).toBeGreaterThan(2)
    expect(lane?.sends.every(inPeriod)).toBe(true)
    expect(lane?.flagged.length).toBeGreaterThan(0)
    expect(lane?.flagged.every(([from, to]) => from <= to && inPeriod(from) && inPeriod(to))).toBe(true)
    // Every gap under the chart's range, in its bin
    const gaps = data.gaps['1:4242']
    const binMs = Math.round((gaps?.bin ?? 1) * 1000)
    const times = messages.map(message => message.timestamp)
    const expected = new Array<number>(gaps?.counts.length ?? 0).fill(0)
    for (let i = 1; i < times.length; i++) {
      const bin = Math.floor(((times[i] as number) - (times[i - 1] as number)) / binMs)
      if (bin < expected.length) expected[bin] = (expected[bin] as number) + 1
    }
    expect(expected.reduce((sum, n) => sum + n, 0)).toBeGreaterThan(messages.length / 2)
    expect(gaps?.counts).toEqual(expected)
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
    // `url(#…)` points inside the page
    expect(html).not.toMatch(/<link|<script[^>]*\ssrc=|@import|url\((?!#)/)
    expect(html).toContain('room.lca')
    expect(html).not.toContain('/home/moderator')
  })

  test('opens each line’s samples, and every danmaku a flagged user sent, on click', () => {
    const messages = loop({ uid: 4242, uname: 'loop-bot', roomId: 1 }, '关注主播谢谢喵')
    const last = messages.at(-1) as ChatMessage
    const hello = { ...last, id: 'hello', text: '晚上好', timestamp: last.timestamp + 500 }
    const sticker = { ...last, id: 'sticker', text: '[明前奶绿_MA]', isEmote: true, timestamp: last.timestamp + 1000 }
    const page = render([...messages, hello, sticker])
    expect(page).not.toMatch(/<details[^>]*\sopen/)
    // Every kept sample, not just the first few the console prints
    const line = page.match(/<details class="line"><summary class="line-k"><b>「.*?<\/details>/s)?.[0] ?? ''
    expect(line.match(/<li>/g)).toHaveLength(DEFAULT_DETECTOR_OPTIONS.samplesPerCluster)
    const all = page.match(/<details class="all">.*?<\/details>/s)?.[0] ?? ''
    expect(all).toContain(`<summary>全部 ${messages.length + 2} 条弹幕</summary>`)
    expect(all.match(/<li>/g)).toHaveLength(messages.length + 2)
    expect(all).toContain('<span>晚上好<span class="via own">自己说的</span></span>')
    expect(all).toContain('[明前奶绿_MA]<span class="via other">表情</span>')
  })

  test('lists 手动融入 viewers with what they copied, linked both ways to a flagged one', () => {
    const history: TalliedSend[] = [
      { at: T0, text: '才八点', senders: 22 },
      { at: T0 + 30_000, text: '我自己想说的话', senders: 0 },
      { at: T0 + 60_000, text: '你太云了，没玩过没发言权', senders: 1, from: '路人', lagMs: 5600 },
    ]
    const sent = [
      said(0, '才八点'),
      said(30, '我自己想说的话'),
      said(45, '[doge]', { isEmote: true }),
      said(60, '你太云了，没玩过没发言权'),
    ]
    const copier = manualBlend()
    const chanter = manualBlend({ uid: 43, uname: 'chanter', chants: 55, sources: 0, plusOneLagMs: null })
    const page = renderMarked([copier, chanter], [{ verdict: 'suspect', score: 70, evidence: [], proof: 0 }], {
      messages: sent,
      histories: new Map([['1:42', history]]),
    })
    expect(page).toContain('手动融入 · 2 人')
    expect(page).toContain('其中 1 人也被判为可疑')
    // 100 users, less the suspect and the chanter, who are both marked
    expect(page).toContain('<span class="num">98</span><span class="lbl"><i class="dot none"></i>正常')

    // The bar's legend counts each part, so the note and the entry give what earned the mark
    expect(page).toContain(
      '<p class="manual-note"><a href="#m-1"><b>手动融入</b></a>也在手动复读别人：86 条文字弹幕中复读了 55 条</p>'
    )
    expect(page).toContain('<p class="facts">86 条文字弹幕中复读了 55 条</p>')
    expect(page).toContain('<li id="m-1">')
    expect(page).toContain('<a class="pill suspect" href="#u-1">可疑 70.0</a>')
    expect(page).toContain('<li id="m-2">')
    expect(page.match(/class="pill suspect" href=/g)).toHaveLength(1)

    // Every danmaku split into parts, on the flagged card and the 手动融入 entry alike; the chanter has no tally
    const bar = 'aria-label="4 条弹幕：跟队形 1 条（25%），+1 1 条（25%），自己说的 1 条（25%），表情 1 条（25%）"'
    expect(page.split(bar)).toHaveLength(3)
    expect(page.match(/<div class="parts">/g)).toHaveLength(2)

    // Every danmaku, tagged and closed until clicked; the chanter sent none here, so no list
    const entry = page.match(/<li id="m-1">.*?<\/li>\n/s)?.[0] ?? ''
    expect(entry).toContain('<summary>全部 4 条弹幕</summary>')
    expect(page).not.toMatch(/<details[^>]*\sopen/)
    expect(page.match(/<li id="m-2">.*?<\/li>\n/s)?.[0]).not.toContain('<details')
    expect(entry).toContain('才八点<span class="via chant">跟 22 人一起刷</span>')
    expect(entry).toContain('我自己想说的话<span class="via own">自己说的</span>')
    expect(entry).toContain('[doge]<span class="via other">表情</span>')
    expect(entry).toContain(
      '你太云了，没玩过没发言权<span class="via plus-one">复读 <span class="pii">路人</span>，晚 5.6s</span>'
    )
  })

  test('escapes 手动融入 names and copied lines, and chips their invisible chars', () => {
    const uname = '<img src=x onerror=alert(1)>'
    const history: TalliedSend[] = [
      { at: T0, text: '</script>千\u00AD舰', senders: 1, from: '<i>路人</i>', lagMs: 1000 },
    ]
    const page = renderMarked([manualBlend({ uname })], [], {
      messages: [said(0, '</script>千\u00AD舰', { uname })],
      histories: new Map([['1:42', history]]),
    })
    expect(page).not.toContain('<img')
    expect(page).toContain('<h3 class="pii">&lt;img src=x onerror=alert(1)&gt;</h3>')
    expect(page).toContain(
      '&lt;/script&gt;千<span class="cp">U+00AD</span>舰<span class="via plus-one">复读 <span class="pii">&lt;i&gt;路人&lt;/i&gt;</span>，晚 1.0s</span>'
    )
    expect(page.match(/<\/script>/g)).toHaveLength(2)
  })

  test('打码 can blur every viewer name and UID, and no link puts a UID in the address bar', () => {
    const html = render(loop({ uid: 4242, uname: 'loop-bot', roomId: 1 }, '关注主播谢谢喵'))
    expect(html).toContain('<input type="checkbox" id="mask" role="switch">')
    expect(html).toContain('<h3 class="pii">loop-bot</h3>')
    expect(html).toContain('>UID <span class="pii">4242</span></a>')
    expect(html).not.toMatch(/(id="|href="#)[^"]*4242/)
    // The chart script shows a lane's name apart from the rest of its tooltip
    const lane = chartData(html).periods[0]?.lanes[0]
    expect(lane?.name).toBe('loop-bot')
    expect(lane?.tip).not.toContain('loop-bot')
  })

  test('hides the names evidence quotes, however the names read', () => {
    const detail = '与 a.b(c) 等 2 个账号同步换内容 9 次，<i>x</i> 也在'
    const page = renderMarked(
      [],
      [{ evidence: [{ kind: 'lockstep', weight: 0.9, detail, names: ['<i>x</i>', 'a.b(c)'] }], proof: 0.9 }]
    )
    expect(page).toContain(
      '<span class="ev-d">与 <span class="pii">a.b(c)</span> 等 2 个账号同步换内容 9 次，<span class="pii">&lt;i&gt;x&lt;/i&gt;</span> 也在</span>'
    )
  })

  test('says in plain words how far apart a flagged user’s danmaku were', () => {
    const steady = Array.from({ length: 30 }, (_, i) => said(i * 6, '关注主播谢谢喵'))
    const page = renderMarked([], [{ pattern: 'blend' }], { messages: steady })
    expect(page).toContain('<h4>隔多久发一条</h4><p class="sub">一半的弹幕和上一条隔 <strong>6.0 秒左右</strong></p>')
    expect(page).toContain('柱子越高，和上一条隔这么久的弹幕越多。')
    expect(page).toContain('跟风机器人跟着房间里的热门内容发')
    expect(page).not.toContain('个间隔')

    const spread = [0, 2, 4, 6, 8, 20, 40, 60, 80, 400].map(seconds => said(seconds, '关注主播谢谢喵'))
    const loose = renderMarked([], [{}], { messages: spread })
    expect(loose).toContain('一半的弹幕和上一条隔 <strong>2.0–12 秒</strong>')
    expect(loose).toContain('另有 1 条和上一条隔了 30 秒以上，没有画出。')
    expect(loose).not.toContain('跟风机器人跟着')
  })

  test('tags every danmaku of a flagged user the way the 手动融入 list does', () => {
    const sent = [
      said(0, '才八点'),
      said(10, '我自己想说的话'),
      said(20, '你太云了'),
      said(30, '？'),
      said(40, '[doge]', { isEmote: true }),
      said(50, '你好', { isReply: true }),
    ]
    const history: TalliedSend[] = [
      { at: T0, text: '才八点', senders: 22 },
      { at: T0 + 10_000, text: '我自己想说的话', senders: 0 },
      { at: T0 + 20_000, text: '你太云了', senders: 1, from: '路人', lagMs: 2100 },
    ]
    const page = renderMarked([], [{}], { messages: sent, histories: new Map([['1:42', history]]) })
    const all = page.match(/<details class="all">.*?<\/details>/s)?.[0] ?? ''
    expect(all).toContain('才八点<span class="via chant">跟 22 人一起刷</span>')
    expect(all).toContain('我自己想说的话<span class="via own">自己说的</span>')
    expect(all).toContain('你太云了<span class="via plus-one">复读 <span class="pii">路人</span>，晚 2.1s</span>')
    expect(all).toContain('？<span class="via other">短句</span>')
    expect(all).toContain('[doge]<span class="via other">表情</span>')
    expect(all).toContain('你好<span class="via other">回复</span>')

    // Without the tally, only stickers and replies are marked, and there is no bar
    const untagged = renderMarked([], [{}], { messages: sent })
    const list = untagged.match(/<details class="all">.*?<\/details>/s)?.[0]
    expect(list).toContain('<span>？</span>')
    expect(list).toContain('<span>我自己想说的话</span>')
    expect(list).toContain('[doge]<span class="via other">表情</span>')
    expect(untagged).not.toContain('class="parts"')
  })

  test('splits a tallied user’s danmaku into parts, counted in a legend and explained on hover', () => {
    const sent = [
      said(0, '才八点'),
      said(10, '才八点'),
      said(20, '才八点'),
      said(30, '你太云了'),
      said(40, '我自己想说的话'),
      said(50, '？'),
      said(60, '草'),
      said(70, '[doge]', { isEmote: true }),
      said(80, '你好', { isReply: true }),
    ]
    const history: TalliedSend[] = [
      { at: T0, text: '才八点', senders: 22 },
      { at: T0 + 10_000, text: '才八点', senders: 20 },
      { at: T0 + 20_000, text: '才八点', senders: 9 },
      { at: T0 + 30_000, text: '你太云了', senders: 1, from: '路人', lagMs: 2100 },
      { at: T0 + 40_000, text: '我自己想说的话', senders: 0 },
    ]
    const page = renderMarked([], [{}], { messages: sent, histories: new Map([['1:42', history]]) })
    const parts = page.match(/<div class="parts">.*?<\/p><\/div>/s)?.[0] ?? ''
    expect(parts).toContain(
      'aria-label="9 条弹幕：跟队形 3 条（33%），+1 1 条（11%），自己说的 1 条（11%），短句、表情和回复 4 条（44%）"'
    )
    expect(parts).toContain(
      '<i class="chant" style="flex-grow:3" data-tip="跟队形 · 3 条 · 占 33%" data-tip-note="复读前一分钟内 3 人以上在刷的内容"></i>'
    )
    // A +1 says whose lines and how late; the gray part, which kinds the tally left out
    expect(parts).toContain(
      'data-tip="+1 · 1 条 · 占 11%" data-tip-note="复读一两个人刚发的内容\n来自 1 人，通常比原弹幕晚 2.1s"'
    )
    expect(parts).toContain(
      '<i class="other" style="flex-grow:4" data-tip="短句、表情和回复 · 4 条 · 占 44%" data-tip-note="短句 2 条 · 表情 1 条 · 回复 1 条\n单独发的短句（如「？」）、表情和 @ 回复不算复读，也不算自己说的"></i>'
    )
    // The legend names and counts each part, with its segment's tooltip, which keyboard readers reach by focus
    expect(parts).toContain(
      '<span tabindex="0" aria-describedby="tip" data-tip="跟队形 · 3 条 · 占 33%" data-tip-note="复读前一分钟内 3 人以上在刷的内容"><i class="swatch-seg chant"></i>跟队形<b>3</b></span>'
    )
    expect(parts).toContain(
      '<i class="swatch-seg other"></i><span>短句<b>2</b></span>·<span>表情<b>1</b></span>·<span>回复<b>1</b></span></span>'
    )
    expect(parts.split('data-tip="跟队形 · 3 条 · 占 33%"')).toHaveLength(3)

    // A sliver reads <1%; a part at zero draws nothing
    const chatty = Array.from({ length: 150 }, (_, i) => said(i * 10, `第 ${i} 句`))
    const own: TalliedSend[] = chatty.map(message => ({ at: message.timestamp, text: message.text, senders: 0 }))
    const sticker = said(1505, '[doge]', { isEmote: true })
    const sliver = renderMarked([], [{}], { messages: [...chatty, sticker], histories: new Map([['1:42', own]]) })
    expect(sliver).toContain('aria-label="151 条弹幕：自己说的 150 条（99%），表情 1 条（&lt;1%）"')
    expect(sliver).toContain('data-tip="表情 · 1 条 · 占 &lt;1%" data-tip-note="单独发的短句')
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
