import { describe, expect, test } from 'bun:test'

import type { Episode } from '@/detect/detector'
import type { ReportUser } from '@/report/report'
import type { ChatMessage } from '@/types'

import { buildActivity } from '@/report/activity'
import { compareMessages } from '@/sources/archive'

/** Local time on 2026-10-20, so the expectations hold in any time zone. */
function at(hour: number, minute: number, second = 0): number {
  return new Date(2026, 9, 20, hour, minute, second).getTime()
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
    automation: 0.9,
    messages: 0,
    firstAt: 0,
    lastAt: 0,
    peakAt: 0,
    evidence: [],
    clusters: [],
    episodes: [],
    exempt: null,
    ...patch,
  }
}

function sorted(...streams: ChatMessage[][]): ChatMessage[] {
  return streams.flat().sort(compareMessages)
}

describe('buildActivity', () => {
  test('draws one timeline per run of flagged stretches, with context around them', () => {
    const messages = sorted(
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
    expect(lane?.sends[0]).toBe(35 * 60)
    expect(lane?.sends).toHaveLength(31)
    expect(lane?.flagged).toEqual([[36 * 60, 40 * 60, 'spam']])
    expect(lane?.firstAt).toBe(at(20, 5))
    expect(lane?.lastAt).toBe(at(20, 10))

    expect(evening?.ticks[0]).toEqual({ at: at(19, 30), label: '19:30' })
    expect(evening?.ticks.map(tick => tick.label)).toContain('21:15')
  })

  test('keeps timelines inside the archive and labels midnight with its date', () => {
    const messages = sorted(every(9, at(23, 50), at(23, 59), 10_000), [message(9, at(23, 59) + 30 * 60_000)])
    const users = [flagged(9, { episodes: [episode(at(23, 52), at(23, 55))] })]
    const [period] = buildActivity(messages, users).periods
    expect(period?.from).toBe(at(23, 50))
    expect(period?.to).toBe(at(23, 59) + 30 * 60_000)
    expect(period?.ticks.map(tick => tick.label)).toContain('10-21')
  })

  test('bins the gaps between a user’s danmaku and keeps the send tick for guides', () => {
    const loop = every(1, at(20, 0), at(20, 0) + 49 * 1300, 1300)
    const messages = sorted(loop, [message(1, at(20, 10))], every(2, at(20, 0), at(20, 1), 10_000))
    const users = [
      flagged(1, {
        episodes: [episode(at(20, 0), at(20, 1))],
        evidence: [{ kind: 'send-tick', weight: 0.9, detail: '节拍', tickMs: 1300 }],
      }),
      flagged(2, { episodes: [episode(at(20, 0), at(20, 1))] }),
    ]
    const { gaps } = buildActivity(messages, users)
    const loopGaps = gaps.get('1:1')
    expect(loopGaps).toMatchObject({ max: 10, binMs: 200, over: 1, tickMs: 1300 })
    expect(loopGaps?.counts[6]).toBe(49)
    // 7 danmaku leave too few gaps to draw
    expect(gaps.has('1:2')).toBe(false)
  })

  test('reads badges as of the peak and streamer names from their own danmaku', () => {
    const messages = sorted(
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
  })

  test('has nothing to draw without flagged users', () => {
    const activity = buildActivity(every(9, at(20, 0), at(21, 0), 60_000), [])
    expect(activity.periods).toEqual([])
    expect(activity.gaps.size).toBe(0)
  })
})
