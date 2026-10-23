import { describe, expect, test } from 'bun:test'

import type { Assessment, ChatMessage } from '@/types'

import { Detector } from '@/detect/detector'
import {
  type AutoBlendOptions,
  INVISIBLE_PRESETS,
  mergeStreams,
  type Persona,
  seededRandom,
  simulateAutoBlend,
  simulateChatterboxLoop,
  simulateCheckIn,
  simulateCopyNinja,
  simulateCrowd,
  simulateFixedTimer,
  simulateHumanChant,
  simulateHumanChat,
  simulatePlusOne,
  simulateRepeatBurst,
  simulateStickerSweep,
  simulateTrendChaser,
  TREND_CHASERS,
} from '@/testing/simulate'

const T0 = Date.parse('2026-10-20T12:00:00Z')
const MINUTE = 60_000

function persona(uid: number, roomId = 1): Persona {
  return { uid, uname: `user${uid}`, roomId }
}

/** Run `messages` through a fresh detector; return the target's peak and when it first became spam. */
function judge(messages: ChatMessage[], uid: number): { peak: Assessment | null; spamAfter: number | null } {
  const detector = new Detector()
  let peak: Assessment | null = null
  let spamAfter: number | null = null
  let seen = 0
  for (const message of messages) {
    const { assessment } = detector.ingest(message)
    if (message.uid !== uid) continue
    seen++
    if (!peak || assessment.score > peak.score) peak = assessment
    if (spamAfter === null && assessment.verdict === 'spam') spamAfter = seen
  }
  return { peak, spamAfter }
}

/** A busy room, ~290 danmaku/min: 80 viewers chanting whichever lines are in fashion, which moves every 20 s. */
const BUSY_ROOM = {
  uidBase: 1000,
  size: 80,
  lines: '？ 哈哈哈 爆了 好听 来了 晚上好 草 awsl 666 好耶 可爱 晚安 绷不住了 确实 下次一定 牛啊'.split(' '),
  startAt: T0,
  durationMs: 25 * MINUTE,
  phaseMs: 20_000,
}
const CROWD = simulateCrowd(BUSY_ROOM)

describe('chatterbox 独轮车 is caught', () => {
  test.each([...INVISIBLE_PRESETS])('1 s loop with 随机字符 %p', char => {
    const messages = simulateChatterboxLoop({
      persona: persona(100),
      template: '老公天下第一！',
      startAt: T0,
      durationMs: 3 * MINUTE,
      randomChar: char,
    })
    const { peak, spamAfter } = judge(messages, 100)
    expect(peak?.verdict).toBe('spam')
    expect(spamAfter).toBeLessThanOrEqual(12)
    expect(peak?.evidence.map(item => item.kind)).toContain('invisible-jitter')
  })

  test('default 1 s loop of identical text, throttled by the duplicate filter', () => {
    const messages = simulateChatterboxLoop({
      persona: persona(101),
      template: '千舰之夜！',
      startAt: T0,
      durationMs: 5 * MINUTE,
    })
    const { peak, spamAfter } = judge(messages, 101)
    expect(peak?.verdict).toBe('spam')
    expect(spamAfter).toBeLessThanOrEqual(16)
    expect(peak?.evidence.map(item => item.kind)).toContain('send-tick')
  })

  test.each([5, 10, 30])('fixed %d s interval', intervalSec => {
    const messages = simulateChatterboxLoop({
      persona: persona(102),
      template: '主播好可爱',
      startAt: T0,
      durationMs: 10 * MINUTE,
      intervalSec,
    })
    expect(judge(messages, 102).peak?.verdict).toBe('spam')
  })

  test('random interval with 随机字符', () => {
    const messages = simulateChatterboxLoop({
      persona: persona(103),
      template: '关注奶绿喵',
      startAt: T0,
      durationMs: 5 * MINUTE,
      intervalSec: 3,
      randomInterval: true,
      randomChar: '­',
    })
    expect(judge(messages, 103).peak?.verdict).toBe('spam')
  })

  test('multi-line template', () => {
    const messages = simulateChatterboxLoop({
      persona: persona(104),
      template: '第一句话\n第二句话来了\n第三句话呢',
      startAt: T0,
      durationMs: 3 * MINUTE,
    })
    expect(judge(messages, 104).peak?.verdict).toBe('spam')
  })

  test('long line split at maxLength', () => {
    const messages = simulateChatterboxLoop({
      persona: persona(105),
      template: '关注奶绿喵关注奶绿谢谢喵关注奶绿喵关注奶绿谢谢喵关注奶绿喵',
      startAt: T0,
      durationMs: 3 * MINUTE,
      maxLength: 20,
      randomChar: '­',
    })
    expect(judge(messages, 105).peak?.verdict).toBe('spam')
  })

  test('visible custom 随机字符', () => {
    const messages = simulateChatterboxLoop({
      persona: persona(106),
      template: '主播今天唱歌了吗',
      startAt: T0,
      durationMs: 3 * MINUTE,
      randomChar: '丶',
    })
    const { peak } = judge(messages, 106)
    expect(peak?.verdict).toBe('spam')
    expect(peak?.evidence.map(item => item.kind)).toContain('insert-jitter')
    // Unmerged, each of the ~9 insert positions would be its own line with a handful of sends.
    expect(peak?.clusters[0]?.count).toBeGreaterThan(20)
  })

  test('YOLO paraphrases on the default interval', () => {
    const lines = ['老公天下第一', '老公宇宙第一', '老公全球第一', '老公天下无敌', '老公世界第一']
    const messages = simulateChatterboxLoop({
      persona: persona(107),
      template: 'x',
      startAt: T0,
      durationMs: 3 * MINUTE,
      rewrite: (_line, _round, random) => lines[Math.floor(random() * lines.length)] as string,
    })
    expect(judge(messages, 107).peak?.verdict).toBe('spam')
  })

  test('keyword replacement inserting a zero-width space', () => {
    const messages = simulateChatterboxLoop({
      persona: persona(108),
      template: '川​普来了',
      startAt: T0,
      durationMs: 5 * MINUTE,
      intervalSec: 5,
    })
    expect(judge(messages, 108).peak?.verdict).toBe('spam')
  })

  test('random repeat-count burst tool', () => {
    const messages = simulateRepeatBurst({ persona: persona(109), phrase: '数字植物', startAt: T0, sends: 20 })
    const { peak } = judge(messages, 109)
    expect(peak?.verdict).toBe('spam')
    expect(peak?.pattern).toBe('burst')
  })

  test('setInterval assistant script', () => {
    const messages = simulateFixedTimer({
      persona: persona(110),
      texts: ['够童'],
      startAt: T0,
      sends: 30,
      intervalMs: 6000,
    })
    expect(judge(messages, 110).peak?.verdict).toBe('spam')
  })

  test('Copy Ninja mirror of a loop', () => {
    const master = simulateChatterboxLoop({
      persona: persona(111),
      template: '千舰！千舰！',
      startAt: T0,
      durationMs: 3 * MINUTE,
      randomChar: '­',
    })
    const mirror = simulateCopyNinja(master, persona(112))
    expect(judge(mergeStreams(master, mirror), 112).peak?.verdict).toBe('spam')
  })
})

describe('chatterbox 自动融入 is caught', () => {
  // Simulated bots watch the crowd, not each other, so each one gets the room to itself.
  test.each<[string, Omit<AutoBlendOptions, 'persona'>]>([
    ['stock defaults', {}],
    ['auto cooldown', { cooldownAuto: true }],
    ['avoid-repeat', { avoidRepeat: true }],
    ['随机字符 U+00AD', { randomChar: '\u00AD' }],
    ['30 s cooldown', { cooldownMs: 30_000 }],
  ])('%s', (_name, options) => {
    const bot = simulateAutoBlend(CROWD, { persona: persona(400), ...options })
    const { peak, spamAfter } = judge(mergeStreams(CROWD, bot), 400)
    expect(peak?.verdict).toBe('spam')
    expect(peak?.pattern).toBe('blend')
    expect(peak?.evidence.find(item => item.kind === 'trend-trigger')?.weight).toBe(0.9)
    expect(spamAfter).toBeLessThanOrEqual(30)
  })

  test('stays blend when the trends it copies also cycle like a template', () => {
    // 150 viewers turn the fashion over so steadily that the bot's sends fit a template timer too.
    const crowd = simulateCrowd({ ...BUSY_ROOM, size: 150, random: seededRandom(3) })
    const { peak } = judge(mergeStreams(crowd, simulateAutoBlend(crowd, { persona: persona(400) })), 400)
    expect(peak?.evidence.map(item => item.kind)).toContain('template-cycle')
    expect(peak?.pattern).toBe('blend')
  })

  test('29% random drop still shows trigger evidence', () => {
    // A dropped trigger neither sends nor starts a cooldown, which the replay doesn't model, so it can stay partial.
    const bot = simulateAutoBlend(CROWD, { persona: persona(401), dropPercent: 29 })
    const { peak } = judge(mergeStreams(CROWD, bot), 401)
    expect(peak?.verdict).not.toBe('none')
    expect(peak?.pattern).toBe('blend')
    expect(peak?.evidence.find(item => item.kind === 'trend-trigger')?.weight).toBeGreaterThanOrEqual(0.6)
  })

  test('volume evidence counts one line, not the replay hits', () => {
    // The drop bot spreads its sends over a dozen lines; none repeats 15 times, however many changes the replay predicts.
    const bot = simulateAutoBlend(CROWD, { persona: persona(401), dropPercent: 29 })
    const detector = new Detector()
    const volumes: string[] = []
    for (const message of mergeStreams(CROWD, bot)) {
      const { assessment } = detector.ingest(message)
      if (message.uid !== 401) continue
      for (const item of assessment.evidence) if (item.kind === 'volume') volumes.push(item.detail)
    }
    expect(volumes).toEqual([])
  })
})

describe('humans are never judged spam', () => {
  const SEEDS = 40

  test('chanting a line by hand, even 60 times', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const messages = simulateHumanChant({
        persona: persona(200),
        line: '老公天下第一',
        startAt: T0,
        sends: 60,
        random: seededRandom(seed),
      })
      expect(judge(messages, 200).peak?.verdict).not.toBe('spam')
    }
  })

  test('+1-ing a jittered bot (copied invisible chars are not their doing)', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const bot = simulateChatterboxLoop({
        persona: persona(201),
        template: '千舰！千舰！',
        startAt: T0,
        durationMs: 10 * MINUTE,
        randomChar: '­',
        random: seededRandom(seed),
      })
      const copier = simulatePlusOne(bot, persona(202), 3, seededRandom(seed * 31))
      expect(judge(mergeStreams(bot, copier), 202).peak?.verdict).not.toBe('spam')
    }
  })

  test('chatting', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const messages = simulateHumanChat({
        persona: persona(203),
        lines: ['哈哈', '?', '爆了', '懂你意思', '主播好'],
        startAt: T0,
        sends: 80,
        random: seededRandom(seed),
      })
      expect(judge(messages, 203).peak?.verdict).toBe('none')
    }
  })

  test('fan-medal check-in bot and sticker panel sweeps', () => {
    expect(judge(simulateCheckIn(persona(204), T0), 204).peak?.verdict).toBe('none')
    expect(judge(simulateStickerSweep(persona(205), T0), 205).peak?.verdict).not.toBe('spam')
  })

  test('a busy room chanting trends', () => {
    const detector = new Detector()
    for (const message of CROWD) detector.ingest(message)
    const spam = detector.summaries().filter(summary => summary.peak.verdict === 'spam')
    expect(spam.map(summary => summary.uid)).toEqual([])
  })

  // Each run replays the whole crowd, so fewer seeds than above.
  test.each(['fast', 'rested'] as const)('joining trends by hand, %s', name => {
    for (let seed = 1; seed <= 5; seed++) {
      const human = simulateTrendChaser(CROWD, {
        persona: persona(206),
        ...TREND_CHASERS[name],
        random: seededRandom(seed),
      })
      expect(judge(mergeStreams(CROWD, human), 206).peak?.verdict).not.toBe('spam')
    }
  })

  test('+1-ing a busy room every ~6 s', () => {
    const copier = simulatePlusOne(CROWD, persona(207), 25)
    expect(judge(mergeStreams(CROWD, copier), 207).peak?.verdict).not.toBe('spam')
  })
})

describe('Detector', () => {
  test('repetition without automation evidence caps at suspect', () => {
    const messages = simulateHumanChant({ persona: persona(300), line: '老公天下第一', startAt: T0, sends: 30 })
    const { peak } = judge(messages, 300)
    expect(peak?.verdict).toBe('suspect')
    expect(peak?.score).toBeLessThan(90)
    expect(peak?.evidence.map(item => item.kind)).toEqual(['volume'])
  })

  test('keeps rooms apart', () => {
    const roomA = simulateChatterboxLoop({
      persona: persona(301, 1),
      template: '千舰！',
      startAt: T0,
      durationMs: 2 * MINUTE,
      randomChar: '­',
    })
    const detector = new Detector()
    for (const message of roomA) detector.ingest(message)
    const other = detector.ingest({ ...(roomA[0] as ChatMessage), id: 'x', roomId: 2, timestamp: T0 + 3 * MINUTE })
    expect(other.assessment.verdict).toBe('none')
    expect(detector.summaries().map(summary => summary.roomId)).toEqual([1])
  })

  test('emits a change on each new level and on a 5-point climb', () => {
    const messages = simulateChatterboxLoop({
      persona: persona(302),
      template: '千舰！',
      startAt: T0,
      durationMs: 2 * MINUTE,
      randomChar: '­',
    })
    const detector = new Detector()
    const changes = messages.map(message => detector.ingest(message)).filter(result => result.changed)
    expect(changes[0]?.assessment.verdict).toBe('suspect')
    expect(changes.some(result => result.assessment.verdict === 'spam')).toBe(true)
    for (let i = 1; i < changes.length; i++) {
      const prev = changes[i - 1]?.assessment as Assessment
      const next = changes[i]?.assessment as Assessment
      expect(next.verdict !== prev.verdict || next.score >= prev.score + 5).toBe(true)
    }
  })

  test('summaries rank users and record episodes', () => {
    const loud = simulateChatterboxLoop({
      persona: persona(303),
      template: '千舰！',
      startAt: T0,
      durationMs: 3 * MINUTE,
      randomChar: '­',
    })
    const quiet = simulateHumanChant({ persona: persona(304), line: '晚安', startAt: T0, sends: 25 })
    const detector = new Detector()
    for (const message of mergeStreams(loud, quiet)) detector.ingest(message)
    const summaries = detector.summaries()
    expect(summaries.map(summary => summary.uid)).toEqual([303, 304])
    const top = summaries[0]
    expect(top?.episodes.length).toBe(1)
    expect(top?.episodes[0]?.verdict).toBe('spam')
    expect(top?.peak.clusters[0]?.key).toBe('千舰')
    expect(top?.peak.clusters[0]?.samples.length).toBeGreaterThan(1)
  })

  test('caps remembered messages per user', () => {
    const detector = new Detector({ maxRecordsPerUser: 50 })
    const messages = simulateChatterboxLoop({
      persona: persona(305),
      template: '千舰！',
      startAt: T0,
      durationMs: 5 * MINUTE,
      randomChar: '­',
    })
    let last: Assessment | null = null
    for (const message of messages) last = detector.ingest(message).assessment
    expect(last?.windowMessages).toBe(50)
  })
})
