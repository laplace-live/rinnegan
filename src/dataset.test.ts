/**
 * Regression tests against real LAPLACE Chat archives in `references/` (gitignored; skipped when absent).
 * Users are referenced by salted uid hashes so the repository never lists who was judged.
 */

import { beforeAll, describe, expect, test } from 'bun:test'

import type { UserSummary } from '@/detect/detector'
import type { ChatMessage } from '@/types'

import { Detector } from '@/detect/detector'
import { extractMessages, readArchive } from '@/sources/archive'
import { mergeStreams, simulateChatterboxLoop, simulateRepeatBurst } from '@/testing/simulate'

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
  c74578877fac: 'memes rotated on the 1.3 s tick (5.2 / 6.5 s gaps)',
  f2a73aaf1290: '? resent every 10.4 s (8 ticks) for minutes',
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

describe.skipIf(!available)(`real archive ${ARCHIVE}`, () => {
  let messages: ChatMessage[] = []
  let summaries: UserSummary[] = []
  let byHash = new Map<string, UserSummary>()
  let detectMs = 0

  beforeAll(async () => {
    const archive = await readArchive(ARCHIVE)
    messages = extractMessages(archive.sheets).messages
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
    expect(spam.length).toBeGreaterThanOrEqual(30)
    expect(spam.length).toBeLessThanOrEqual(42)
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
    for (const uid of [9_000_001, 9_000_002, 9_000_003, 9_000_004]) {
      expect(after.find(summary => summary.uid === uid)?.peak.verdict).toBe('spam')
    }
    const before = new Set(summaries.filter(s => s.peak.verdict === 'spam').map(s => s.uid))
    const real = after.filter(summary => summary.uid < 9_000_000 && summary.peak.verdict === 'spam')
    expect(real.filter(summary => !before.has(summary.uid))).toEqual([])
  })
})
