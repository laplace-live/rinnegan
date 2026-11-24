import { describe, expect, test } from 'bun:test'
import type { ChatMessage, Episode, TalliedSend } from '@laplace.live/rinnegan-sdk'

import type { ReportUser } from '@/report/report'

import { buildActivity } from '@/report/activity'
import { mergeStreams } from '@/testing/simulate'

/** China time, which reports use by default, on 2026-10-20, so the expectations hold on any machine. */
function at(hour: number, minute: number, second = 0): number {
  return Date.UTC(2026, 9, 20, hour - 8, minute, second)
}

let seq = 0

function message(uid: number, timestamp: number, patch: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `m${seq++}`,
    roomId: 1,
    uid,
    uname: `user${uid}`,
    text: '你好',
    timestamp,
    userType: 0,
    guardType: 0,
    isEmote: false,
    medalLevel: 0,
    isReply: false,
    ...patch,
  }
}

/** Danmaku from `uid` every `stepMs` in [from, to]. */
function every(uid: number, from: number, to: number, stepMs: number): ChatMessage[] {
  const out: ChatMessage[] = []
  for (let t = from; t <= to; t += stepMs) out.push(message(uid, t))
  return out
}

function episode(startAt: number, endAt: number, verdict: Episode['verdict'] = 'spam'): Episode {
  return { startAt, endAt, peakScore: 95, verdict, pattern: 'loop', key: '你好' }
}

function flagged(uid: number, patch: Partial<ReportUser> = {}): ReportUser {
  return {
    rank: uid,
    roomId: 1,
    uid,
    uname: `user${uid}`,
    verdict: 'spam',
    score: 95,
    pattern: 'loop',
    repeats: 30,
    triggerHits: false,
    timedSends: false,
    automation: 0.9,
    messages: 0,
    firstAt: 0,
    lastAt: 0,
    peakAt: 0,
    evidence: [],
    clusters: [],
    episodes: [],
    exempt: null,
    manualBlend: false,
    ...patch,
  }
}

describe('buildActivity', () => {
  test('draws one timeline per run of flagged stretches, with context around them', () => {
    const messages = mergeStreams(
      every(9, at(19, 0), at(23, 59), 60_000),
      every(1, at(20, 5), at(20, 10), 10_000),
      every(2, at(20, 40), at(20, 45), 10_000),
      every(3, at(23, 0), at(23, 2), 10_000)
    )
    const users = [
      flagged(1, { episodes: [episode(at(20, 6), at(20, 10))] }),
      flagged(2, { verdict: 'suspect', episodes: [episode(at(20, 41), at(20, 44), 'suspect')] }),
      flagged(3, { episodes: [episode(at(23, 0), at(23, 2))] }),
    ]
    const { periods } = buildActivity(messages, users)

    // 30 minutes either side, out to quarter hours; the two evening stretches overlap and merge
    expect(periods.map(period => [period.from, period.to])).toEqual([
      [at(19, 30), at(21, 15)],
      [at(22, 30), at(23, 45)],
    ])
    const [evening, late] = periods
    expect(evening?.lanes.map(lane => lane.uid)).toEqual([1, 2])
    expect(late?.lanes.map(lane => lane.uid)).toEqual([3])

    expect(evening?.bucketMs).toBe(60_000)
    expect(evening?.counts).toHaveLength(105)
    const inside = messages.filter(m => m.timestamp >= at(19, 30) && m.timestamp <= at(21, 15))
    expect(evening?.counts.reduce((sum, n) => sum + n, 0)).toBe(inside.length)

    const lane = evening?.lanes[0]
    expect(lane?.sends[0]).toBe(at(20, 5))
    expect(lane?.sends.at(-1)).toBe(at(20, 10))
    expect(lane?.sends).toHaveLength(31)
    expect(lane?.episodes).toEqual([episode(at(20, 6), at(20, 10))])

    expect(evening?.ticks[0]).toEqual({ at: at(19, 30), label: '19:30' })
    expect(evening?.ticks.map(tick => tick.label)).toContain('21:15')
  })

  test('keeps timelines inside the archive and labels midnight with its date', () => {
    const messages = mergeStreams(every(9, at(23, 50), at(23, 59), 10_000), [message(9, at(23, 59) + 30 * 60_000)])
    const users = [flagged(9, { episodes: [episode(at(23, 52), at(23, 55))] })]
    const [period] = buildActivity(messages, users).periods
    expect(period?.from).toBe(at(23, 50))
    expect(period?.to).toBe(at(23, 59) + 30 * 60_000)
    expect(period?.ticks.map(tick => tick.label)).toContain('10-21')
  })

  test('bins the gaps between a user’s danmaku and finds the narrowest range holding half of them', () => {
    const loop = every(1, at(20, 0), at(20, 0) + 49 * 1300, 1300)
    const messages = mergeStreams(loop, [message(1, at(20, 10))], every(2, at(20, 0), at(20, 1), 10_000))
    const users = [
      flagged(1, { episodes: [episode(at(20, 0), at(20, 1))] }),
      flagged(2, { episodes: [episode(at(20, 0), at(20, 1))] }),
    ]
    const { gaps } = buildActivity(messages, users)
    const loopGaps = gaps.get('1:1')
    expect(loopGaps).toMatchObject({ max: 10, binMs: 200, over: 1, half: [1300, 1300] })
    expect(loopGaps?.counts[6]).toBe(49)
    // 7 danmaku leave too few gaps to draw
    expect(gaps.has('1:2')).toBe(false)
  })

  test('the half range skips the outliers on either side', () => {
    const steps = [500, 900, 2000, 2100, 2150, 2200, 2300, 9000, 40_000, 60_000]
    const messages = [message(1, at(20, 0))]
    for (const step of steps) messages.push(message(1, (messages.at(-1) as ChatMessage).timestamp + step))
    const users = [flagged(1, { episodes: [episode(at(20, 0), at(20, 1))] })]
    expect(buildActivity(messages, users).gaps.get('1:1')?.half).toEqual([2000, 2300])
  })

  test('tags each flagged user’s danmaku with its tally entry, past the danmaku the tally skips', () => {
    const sent = [
      message(1, at(20, 0), { text: '晚上好' }),
      message(1, at(20, 1), { text: '[doge]', isEmote: true }),
      message(1, at(20, 2), { text: '？' }),
      message(1, at(20, 3), { text: ' 才八点 ' }),
      message(1, at(20, 4), { text: '你好', isReply: true }),
      message(1, at(20, 5), { text: '晚上好' }),
    ]
    const history: TalliedSend[] = [
      // Matches no danmaku, and must not hold up the rest
      { at: at(19, 59), text: '失配', senders: 0 },
      { at: at(20, 0), text: '晚上好', senders: 0 },
      { at: at(20, 3), text: '才八点', senders: 22 },
      { at: at(20, 5), text: '晚上好', senders: 1, from: 'user2', lagMs: 3000 },
    ]
    const users = [flagged(1, { episodes: [episode(at(20, 0), at(20, 5))] })]
    const tags = buildActivity(sent, users, [], new Map([['1:1', history]])).tallies.get('1:1')
    expect(sent.map(m => tags?.get(m)?.senders ?? null)).toEqual([0, null, null, 22, null, 1])
    // No history, no tags
    expect(buildActivity(sent, users).tallies.size).toBe(0)
  })

  test('reads badges as of the peak and streamer names from their own danmaku', () => {
    const messages = mergeStreams(
      [
        message(1, at(20, 0), { guardType: 3, medalLevel: 21, medalName: '奶糖花' }),
        message(1, at(20, 1), { guardType: 3, medalLevel: 22, medalName: '奶糖花' }),
        message(1, at(20, 5), { medalLevel: 5, medalName: '别家' }),
      ],
      [message(7, at(20, 2), { userType: 100, uname: '主播' })]
    )
    const users = [flagged(1, { peakAt: at(20, 1), episodes: [episode(at(20, 0), at(20, 1))] })]
    const activity = buildActivity(messages, users)
    expect(activity.badges.get('1:1')).toEqual({ userType: 0, guardType: 3, medalName: '奶糖花', medalLevel: 22 })
    expect(activity.hosts.get(1)).toBe('主播')
    expect(activity.danmaku.get('1:1')?.map(sent => sent.timestamp)).toEqual([at(20, 0), at(20, 1), at(20, 5)])
    expect(activity.danmaku.has('1:7')).toBe(false)
  })

  test('keeps 手动融入 viewers’ danmaku, reads their badges from the last one and charts nothing for them', () => {
    const messages = [
      message(3, at(20, 0), { medalLevel: 9, medalName: '奶糖花' }),
      message(9, at(20, 1)),
      message(3, at(20, 5), { guardType: 3, medalLevel: 10, medalName: '奶糖花' }),
    ]
    const activity = buildActivity(messages, [], [{ roomId: 1, uid: 3 }])
    expect(activity.badges.get('1:3')).toEqual({ userType: 0, guardType: 3, medalName: '奶糖花', medalLevel: 10 })
    expect(activity.danmaku.get('1:3')?.map(sent => sent.timestamp)).toEqual([at(20, 0), at(20, 5)])
    expect(activity.danmaku.has('1:9')).toBe(false)
    expect(activity.periods).toEqual([])
    expect(activity.gaps.size).toBe(0)
    // No history, no tally to split their danmaku by
    expect(activity.mixes.size).toBe(0)
  })

  test('counts each tallied user’s danmaku by kind, with whose lines they +1’d and how late', () => {
    const sent = [
      message(3, at(20, 0), { text: '才八点' }),
      message(3, at(20, 1), { text: '你太云了' }),
      message(3, at(20, 2), { text: '？' }),
      message(3, at(20, 3), { text: '晚上好' }),
      message(3, at(20, 4), { text: '[doge]', isEmote: true }),
      message(3, at(20, 5), { text: '你太云了' }),
      message(3, at(20, 6), { text: '你好', isReply: true }),
      message(3, at(20, 7), { text: '好听' }),
    ]
    const history: TalliedSend[] = [
      { at: at(20, 0), text: '才八点', senders: 22 },
      { at: at(20, 1), text: '你太云了', senders: 1, from: '路人', lagMs: 2000 },
      { at: at(20, 3), text: '晚上好', senders: 0 },
      { at: at(20, 5), text: '你太云了', senders: 2, from: '路人', lagMs: 6000 },
      { at: at(20, 7), text: '好听', senders: 1, from: '另一个人', lagMs: 3000 },
    ]
    const activity = buildActivity(sent, [], [{ roomId: 1, uid: 3 }], new Map([['1:3', history]]))
    expect(activity.mixes.get('1:3')).toEqual({
      counts: { chant: 1, 'plus-one': 3, own: 1, short: 1, emote: 1, reply: 1 },
      sources: 2,
      lagMs: 3000,
    })
    expect(activity.tallies.get('1:3')?.size).toBe(5)
  })

  test('has nothing to draw without flagged users', () => {
    const activity = buildActivity(every(9, at(20, 0), at(21, 0), 60_000), [])
    expect(activity.periods).toEqual([])
    expect(activity.gaps.size).toBe(0)
  })
})
