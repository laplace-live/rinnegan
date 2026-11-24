import { describe, expect, test } from 'bun:test'

import type { DetectorOptions } from './detector.ts'
import type { Assessment, ChatMessage } from './types.ts'

import { DEFAULT_DETECTOR_OPTIONS, Detector } from './detector.ts'
import {
  type AutoBlendOptions,
  INVISIBLE_PRESETS,
  type LoopOptions,
  mergeStreams,
  novelText,
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
  wholeSeconds,
} from './testing/simulate.ts'

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

/** {@link BUSY_ROOM} chanting long lines, so 自动融入 cuts what it copies at its length limit. */
const LONG_CROWD = simulateCrowd({
  ...BUSY_ROOM,
  lines: BUSY_ROOM.lines.map(line => `${line}！${'主播今天的状态真的太好了大家一起刷起来'.repeat(2)}`),
})

/** A novel read out by chatterbox, cut at `maxLength`, one chunk every `intervalSec`. */
function readNovel(
  uid: number,
  intervalSec: number,
  maxLength: number,
  extra: Partial<LoopOptions> = {}
): ChatMessage[] {
  return simulateChatterboxLoop({
    persona: persona(uid),
    template: novelText(400, seededRandom(uid)),
    startAt: T0,
    durationMs: 40 * MINUTE,
    intervalSec,
    maxLength,
    ...extra,
  })
}

/** One danmaku from `uid` at about `at`. */
function say(uid: number, text: string, at: number): ChatMessage {
  return simulateFixedTimer({
    persona: persona(uid),
    texts: [text],
    startAt: at,
    sends: 1,
    intervalMs: 1,
  })[0] as ChatMessage
}

/** Chants of 3 viewers out of `viewers`, one at a time, `gapMs` apart: nothing ever overlaps. */
function chantRoom(rounds: number, gapMs: [number, number], viewers = 3, seed = 7): ChatMessage[] {
  const random = seededRandom(seed)
  const out: ChatMessage[] = []
  let at = T0
  for (let r = 0; r < rounds; r++) {
    const picked = Array.from({ length: viewers }, (_, i) => 300 + i)
      .sort(() => random() - 0.5)
      .slice(0, 3)
    for (const [i, uid] of picked.entries()) out.push(say(uid, `口号${r}`, at + i * 400))
    at += gapMs[0] + random() * (gapMs[1] - gapMs[0])
  }
  return mergeStreams(out)
}

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
    const tick = peak?.evidence.find(item => item.kind === 'send-tick')
    // The 1010 ms queue gap plus this persona's request latency
    expect(tick?.tickMs).toBeGreaterThanOrEqual(1150)
    expect(tick?.tickMs).toBeLessThanOrEqual(1450)
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

  describe('a novel read out chunk by chunk, no chunk repeating', () => {
    test.each([
      [1, 38],
      [10, 35],
      [35, 40],
    ])('one every %d s, cut at %d chars', (intervalSec, maxLength) => {
      const { peak, spamAfter } = judge(readNovel(120, intervalSec, maxLength), 120)
      expect(peak?.verdict).toBe('spam')
      expect(peak?.pattern).toBe('template')
      expect(peak?.timedSends).toBe(true)
      // Every chunk in the window is a timed send, and `repeats` and the evidence count them all
      expect(peak?.repeats).toBe(peak?.windowMessages)
      expect(peak?.evidence.find(item => item.kind === 'template-cycle')?.detail).toStartWith(`${peak?.repeats} 条长句`)
      expect(spamAfter).toBeLessThanOrEqual(22)
    })

    test('with lines typed by hand in between', () => {
      const lines = ['？', '哈哈哈', '主播好', '你说得对', '笑死我了', '这段我看过']
      const chat = simulateHumanChat({ persona: persona(121), lines, startAt: T0, sends: 60 })
      const { peak } = judge(mergeStreams(readNovel(121, 10, 35), chat), 121)
      expect(peak?.verdict).toBe('spam')
      expect(peak?.evidence.find(item => item.kind === 'template-cycle')?.detail).toContain('其间另发')
    })

    test('shows the chunks it read last, not the lines typed in between', () => {
      const chunks = readNovel(122, 10, 35)
      // A repeated line of the user's own, which an assessment otherwise shows first
      const typed = chunks.filter((_, i) => i % 7 === 3).map(chunk => say(122, '？', chunk.timestamp + 4000))
      const detector = new Detector()
      let last: Assessment | undefined
      for (const message of mergeStreams(chunks, typed))
        if (message.text !== '？') last = detector.ingest(message).assessment
        else detector.ingest(message)
      expect(last?.clusters.map(cluster => cluster.samples[0]?.text)).toEqual(
        chunks
          .slice(-3)
          .reverse()
          .map(message => message.text)
      )
    })

    test('while chanting a line by hand in between', () => {
      // The chant's resends would set the beat at ~9 s; the chunks keep theirs.
      const chant = simulateHumanChant({ persona: persona(124), line: '流汗', startAt: T0, sends: 200 })
      const { peak } = judge(mergeStreams(readNovel(124, 35, 40), chant), 124)
      expect(peak?.verdict).toBe('spam')
      expect(peak?.timedSends).toBe(true)
    })

    test('with a line of their own typed 3 s after every other chunk', () => {
      // Gaps of 3, 7 and 10 s come up equally often, so the densest band of gaps needn't be the timer's beat
      const chunks = simulateFixedTimer({
        persona: persona(125),
        texts: novelText(60, seededRandom(125)).split('\n'),
        startAt: T0,
        sends: 60,
        intervalMs: 10_000,
      })
      const own = novelText(30, seededRandom(126)).split('\n')
      const typed = chunks
        .filter((_, i) => i % 2 === 0)
        .map((chunk, i) => say(125, (own[i] as string).slice(0, 12), chunk.timestamp + 3000))
      expect(judge(mergeStreams(chunks, typed), 125).peak?.verdict).toBe('spam')
    })

    test('that sped up from 20 s to 10 s', () => {
      // One chain through both speeds is mostly missed beats, and the 20 s beat finds too few changes; the fast part
      // alone is on its beat
      const lines = novelText(29, seededRandom(127)).split('\n')
      const slow = lines.slice(0, 8).map((line, i) => say(127, line, T0 + i * 20_000))
      const fast = lines.slice(8).map((line, i) => say(127, line, T0 + 150_000 + i * 10_000))
      const { peak } = judge([...slow, ...fast], 127)
      expect(peak?.verdict).toBe('spam')
      expect(peak?.timedSends).toBe(true)
    })

    test('a random interval stays below spam, as a looped line does', () => {
      expect(judge(readNovel(123, 10, 35, { randomInterval: true }), 123).peak?.verdict).not.toBe('spam')
    })
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

  test.each<[string, Omit<AutoBlendOptions, 'persona'>]>([
    ['2 s cooldown resending cut copies', { cooldownMs: 2000 }],
    ['a 10-char length limit', { maxLength: 10 }],
  ])('copying long chants: %s', (_name, options) => {
    const { peak } = judge(
      mergeStreams(LONG_CROWD, simulateAutoBlend(LONG_CROWD, { persona: persona(403), ...options })),
      403
    )
    expect(peak?.verdict).toBe('spam')
    expect(peak?.evidence.find(item => item.kind === 'trend-trigger')?.weight).toBe(0.9)
  })

  test("@-replies don't complete a trigger", () => {
    // Each line's third send is an @-reply, which 自动融入 skips; a rival completes right after, before the bot sends.
    const room = (asReply: boolean) =>
      Array.from({ length: 15 }, (_, r) => {
        const at = T0 + r * 12_000
        const line = (uid: number, text: string, offset: number, isReply = false): ChatMessage => ({
          ...say(uid, text, at + offset),
          isReply,
        })
        return [
          line(310, `梗${r}`, 0),
          line(311, `梗${r}`, 200),
          line(312, `梗${r}`, 400, asReply),
          ...[313, 314, 315].map((uid, i) => line(uid, `对手${r}`, 500 + i * 100)),
          ...[313, 314, 315].map((uid, i) => line(uid, `诱饵${r}`, 8600 + i * 500)),
          line(404, `梗${r}`, 1100),
        ]
      }).flat()
    const trigger = (asReply: boolean) =>
      judge(mergeStreams(room(asReply)), 404).peak?.evidence.find(item => item.kind === 'trend-trigger')
    expect(trigger(false)?.weight).toBe(0.9)
    expect(trigger(true)).toBeUndefined()
  })

  test('29% random drop still shows trigger evidence', () => {
    // A dropped trigger neither sends nor starts a cooldown, which the replay doesn't model, so it can stay partial.
    const bot = simulateAutoBlend(CROWD, { persona: persona(401), dropPercent: 29 })
    const { peak } = judge(mergeStreams(CROWD, bot), 401)
    expect(peak?.verdict).not.toBe('none')
    expect(peak?.pattern).toBe('blend')
    expect(peak?.evidence.find(item => item.kind === 'trend-trigger')?.weight).toBeGreaterThanOrEqual(0.6)
  })

  describe('one chant at a time, where the replay alone has nothing to decide', () => {
    const room = chantRoom(40, [20_000, 40_000])
    /** Three stock bots on steady latencies, as several chatterbox tabs answer one trigger. */
    const swarm = [410, 411, 412].map((uid, i) =>
      simulateAutoBlend(room, { persona: persona(uid), latencyMs: [900 + i * 60, 900 + i * 60], jitterMs: 40 })
    )

    test('a lone bot stays below spam', () => {
      expect(judge(mergeStreams(room, swarm[0] as ChatMessage[]), 410).peak?.verdict).not.toBe('spam')
    })

    test('bots switching in step with each other are caught, all but the one that always sends first', () => {
      const all = mergeStreams(room, ...swarm)
      for (const uid of [411, 412]) {
        const { peak } = judge(all, uid)
        expect(peak?.verdict).toBe('spam')
        expect(peak?.pattern).toBe('blend')
        expect(peak?.evidence.find(item => item.kind === 'lockstep')?.weight).toBe(0.9)
      }
      // Nothing but timing points at the fastest bot, and a copier following a viewer would time the same.
      const leader = judge(all, 410).peak
      expect(leader?.verdict).toBe('suspect')
      expect(leader?.evidence.find(item => item.kind === 'lockstep')?.detail).toContain('总是先发')
    })

    test('随机字符 on every chant it copies', () => {
      const bot = simulateAutoBlend(room, { persona: persona(413), randomChar: '\u00AD' })
      const { peak } = judge(mergeStreams(room, bot), 413)
      expect(peak?.verdict).toBe('spam')
      expect(peak?.pattern).toBe('blend')
      expect(peak?.evidence.map(item => item.detail).join('\n')).toContain('种内容都插入不可见字符')
      // Each chant is sent once, so the samples come from its latest single sends.
      expect(peak?.clusters).toHaveLength(3)
      expect(peak?.clusters[0]?.samples[0]?.text).toContain('\u00AD')
    })

    test('names a nameless partner without its uid, since evidence goes to AI review', () => {
      const nameless = simulateAutoBlend(room, {
        persona: { uid: 414, uname: '', roomId: 1 },
        latencyMs: [900, 900],
        jitterMs: 40,
      })
      const named = simulateAutoBlend(room, { persona: persona(415), latencyMs: [960, 960], jitterMs: 40 })
      const detail = judge(mergeStreams(room, nameless, named), 415).peak?.evidence.find(
        item => item.kind === 'lockstep'
      )?.detail
      expect(detail).toContain('与 另一个账号')
      expect(detail).not.toContain('414')
    })

    test('lists the partner it names, so reports can hide it', () => {
      const found = judge(mergeStreams(room, ...swarm), 411).peak?.evidence.find(item => item.kind === 'lockstep')
      expect(found?.names).toEqual([expect.stringMatching(/^user41[02]$/)])
      expect(found?.detail).toContain(`与 ${found?.names?.[0]}`)
    })

    test('hand-chasers joining the same chants as the swarm stay below spam', () => {
      for (let seed = 1; seed <= 4; seed++) {
        const human = simulateTrendChaser(room, {
          persona: persona(209),
          ...TREND_CHASERS.quick,
          random: seededRandom(seed),
        })
        expect(judge(mergeStreams(room, ...swarm, human), 209).peak?.verdict).not.toBe('spam')
      }
    })

    test('+1-ing a jittered bot chant after chant stays below spam', () => {
      const bot = simulateAutoBlend(room, { persona: persona(413), randomChar: '\u00AD' })
      const copier = simulatePlusOne(bot, persona(210), 1, seededRandom(5))
      expect(judge(mergeStreams(room, bot, copier), 210).peak?.verdict).not.toBe('spam')
    })
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

  test('an account back from idle on the line it left with still counts that switch', () => {
    // Flagged, so going idle keeps its state; it stops on 才八点, the line the swarm opens with once a window has passed.
    const loop = simulateChatterboxLoop({
      persona: persona(421),
      template: '才八点',
      startAt: T0,
      durationMs: 2 * MINUTE,
      randomChar: '\u00AD',
    })
    const swarm: ChatMessage[] = []
    for (let r = 0; r < 9; r++) {
      const at = T0 + DEFAULT_DETECTOR_OPTIONS.windowMs + 3 * MINUTE + r * 20_000
      const line = r === 0 ? '才八点' : `梗${r}`
      for (const [i, uid] of [31, 32, 33].entries()) swarm.push(say(uid, line, at + i * 300))
      swarm.push(say(420, line, at + 1600), say(421, line, at + 1650))
    }
    const detector = new Detector()
    let last: Assessment | undefined
    for (const message of mergeStreams(loop, swarm)) {
      const { assessment } = detector.ingest(message)
      if (message.uid === 421) last = assessment
    }
    expect(detector.summaries().find(summary => summary.uid === 421)?.episodes[0]?.verdict).toBe('spam')
    expect(last?.evidence.find(item => item.kind === 'lockstep')?.detail).toContain('同步换内容 9 次')
  })
})

describe('humans are never judged spam', () => {
  const SEEDS = 40

  test('a viewer whom a fast copier follows on every chant they join', () => {
    const room = chantRoom(40, [20_000, 40_000])
    const viewer = simulateTrendChaser(room, { persona: persona(214), ...TREND_CHASERS.quick, random: seededRandom(3) })
    // Answers each of the viewer's switches 200 ms later, so the pair keeps step; only the copier is automated.
    const copier = viewer.map(message => ({
      ...message,
      id: `${message.id}-copy`,
      uid: 215,
      timestamp: message.timestamp + 200,
    }))
    const messages = mergeStreams(room, viewer, copier)
    expect(judge(messages, 214).peak?.verdict).not.toBe('spam')
    expect(judge(messages, 215).peak?.verdict).toBe('spam')
  })

  test('chatting in Persian, whose spelling puts ZWNJ inside words', () => {
    const lines = ['روم', 'دانم', 'خواهم', 'بینم', 'گویم', 'نویسم', 'خورم', 'آیم', 'شنوم', 'پرسم'].map(
      verb => `می\u200C${verb}`
    )
    const { peak } = judge(simulateHumanChat({ persona: persona(213), lines, startAt: T0, sends: 30 }), 213)
    expect(peak?.verdict).toBe('none')
    expect(peak?.evidence).toEqual([])
  })

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
      // An hour holds enough repeats of a short line for `suspect` on volume, but never automation proof
      const { peak } = judge(messages, 203)
      expect(peak?.verdict).not.toBe('spam')
      expect(peak?.proof).toBe(0)
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

  // One trend at a time leaves nothing for a cooldown or the first-to-complete rule to decide.
  test.each<[string, [number, number], number]>([
    ['3 viewers chanting 20–40 s apart', [20_000, 40_000], 3],
    ['5 viewers taking turns 4–12 s apart', [4000, 12_000], 5],
  ])('joining every chant within 2 s: %s', (_name, gapMs, viewers) => {
    for (let seed = 1; seed <= 4; seed++) {
      const room = chantRoom(60, gapMs, viewers, seed)
      const human = simulateTrendChaser(room, {
        persona: persona(208),
        ...TREND_CHASERS.quick,
        random: seededRandom(seed),
      })
      expect(judge(mergeStreams(room, human), 208).peak?.verdict).not.toBe('spam')
    }
  })

  test("+1-ing other viewers' long lines one after another as fast as allowed, every ~4.6 s", () => {
    // Every line is new, so nothing repeats: only whose lines they are tells this from a text read out on a timer.
    const lines = novelText(400, seededRandom(9)).split('\n')
    const room = lines.map((line, i) => say(600 + (i % 40), line, T0 + i * 2000))
    for (let seed = 1; seed <= SEEDS; seed++) {
      const random = seededRandom(seed)
      const copies: ChatMessage[] = []
      for (let at = T0 + 10_000; at < T0 + lines.length * 2000; at += 4350 + random() * 500) {
        const source = room[Math.floor((at - T0) / 2000)] as ChatMessage
        copies.push({ ...source, id: `${source.id}-copy`, uid: 216, uname: 'user216', timestamp: Math.round(at) })
      }
      expect(judge(mergeStreams(room, copies), 216).peak?.verdict).not.toBe('spam')
    }
  })

  test('counting to 60 once a second', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const random = seededRandom(seed)
      const counts: ChatMessage[] = []
      for (let i = 1, at = T0; i <= 60; i++, at += 950 + random() * 150) counts.push(say(217, String(i), at))
      expect(judge(counts, 217).peak?.verdict).not.toBe('spam')
    }
  })

  test('+1-ing a busy room every ~6 s', () => {
    const copier = simulatePlusOne(CROWD, persona(207), 25)
    expect(judge(mergeStreams(CROWD, copier), 207).peak?.verdict).not.toBe('spam')
  })
})

describe('whole-second timestamps', () => {
  test('a novel read out every 10 s is still caught', () => {
    const { peak } = judge(wholeSeconds(readNovel(130, 10, 35)), 130)
    expect(peak?.verdict).toBe('spam')
    expect(peak?.timedSends).toBe(true)
  })

  test('a line looped every 10 s is still caught', () => {
    const loop = simulateChatterboxLoop({
      persona: persona(131),
      template: '主播好可爱',
      startAt: T0,
      durationMs: 10 * MINUTE,
      intervalSec: 10,
    })
    expect(judge(wholeSeconds(loop), 131).peak?.verdict).toBe('spam')
  })

  test('chanting by hand fits no send tick', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const chant = simulateHumanChant({
        persona: persona(132),
        line: '老公天下第一',
        startAt: T0,
        sends: 60,
        random: seededRandom(seed),
      })
      const { peak } = judge(wholeSeconds(chant), 132)
      expect(peak?.verdict).not.toBe('spam')
      expect(peak?.evidence.map(item => item.kind)).not.toContain('send-tick')
    }
  })

  // A best chain may skip a beat or two, which whole seconds leave room to fit by chance. The listed seeds did: at 3 s
  // through a runner-up beat or a steady stretch, at 6 s with gaps spread over the whole tolerance.
  test.each([
    [3, [4, 7, 23, 49]],
    [6, [162, 171]],
  ])('chatting long lines of their own every ~%d s stays below spam', (medianSec, chancy) => {
    for (const seed of [...chancy, ...Array.from({ length: 30 }, (_, i) => i + 1)]) {
      const random = seededRandom(seed)
      const chat: ChatMessage[] = []
      let at = T0
      for (const line of novelText(300, random).split('\n')) {
        // Log-normal gaps, σ 0.5 from a sum of three uniforms
        at += Math.max(1500, medianSec * 1000 * Math.exp(random() + random() + random() - 1.5))
        chat.push(say(133, line.slice(0, 30), at))
      }
      expect([seed, judge(wholeSeconds(chat), 133).peak?.verdict]).not.toEqual([seed, 'spam'])
    }
  })

  test('accounts switching lines in the same second are not paired', () => {
    const room = chantRoom(40, [20_000, 40_000])
    const swarm = [410, 411, 412].map((uid, i) =>
      simulateAutoBlend(room, { persona: persona(uid), latencyMs: [900 + i * 60, 900 + i * 60], jitterMs: 40 })
    )
    const { peak } = judge(wholeSeconds(mergeStreams(room, ...swarm)), 411)
    expect(peak?.evidence.map(item => item.kind)).not.toContain('lockstep')
  })
})

describe('手动融入 marks viewers who mostly copy the room by hand', () => {
  function manualBlendOf(messages: ChatMessage[], uid: number, options: Partial<DetectorOptions> = {}) {
    const detector = new Detector(options)
    for (const message of messages) detector.ingest(message)
    return detector.manualBlend(1, uid)
  }
  const ownLines = Array.from({ length: 80 }, (_, i) => `我自己想说的第${i}句`)
  const chat = (uid: number, sends: number) =>
    simulateHumanChat({ persona: persona(uid), lines: ownLines, startAt: T0, sends })

  test('a viewer who +1s a busy room and chats in between', () => {
    const viewer = mergeStreams(simulatePlusOne(CROWD, persona(500), 100), chat(500, 30))
    const blend = manualBlendOf(mergeStreams(CROWD, viewer), 500)
    expect(blend?.copies).toBeGreaterThanOrEqual(40)
    expect(blend?.ownSwitches).toBeGreaterThanOrEqual(20)
  })

  test('not a 自动融入 bot, even one whose owner chats alongside it', () => {
    const bot = mergeStreams(simulateAutoBlend(CROWD, { persona: persona(501) }), chat(501, 60))
    expect(manualBlendOf(mergeStreams(CROWD, bot), 501)).toBeNull()
  })

  test('not a viewer who mostly writes their own lines', () => {
    expect(manualBlendOf(mergeStreams(CROWD, chat(502, 40)), 502)).toBeNull()
  })

  test('lists every counted send unless manualHistory is off', () => {
    const room = mergeStreams(CROWD, simulatePlusOne(CROWD, persona(500), 100), chat(500, 30))
    const blend = manualBlendOf(room, 500)
    expect(blend?.history).toHaveLength(blend?.sends ?? -1)
    expect(manualBlendOf(room, 500, { manualHistory: false })).not.toHaveProperty('history')
  })

  test('lists every counted send of a flagged user too', () => {
    const loop = simulateChatterboxLoop({
      persona: persona(503),
      template: '关注主播谢谢喵',
      startAt: T0,
      durationMs: 2 * MINUTE,
      randomChar: '\u00AD',
    })
    const summaryOf = (options: Partial<DetectorOptions>) => {
      const detector = new Detector(options)
      for (const message of mergeStreams(CROWD, loop)) detector.ingest(message)
      return detector.summaries().find(summary => summary.uid === 503)
    }
    expect(summaryOf({ manualHistory: false })).not.toHaveProperty('history')
    const summary = summaryOf({})
    expect(summary?.peak.verdict).toBe('spam')
    expect(summary?.history).toHaveLength(loop.length)
    expect(summary?.history?.every(send => send.senders === 0)).toBe(true)
    expect(summary?.history?.map(send => send.at)).toEqual(loop.map(message => message.timestamp))
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
