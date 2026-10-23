import { describe, expect, test } from 'bun:test'

import { followsCrowd, type ReplaySend, type TapeEntry, TrendTape, TriggerReplay } from '@/detect/blend'
import { CrowdIndex } from '@/detect/crowd'
import { DEFAULT_DETECTOR_OPTIONS } from '@/detect/detector'
import { canonicalize } from '@/detect/normalize'

const BOT = 1
const HUMAN = 2
const CROWD = [11, 12, 13]
const DECOYS = [14, 15, 16]
const MEMES = ['老公天下第一', '主播好帅', '下次一定']
const LONG_LINES = [
  '今天的直播真的太好看了主播辛苦了早点休息明天再见',
  '大家关注一下主播点点关注不迷路谢谢各位老板的支持',
  '前方高能预警非战斗人员请迅速撤离现场注意安全',
]
const ROUND_MS = 12_000

interface Line {
  at: number
  uid: number
  text: string
  countable?: boolean
}

/** `text` from each of `uids` in turn, `stepMs` apart. */
function chant(text: string, at: number, uids = CROWD, stepMs = 200): Line[] {
  return uids.map((uid, i) => ({ at: at + i * stepMs, uid, text }))
}

function entry(line: Line): TapeEntry {
  return {
    at: line.at,
    uid: line.uid,
    text: line.text,
    key: canonicalize(line.text),
    countable: line.countable ?? true,
  }
}

function byTime(lines: Line[]): Line[] {
  return [...lines].sort((a, b) => a.at - b.at)
}

function tapeOf(lines: Line[]): TrendTape {
  const tape = new TrendTape()
  for (const line of byTime(lines)) tape.add(entry(line))
  return tape
}

/** Replays `uid` as the detector does: each message goes on the tape, then the user's own sends are judged. */
function play(room: Line[], uid = BOT): TriggerReplay {
  const tape = new TrendTape()
  const crowd = new CrowdIndex(DEFAULT_DETECTOR_OPTIONS.windowMs)
  let replay: TriggerReplay | null = null
  for (const line of byTime(room)) {
    const added = entry(line)
    tape.add(added)
    crowd.add(1, added.key, line.uid, line.at)
    if (line.uid !== uid) continue
    const send: ReplaySend = { at: line.at, text: line.text, key: added.key, others: crowd.others(1, added.key, uid) }
    if (replay) replay.observe(tape, send)
    else if (followsCrowd(send)) replay = new TriggerReplay(uid, send)
  }
  if (!replay) throw new Error('no send followed the crowd')
  return replay
}

/** `rounds` lines cycling through `lines`. */
function cycle(rounds: number, lines = MEMES): string[] {
  return Array.from({ length: rounds }, (_, r) => lines[r % lines.length] as string)
}

/** Round `r`: the crowd chants `lines[r]`, then a decoy trends 8.6–9.6 s in for any shorter cooldown to fire on. */
function trendRoom(lines: readonly string[]): Line[] {
  return lines.flatMap((text, r) => [
    ...chant(text, r * ROUND_MS),
    ...chant(`诱饵${r}`, r * ROUND_MS + 8600, DECOYS, 500),
  ])
}

/** 自动融入 on a 10 s cooldown in {@link trendRoom}: sends line `r` `lags[r]` ms after it reached 3×3. */
function tenSecondBot(lines: readonly string[], lags = [600]): Line[] {
  return lines.map((text, r) => ({ at: r * ROUND_MS + 400 + (lags[r % lags.length] as number), uid: BOT, text }))
}

describe('TrendTape.firstTrigger', () => {
  const fire = (lines: Line[]) => tapeOf(lines).firstTrigger(0, 60_000, BOT, [])

  test('needs 3 users and 3 sends of the exact text', () => {
    expect(fire(chant('爆了', 0, [11, 11, 11, 11]))).toBeNull()
    expect(fire(chant('爆了', 0, [11, 12, 11, 12]))).toBeNull()
    expect(fire([...chant('爆了', 0, [11, 12]), { at: 400, uid: 13, text: '爆了！' }])).toBeNull()
    expect(fire(chant('爆了！', 0))).toMatchObject({ text: '爆了！', key: '爆了', at: 400 })
  })

  test('a line idle over 15 s starts over', () => {
    const resumed = (gap: number) => fire([...chant('爆了', 0, [11, 12]), ...chant('爆了', 200 + gap, [13, 11, 12])])
    expect(resumed(15_000)?.at).toBe(15_200)
    expect(resumed(15_001)?.at).toBe(15_601)
  })

  test('skips the user itself', () => {
    const tape = tapeOf([...chant('爆了', 0), ...chant('爆了', 1000, [14])])
    expect(tape.firstTrigger(0, 60_000, BOT, [])?.at).toBe(400)
    expect(tape.firstTrigger(0, 60_000, 13, [])?.at).toBe(1000)
  })

  test('skips avoided lines', () => {
    const tape = tapeOf([...chant('爆了', 0), ...chant('无语', 1000)])
    expect(tape.firstTrigger(0, 60_000, BOT, ['爆了'])).toMatchObject({ text: '无语', key: '无语', at: 1400 })
  })

  test('skips stickers and @-replies', () => {
    const sticker = { at: 400, uid: 13, text: '爆了', countable: false }
    expect(fire([...chant('爆了', 0, [11, 12]), sticker, ...chant('爆了', 1000, [14])])?.at).toBe(1000)
  })

  test('counts from start (inclusive) until end (exclusive)', () => {
    const tape = tapeOf(chant('爆了', 0))
    expect(tape.firstTrigger(0, 401, BOT, [])?.at).toBe(400)
    expect(tape.firstTrigger(0, 400, BOT, [])).toBeNull()
    expect(tape.firstTrigger(100, 60_000, BOT, [])).toBeNull()
  })

  test('the first line to complete wins', () => {
    const lines = [
      ...chant('爆了', 0, [11, 12]),
      ...chant('无语', 300, [13, 14, 15], 100),
      ...chant('爆了', 1000, [16]),
    ]
    expect(fire(lines)).toMatchObject({ text: '无语', key: '无语', at: 500 })
  })

  test('a late message is kept at the newest time', () => {
    const tape = new TrendTape()
    tape.add(entry({ at: 1000, uid: 11, text: '爆了' }))
    tape.add(entry({ at: 500, uid: 12, text: '爆了' }))
    expect(tape.lastAt).toBe(1000)
    tape.add(entry({ at: 1200, uid: 13, text: '爆了' }))
    expect(tape.firstTrigger(1000, 60_000, BOT, [])?.at).toBe(1200)
  })
})

describe('TrendTape.cpm', () => {
  test("chatterbox's chats per minute over the last 30 s, never counting its own user", () => {
    expect(new TrendTape().cpm(0, BOT)).toBe(0)
    const tape = tapeOf(Array.from({ length: 10 }, (_, i) => ({ at: i * 1000, uid: 11 + i, text: `闲聊${i}` })))
    expect(tape.cpm(9000, BOT)).toBe(67) // 10 over 9 s
    expect(tape.cpm(9000, 11)).toBe(68) // 9 over 8 s: the span starts at the oldest message from someone else
    expect(tape.cpm(4000, BOT)).toBe(75) // later messages don't count
    expect(tape.cpm(500, BOT)).toBe(30) // extrapolated over at least 2 s
    expect(tape.cpm(35_000, BOT)).toBe(10) // 5 left in the window
    expect(tape.cpm(40_000, BOT)).toBe(0)
  })
})

describe('followsCrowd', () => {
  const send = (key: string, others: number): ReplaySend => ({ at: 0, text: key, key, others })

  test('needs 2 other senders unless the line is long enough to have been cut', () => {
    const long = '今天的直播真的太好看了主播辛苦了'
    expect(followsCrowd(send('爆了', 2))).toBe(true)
    expect(followsCrowd(send('爆了', 1))).toBe(false)
    expect(followsCrowd(send(long, 0))).toBe(true)
    expect(followsCrowd(send(long.slice(0, 15), 1))).toBe(false)
  })
})

describe('TriggerReplay', () => {
  test('a 10 s cooldown bot is fit with its setting and delay', () => {
    const lines = cycle(13)
    const replay = play([...trendRoom(lines), ...tenSecondBot(lines, [500, 650, 600, 700, 550])])
    const fit = replay.fit(12)
    expect(fit).toMatchObject({ hits: 12, changes: 12, cooldownMs: 10_000, avoid: false })
    expect(fit?.lagMs).toBeGreaterThanOrEqual(550)
    expect(fit?.lagMs).toBeLessThanOrEqual(650)
    expect(fit?.keys).toEqual(new Set(MEMES))
    expect(replay.fit(13)).toBeNull()
  })

  test('the same lines at off times get no hits', () => {
    const lines = cycle(13)
    // Joins before a line completes, or copies it 3–5 s late.
    const offsets = [300, 3400, 4400, 5400]
    const human = lines.map((text, r) => ({
      at: r * ROUND_MS + (offsets[r % offsets.length] as number),
      uid: HUMAN,
      text,
    }))
    expect(play([...trendRoom(lines), ...human], HUMAN).fit(1)).toBeNull()
  })

  test('an avoid-repeat bot is fit with avoid on', () => {
    const lines = Array.from({ length: 13 }, (_, r) => `新梗${r}`)
    // After each cooldown the crowd revives the bot's line from two rounds back; 避免重复 skips its last 3.
    const echoes = lines.flatMap((_, r) => chant(lines[Math.max(0, r - 2)] as string, r * ROUND_MS + 10_500))
    const fit = play([...trendRoom(lines), ...echoes, ...tenSecondBot(lines)]).fit(1)
    expect(fit).toMatchObject({ hits: 12, changes: 12, cooldownMs: 10_000, avoid: true })
  })

  test('the send after a resend Bilibili dropped is still predicted', () => {
    // 2 s cooldown: each line trends again right after it, so 自动融入 fires again, but Bilibili drops the same line
    // inside 5 s. Its cooldown restarted all the same: the decoy trends inside it.
    const room = Array.from({ length: 13 }, (_, r) => [
      ...chant(`梗${r}`, r * 5000),
      { at: r * 5000 + 1000, uid: BOT, text: `梗${r}` },
      ...chant(`梗${r}`, r * 5000 + 2500, CROWD, 100),
      ...chant(`诱饵${r}`, r * 5000 + 4400, DECOYS, 100),
    ]).flat()
    expect(play(room).fit(1)).toMatchObject({ hits: 12, changes: 12, cooldownMs: 2000, avoid: false })
  })

  test('a resend Bilibili would have let through is not excused', () => {
    // The line trends again 5.6 s after the send, where a 2 s bot's resend would show. Only a 7 s cooldown, waking
    // between the decoy and the next line, explains the sends.
    const room = Array.from({ length: 13 }, (_, r) => [
      ...chant(`梗${r}`, r * 8000),
      { at: r * 8000 + 1000, uid: BOT, text: `梗${r}` },
      ...chant(`梗${r}`, r * 8000 + 5600),
      ...chant(`诱饵${r}`, r * 8000 + 6500, DECOYS),
    ]).flat()
    expect(play(room).fit(1)).toMatchObject({ hits: 12, changes: 12, cooldownMs: 7000 })
  })

  test('a send cut at the length limit still matches its line', () => {
    const lines = cycle(13, LONG_LINES)
    const cut = tenSecondBot(lines).map(send => ({ ...send, text: send.text.slice(0, 20) }))
    expect(play([...trendRoom(lines), ...cut]).fit(1)).toMatchObject({ hits: 12, changes: 12, cooldownMs: 10_000 })
  })

  test('manual sends are not counted and leave the cooldown alone', () => {
    const lines = cycle(13)
    const room = [...trendRoom(lines), ...tenSecondBot(lines)]
    // Typed mid-cooldown: had they restarted it, the next trend would fall inside.
    const manual = lines.map((_, r) => ({ at: r * ROUND_MS + 5000, uid: BOT, text: `手打${r}` }))
    const fit = play(room).fit(1)
    expect(fit).toMatchObject({ hits: 12, changes: 12, cooldownMs: 10_000 })
    expect(play([...room, ...manual]).fit(1)).toEqual(fit)
  })

  test('sending the same line again is not a change', () => {
    // 老公天下第一, 主播好帅, 主播好帅, 下次一定, 下次一定, …: each line trends twice, a cooldown apart
    const lines = Array.from({ length: 13 }, (_, r) => MEMES[Math.ceil(r / 2) % MEMES.length] as string)
    const fit = play([...trendRoom(lines), ...tenSecondBot(lines)]).fit(1)
    expect(fit).toMatchObject({ hits: 6, changes: 6, cooldownMs: 10_000 })
  })

  test('forget drops judged sends', () => {
    const lines = cycle(13)
    const replay = play([...trendRoom(lines), ...tenSecondBot(lines)])
    replay.forget(7 * ROUND_MS)
    expect(replay.fit(1)).toMatchObject({ hits: 6, changes: 6, cooldownMs: 10_000 })
    replay.forget(13 * ROUND_MS)
    expect(replay.fit(1)).toBeNull()
  })
})
