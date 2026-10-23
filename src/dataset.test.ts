/**
 * Regression tests against real LAPLACE Chat archives in `references/` (gitignored; skipped when absent).
 * Users are referenced by salted uid hashes so the repository never lists who was judged.
 */

import { beforeAll, describe, expect, test } from 'bun:test'

import type { UserSummary } from '@/detect/detector'
import type { AutoBlendOptions, Persona } from '@/testing/simulate'
import type { Assessment, ChatMessage } from '@/types'

import { Detector } from '@/detect/detector'
import { extractMessages, readArchive } from '@/sources/archive'
import {
  mergeStreams,
  seededRandom,
  simulateAutoBlend,
  simulateChatterboxLoop,
  simulateRepeatBurst,
  simulateTrendChaser,
  TREND_CHASERS,
} from '@/testing/simulate'

const ARCHIVE = 'references/25034104_明前奶绿_10_20_2026,_10_40_44_AM.lca'
const available = await Bun.file(ARCHIVE).exists()

function uidHash(uid: number): string {
  return new Bun.CryptoHasher('sha256').update(`rinnegan:${uid}`).digest('hex').slice(0, 12)
}

/** Reviewed by hand: each is automation, labelled by the trick it used. */
const CONFIRMED_SPAM: Record<string, string> = {
  d05d7da2f599: '千舰 loop, U+00AD 随机字符 at 31 positions',
  '6a10424b9d16': '老公天下第一 on the 1.3 s chatterbox tick, 123 sends in 10 min',
  '2f4b98b2277b': '伞来☂ loop on the send tick, 1 variant',
  '013500755e88': '够童 every 6.5 s, 94% on beat',
  '7a83eefedab5': '千舰之夜 every 1.3 s with U+00AD jitter',
  b12c4ae6beb0: 'repeat-count burst tool (phrase ×1–10 per send, ~1 s apart)',
  '283a39c4e76f': '老公天下第一 with U+00AD jitter, 71 sends in 10 min',
  '8719d9f48e35': '3-line template cycled every 2.4 s',
  a1879519f198: '千舰之夜 on a fixed 8.2 s timer',
  '3fb856e1bc85': 'to签 rotated repeats every 1.3 s',
  '2066e138a3ec': '千舰之夜 repeat-count burst tool',
  '62ed603e50bf': 'auto-blend: U+00AD on every trending line',
  '698af547f98f': 'U+E0020–U+E0029 tag-char jitter, every 30 s',
  b53bac425953: 'repeat-count burst at 1.5 s',
  '89afe6b86fc7': '🍆奶绿🥖 loop with U+00AD at 11 positions',
  '4512a167cf4c': 'long line resent every 2.3 s',
  c74578877fac: '自动融入-style trend follower on a ~5 s cooldown, gaps land on the 1.3 s tick',
  f2a73aaf1290: '? resent every 10.4 s (8 ticks) for minutes',
  '2703520ab6aa': 'stock 自动融入: 10 s cooldown, gaps never below ~10 s',
  '662c3f4d8cf9': '自动融入 with avoid-repeat on a 2 s cooldown, joins 3-person micro-trends',
  ab50bd5420b3: '自动融入 on a ~5 s cooldown, copies the long 老公天下第一 chant',
  '02eb8896c257': '自动融入 on a ~5 s cooldown',
  '17da0945ce9c': 'chats by hand with 自动融入 running alongside; its copies land 50–90 ms after the trigger',
  '8d5c8f6d3bd4': 'partial trigger evidence plus a steady random-interval cadence',
}

/** Must never reach `spam`: heavy-but-human behaviour and benign automation. */
const NOT_SPAM: Record<string, string> = {
  '52703d900a1f': 'chants by hand, later pastes one bot line verbatim (+1)',
  '539b3121bf5a': 'heavy +1 of other users’ jittered lines',
  '8f57bb7c369d': 'clicks four neighbouring stickers across the panel',
  '686731eb7a53': 'very active human chatter',
  a2876a2a5629: 'very active human chatter',
  '0221fe2a3bc3': 'very active human chatter',
  '25da45b485b7': 'the streamer',
  fd1e11b10c4a: 'fan-medal check-in bot, 10 kaomoji once',
  '6776cfd99d08': 'sticker check-in bot, 10 stickers on a 5.2 s timer',
  '6ecc01c97533': 'check-in bot, “check in” in 10 languages',
}

/** Busy stretch (UTC) the injection tests copy: the stream's peak hour and the quieter hour after it */
const BUSY_FROM = Date.parse('2026-10-20T12:00:00Z')
const BUSY_TO = Date.parse('2026-10-20T14:00:00Z')
/** Where hand-chasers look most like 自动融入: trends turn over every few seconds */
const HOT_FROM = Date.parse('2026-10-20T13:00:00Z')
const HOT_TO = Date.parse('2026-10-20T15:00:00Z')

/** 自动融入 settings; omitted ones keep chatterbox's defaults (10 s cooldown). */
const BLEND_BOTS: Record<string, Omit<AutoBlendOptions, 'persona'>> = {
  stock: {},
  'auto cooldown': { cooldownAuto: true },
  'auto cooldown + avoid-repeat': { cooldownAuto: true, avoidRepeat: true },
  '4 s cooldown + 29% random drop': { cooldownMs: 4000, dropPercent: 29 },
  '30 s cooldown': { cooldownMs: 30_000 },
  '随机字符 U+00AD': { randomChar: '\u00AD' },
}

/**
 * Each config's simulated user alone in its own copy of `room`, all copies through one Detector. Simulated users never
 * see each other, so two in one room would break the 自动融入 replay.
 */
function injectAlone<T extends object>(
  room: readonly ChatMessage[],
  configs: Record<string, T>,
  simulate: (room: readonly ChatMessage[], options: NoInfer<T> & { persona: Persona }) => ChatMessage[]
): { name: string; sends: number; peak?: Assessment }[] {
  const streams: ChatMessage[][] = []
  const injected = Object.entries(configs).map(([name, config], k) => {
    const roomId = k + 1
    const copy = room.map(message => ({ ...message, id: `${message.id}#${k}`, roomId }))
    const persona = { uid: 9_100_001 + k, uname: `inject-${k}`, roomId }
    const sends = simulate(copy, { ...config, persona })
    streams.push(copy, sends)
    return { name, persona, sends: sends.length }
  })
  const detector = new Detector()
  for (const message of mergeStreams(...streams)) detector.ingest(message)
  const summaries = detector.summaries()
  return injected.map(({ name, persona, sends }) => ({
    name,
    sends,
    peak: summaries.find(summary => summary.roomId === persona.roomId && summary.uid === persona.uid)?.peak,
  }))
}

describe.skipIf(!available)(`real archive ${ARCHIVE}`, () => {
  let messages: ChatMessage[] = []
  let busy: ChatMessage[] = []
  let summaries: UserSummary[] = []
  let byHash = new Map<string, UserSummary>()
  let detectMs = 0

  beforeAll(async () => {
    const archive = await readArchive(ARCHIVE)
    messages = extractMessages(archive.sheets).messages
    busy = messages.filter(message => message.timestamp >= BUSY_FROM && message.timestamp < BUSY_TO)
    const started = performance.now()
    const detector = new Detector()
    for (const message of messages) detector.ingest(message)
    detectMs = performance.now() - started
    summaries = detector.summaries()
    byHash = new Map(summaries.map(summary => [uidHash(summary.uid), summary]))
  })

  test('decodes every danmaku', () => {
    expect(messages.length).toBe(89_970)
    expect(new Set(messages.map(message => message.uid)).size).toBe(5725)
  })

  test.each(Object.entries(CONFIRMED_SPAM))('judges %s spam (%s)', hash => {
    expect(byHash.get(hash)?.peak.verdict).toBe('spam')
  })

  test.each(Object.entries(NOT_SPAM))('does not judge %s spam (%s)', hash => {
    expect(byHash.get(hash)?.peak.verdict ?? 'none').not.toBe('spam')
  })

  test('every spam verdict rests on automation evidence', () => {
    const spam = summaries.filter(summary => summary.peak.verdict === 'spam')
    expect(spam.length).toBeGreaterThanOrEqual(38)
    expect(spam.length).toBeLessThanOrEqual(48)
    for (const summary of spam) {
      const kinds = summary.peak.evidence.filter(item => item.kind !== 'volume')
      expect(kinds.length).toBeGreaterThan(0)
      expect(summary.peak.repeats).toBeGreaterThanOrEqual(8)
    }
  })

  test('keeps up with a busy room', () => {
    expect(detectMs).toBeLessThan(5000)
  })

  test('catches chatterbox loops injected into real traffic without new false positives', () => {
    const peak = messages.reduce((best, message) => Math.max(best, message.timestamp), 0)
    const start = peak - 3 * 3_600_000
    const injected = [
      simulateChatterboxLoop({
        persona: { uid: 9_000_001, uname: 'inject-jitter', roomId: 25034104 },
        template: '关注主播谢谢喵',
        startAt: start,
        durationMs: 4 * 60_000,
        randomChar: '​',
      }),
      simulateChatterboxLoop({
        persona: { uid: 9_000_002, uname: 'inject-throttled', roomId: 25034104 },
        template: '主播唱首歌吧',
        startAt: start + 30 * 60_000,
        durationMs: 8 * 60_000,
      }),
      simulateChatterboxLoop({
        persona: { uid: 9_000_003, uname: 'inject-template', roomId: 25034104 },
        template: '第一卷 第一章\n反正比企谷八幡就是一副死鱼眼\n第二章 他的青春恋爱物语',
        startAt: start + 60 * 60_000,
        durationMs: 4 * 60_000,
        intervalSec: 2,
      }),
      simulateRepeatBurst({
        persona: { uid: 9_000_004, uname: 'inject-burst', roomId: 25034104 },
        phrase: '老公天下第一',
        startAt: start + 90 * 60_000,
        sends: 20,
      }),
    ]
    const detector = new Detector()
    for (const message of mergeStreams(messages, ...injected)) detector.ingest(message)
    const after = detector.summaries()
    const bots = [9_000_001, 9_000_002, 9_000_003, 9_000_004]
    for (const uid of bots) {
      expect(after.find(summary => summary.uid === uid)?.peak.verdict).toBe('spam')
    }
    const before = new Set(summaries.filter(s => s.peak.verdict === 'spam').map(s => s.uid))
    // Real uids run far past the injected ones, so exclude the bots by id rather than by range.
    const real = after.filter(summary => !bots.includes(summary.uid) && summary.peak.verdict === 'spam')
    expect(real.filter(summary => !before.has(summary.uid))).toEqual([])
  })

  test('自动融入 bots injected into real traffic are judged blend spam', () => {
    const bots = injectAlone(busy, BLEND_BOTS, simulateAutoBlend)
    for (const { name, peak } of bots) expect([name, peak?.verdict, peak?.pattern]).toEqual([name, 'spam', 'blend'])
  }, 20_000)

  test('humans chasing trends by hand stay below spam', () => {
    const chasers = injectAlone(busy, TREND_CHASERS, simulateTrendChaser)
    expect(Math.min(...chasers.map(chaser => chaser.sends))).toBeGreaterThan(100)
    expect(chasers.filter(chaser => chaser.peak?.verdict === 'spam').map(chaser => chaser.name)).toEqual([])
  }, 20_000)

  test('the hand-chasers closest to 自动融入 stay below spam', () => {
    // These seeds matched 18 of 21 and 19 of 22 line changes, the most any hand-chaser reached in calibration.
    const hot = messages.filter(message => message.timestamp >= HOT_FROM && message.timestamp < HOT_TO)
    const chasers = injectAlone(
      hot,
      {
        first: { ...TREND_CHASERS.rested, random: seededRandom(9_200_711) },
        second: { ...TREND_CHASERS.rested, random: seededRandom(9_200_713) },
      },
      simulateTrendChaser
    )
    expect(chasers.map(chaser => chaser.peak?.verdict)).toEqual(['suspect', 'suspect'])
  }, 20_000)
})
