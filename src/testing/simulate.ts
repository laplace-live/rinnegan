/**
 * Synthetic danmaku streams for accuracy tests. The spam side ports LAPLACE Chatterbox's send path
 * (apps/chatterbox/src/lib/{utils,loop,send-queue}.ts) and models Bilibili's ~5 s duplicate filter; the human side
 * reproduces behaviours seen in real archives that must never be judged a 独轮车.
 */

import type { ChatMessage } from '@/types'

import { graphemes } from '@/detect/normalize'
import { compareMessages } from '@/sources/archive'

/** Deterministic PRNG (mulberry32) so failures reproduce. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Chatterbox's invisible-char presets plus the U+E0020 tag char seen in the wild. */
export const INVISIBLE_PRESETS = ['­', '​', '‌', '‍', '⁠', '﻿', '\u{E0020}'] as const

/** Port of chatterbox `allowedInsertIndices`: never inside a balanced `[...]` emote bracket. */
function allowedInsertIndices(chars: string[]): number[] {
  const forbidden = new Set<number>()
  let openAt = -1
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '[') openAt = i
    else if (chars[i] === ']' && openAt !== -1) {
      for (let k = openAt + 1; k <= i; k++) forbidden.add(k)
      openAt = -1
    }
  }
  const allowed: number[] = []
  for (let k = 0; k <= chars.length; k++) if (!forbidden.has(k)) allowed.push(k)
  return allowed
}

/** Port of chatterbox `insertRandomChar`, including the `avoidIndex` used by 路怒 mode. */
export function insertRandomChar(
  text: string,
  char: string,
  random: () => number,
  avoidIndex?: number
): { text: string; index: number } {
  const chars = graphemes(text)
  let allowed = allowedInsertIndices(chars)
  if (allowed.length === 0) allowed = [chars.length]
  if (avoidIndex !== undefined && allowed.length > 1) {
    const pruned = allowed.filter(k => k !== avoidIndex)
    if (pruned.length > 0) allowed = pruned
  }
  const index = allowed[Math.floor(random() * allowed.length)] ?? chars.length
  chars.splice(index, 0, char)
  return { text: chars.join(''), index }
}

/** Port of chatterbox `trimText`: grapheme-safe split at `maxLength`. */
export function trimText(text: string, maxLength: number): string[] {
  const chars = graphemes(text)
  if (chars.length <= maxLength) return [text]
  const parts: string[] = []
  for (let i = 0; i < chars.length; i += maxLength) parts.push(chars.slice(i, i + maxLength).join(''))
  return parts
}

/** Port of chatterbox `processMessages`: per line, optional random char, then split at `maxLength`. */
export function processMessages(text: string, maxLength: number, random: () => number, randomChar?: string): string[] {
  return text
    .split('\n')
    .flatMap(line => {
      let l = line
      if (randomChar && l.trim()) l = insertRandomChar(l, randomChar, random).text
      return trimText(l, maxLength)
    })
    .filter(line => line.trim())
}

function standardNormal(random: () => number): number {
  const u1 = random() || 1e-9
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * random())
}

/** Port of chatterbox `resolveSendDelayMs`: σ = 20% of the interval, clamped to ±2σ. */
export function resolveSendDelayMs(intervalSec: number, randomInterval: boolean, random: () => number): number {
  const base = intervalSec * 1000
  if (!randomInterval) return base
  const sample = Math.max(-2, Math.min(2, standardNormal(random)))
  return Math.max(0, Math.round(base + sample * base * 0.2))
}

/** Identity and room for generated messages. */
export interface Persona {
  uid: number
  uname: string
  roomId?: number
  guardType?: number
}

/** Chatterbox's send queue spaces sends at least this far apart, ms */
const SEND_QUEUE_GAP_MS = 1010

let nextId = 1

function makeMessage(persona: Persona, text: string, timestamp: number, isEmote = false): ChatMessage {
  return {
    id: `sim-${nextId++}`,
    roomId: persona.roomId ?? 1,
    uid: persona.uid,
    uname: persona.uname,
    text,
    timestamp: Math.round(timestamp),
    userType: 0,
    guardType: persona.guardType ?? 0,
    isEmote,
    medalLevel: 0,
    isReply: false,
  }
}

/**
 * Bilibili accepts a send unless it repeats the user's last accepted text within ~5 s (the filter
 * chatterbox's 随机字符 exists to dodge). Real archives only contain accepted sends.
 */
export class BilibiliFilter {
  readonly #last = new Map<number, { text: string; at: number }>()
  readonly windowMs: number

  constructor(windowMs = 5000) {
    this.windowMs = windowMs
  }

  accept(uid: number, text: string, at: number): boolean {
    const last = this.#last.get(uid)
    if (last && last.text === text && at - last.at < this.windowMs) return false
    this.#last.set(uid, { text, at })
    return true
  }
}

export interface LoopOptions {
  persona: Persona
  /** Template; one line per entry, chatterbox splits on `\n` too */
  template: string
  startAt: number
  durationMs: number
  /** `msgSendInterval`, seconds (chatterbox default 1) */
  intervalSec?: number
  randomInterval?: boolean
  /** Insert this char each send (随机字符) */
  randomChar?: string
  /** chatterbox `maxLength` (default 38) */
  maxLength?: number
  /** Per-line rewrite, e.g. a replacement rule or an LLM polish */
  rewrite?: (line: string, round: number, random: () => number) => string
  random?: () => number
  filter?: BilibiliFilter
  /** Range the user's typical request latency is drawn from, ms; each send adds ±40 ms jitter */
  latencyMs?: [number, number]
}

/** Chatterbox 独轮车: loop the template through the 1010 ms send queue, keeping only sends Bilibili accepts. */
export function simulateChatterboxLoop(options: LoopOptions): ChatMessage[] {
  const random = options.random ?? seededRandom(options.persona.uid)
  const filter = options.filter ?? new BilibiliFilter()
  const interval = options.intervalSec ?? 1
  const maxLength = options.maxLength ?? 38
  const [latencyMin, latencyMax] = options.latencyMs ?? [180, 420]
  const baseLatency = latencyMin + random() * (latencyMax - latencyMin)
  const end = options.startAt + options.durationMs
  const out: ChatMessage[] = []
  let now = options.startAt
  let lastCompleted = 0
  let round = 0
  while (now < end) {
    const lines = options.template.split('\n').filter(line => line.trim())
    for (const rawLine of lines) {
      const line = options.rewrite ? options.rewrite(rawLine, round, random) : rawLine
      for (const chunk of processMessages(line, maxLength, random, options.randomChar)) {
        if (now >= end) return out
        if (lastCompleted > 0 && now - lastCompleted < SEND_QUEUE_GAP_MS) now = lastCompleted + SEND_QUEUE_GAP_MS
        const accepted = now + baseLatency + (random() - 0.5) * 80
        if (filter.accept(options.persona.uid, chunk, accepted)) out.push(makeMessage(options.persona, chunk, accepted))
        lastCompleted = accepted
        now = accepted + resolveSendDelayMs(interval, options.randomInterval ?? false, random)
      }
    }
    round++
  }
  return out
}

/** Burst tool seen in real archives: the phrase repeated a random number of times per send, ~1 s apart. */
export function simulateRepeatBurst(options: {
  persona: Persona
  phrase: string
  startAt: number
  sends: number
  maxLength?: number
  random?: () => number
}): ChatMessage[] {
  const random = options.random ?? seededRandom(options.persona.uid)
  const maxLength = options.maxLength ?? 40
  const out: ChatMessage[] = []
  let at = options.startAt
  for (let i = 0; i < options.sends; i++) {
    const copies = 1 + Math.floor(random() * 10)
    const text = graphemes(options.phrase.repeat(copies)).slice(0, maxLength).join('')
    out.push(makeMessage(options.persona, text, at))
    at += 800 + random() * 1200
  }
  return out
}

/** A fixed `setInterval` tool (e.g. Bilibili-Live-Danmaku-Assistant) clicking send every `intervalMs`. */
export function simulateFixedTimer(options: {
  persona: Persona
  texts: string[]
  startAt: number
  sends: number
  intervalMs: number
  random?: () => number
}): ChatMessage[] {
  const random = options.random ?? seededRandom(options.persona.uid)
  const out: ChatMessage[] = []
  for (let i = 0; i < options.sends; i++) {
    const text = options.texts[i % options.texts.length] as string
    out.push(makeMessage(options.persona, text, options.startAt + i * options.intervalMs + 40 + random() * 60))
  }
  return out
}

/** Copy Ninja mirror: re-sends each master message 2–5 s later (chatterbox `planCopy` defaults). */
export function simulateCopyNinja(master: ChatMessage[], persona: Persona, random?: () => number): ChatMessage[] {
  const rand = random ?? seededRandom(persona.uid)
  const filter = new BilibiliFilter()
  const out: ChatMessage[] = []
  let lastPlanned = 0
  for (const message of master) {
    lastPlanned = Math.max(message.timestamp + 2000 + rand() * 3000, lastPlanned + SEND_QUEUE_GAP_MS)
    if (filter.accept(persona.uid, message.text, lastPlanned)) out.push(makeMessage(persona, message.text, lastPlanned))
  }
  return out
}

/** A fan chanting a line by hand: human gaps (5 s+ to clear the filter), small typing variations. */
export function simulateHumanChant(options: {
  persona: Persona
  line: string
  startAt: number
  sends: number
  random?: () => number
}): ChatMessage[] {
  const random = options.random ?? seededRandom(options.persona.uid)
  const decorations = ['', '', '', '！', '!', '！！', '~']
  const out: ChatMessage[] = []
  let at = options.startAt
  for (let i = 0; i < options.sends; i++) {
    const text = options.line + (decorations[Math.floor(random() * decorations.length)] as string)
    out.push(makeMessage(options.persona, text, at))
    // Log-normal reaction gaps around ~9 s; a human retrying past the duplicate filter lands anywhere after 5 s.
    at += Math.max(5000 + random() * 2500, Math.exp(Math.log(9000) + 0.55 * standardNormal(random)))
  }
  return out
}

/** A viewer chatting normally. */
export function simulateHumanChat(options: {
  persona: Persona
  lines: string[]
  startAt: number
  sends: number
  random?: () => number
}): ChatMessage[] {
  const random = options.random ?? seededRandom(options.persona.uid)
  const out: ChatMessage[] = []
  let at = options.startAt
  for (let i = 0; i < options.sends; i++) {
    out.push(makeMessage(options.persona, options.lines[Math.floor(random() * options.lines.length)] as string, at))
    at += Math.exp(Math.log(20_000) + 0.8 * standardNormal(random))
  }
  return out
}

/** A viewer re-sending (+1) other people's messages verbatim, invisible chars included. */
export function simulatePlusOne(
  source: ChatMessage[],
  persona: Persona,
  every: number,
  random?: () => number
): ChatMessage[] {
  const rand = random ?? seededRandom(persona.uid)
  const out: ChatMessage[] = []
  let lastAt = 0
  for (let i = 0; i < source.length; i += every) {
    const message = source[i] as ChatMessage
    const at = Math.max(message.timestamp + 1500 + rand() * 6000, lastAt + 5000 + rand() * 2500)
    out.push(makeMessage(persona, message.text, at))
    lastAt = at
  }
  return out
}

/** Fan-medal check-in bot: ten different kaomoji on a fixed timer, once. */
export function simulateCheckIn(persona: Persona, startAt: number): ChatMessage[] {
  const kaomoji = [
    '(°∀°)ﾉ',
    '╮(￣▽￣)╭',
    '_(:3」∠)_',
    '(^・ω・^ )',
    '(●￣(ｴ)￣●)',
    '(⌒▽⌒)',
    '（￣▽￣）',
    '(=・ω・=)',
    '(｀・ω・´)',
    '←◡←',
  ]
  return kaomoji.map((text, i) => makeMessage(persona, text, startAt + i * 5180))
}

/** Clicking four neighbouring stickers across the panel, three sweeps. */
export function simulateStickerSweep(persona: Persona, startAt: number, random?: () => number): ChatMessage[] {
  const rand = random ?? seededRandom(persona.uid)
  const stickers = ['无语', '典', '对不起', '抱抱']
  const out: ChatMessage[] = []
  let at = startAt
  for (let sweep = 0; sweep < 3; sweep++) {
    for (const sticker of stickers) {
      out.push(makeMessage(persona, sticker, at, true))
      at += 1800 + rand() * 400
    }
  }
  return out
}

/** Chatterbox 自动融入 settings (apps/chatterbox/src/lib/store.ts); omitted ones keep the shipped defaults. */
export interface AutoBlendOptions {
  persona: Persona
  /** `autoBlendUniqueUsers` */
  uniqueUsers?: number
  /** `autoBlendMinOccurrences` */
  minOccurrences?: number
  /** `autoBlendWindowSec`, ms */
  windowMs?: number
  /** `autoBlendCooldownSec`, ms */
  cooldownMs?: number
  /** `autoBlendCooldownAuto`: 300 / CPM seconds, clamped to 2–60 */
  cooldownAuto?: boolean
  /** `autoBlendAvoidRepeat`, against the last 3 triggers */
  avoidRepeat?: boolean
  /** `autoBlendRandomDropPercent` with `autoBlendRandomDrop` on */
  dropPercent?: number
  /** Insert this char each send (随机字符) */
  randomChar?: string
  maxLength?: number
  startAt?: number
  endAt?: number
  /** Range the bot's trigger-to-accepted-send latency is drawn from; each send adds ±`jitterMs` */
  latencyMs?: [number, number]
  jitterMs?: number
  random?: () => number
}

/** Port of chatterbox 自动融入 (auto-blend.ts `recordDanmaku` / `triggerSend`) watching `room`; its accepted sends. */
export function simulateAutoBlend(room: readonly ChatMessage[], options: AutoBlendOptions): ChatMessage[] {
  const { persona } = options
  const random = options.random ?? seededRandom(persona.uid)
  const filter = new BilibiliFilter()
  const users = options.uniqueUsers ?? 3
  const sends = options.minOccurrences ?? 3
  const windowMs = options.windowMs ?? 15_000
  const maxLength = options.maxLength ?? 38
  const [latencyMin, latencyMax] = options.latencyMs ?? [300, 900]
  const baseLatency = latencyMin + random() * (latencyMax - latencyMin)
  const jitter = options.jitterMs ?? 120
  const counters = new Map<string, { uids: Set<number>; total: number; lastSeenAt: number }>()
  const timestamps: number[] = []
  let recent: string[] = []
  let cooldownUntil = 0
  let lastSent = 0
  const out: ChatMessage[] = []
  for (const message of room) {
    const now = message.timestamp
    if (message.uid === persona.uid || (options.startAt !== undefined && now < options.startAt)) continue
    if (options.endAt !== undefined && now > options.endAt) break
    timestamps.push(now)
    if (now < cooldownUntil) continue
    const text = message.text.trim()
    if (!text || message.isEmote || message.isReply) continue
    if (options.avoidRepeat && recent.includes(text)) continue
    for (const [line, counter] of counters) if (now - counter.lastSeenAt > windowMs) counters.delete(line)
    let counter = counters.get(text)
    if (!counter) {
      counter = { uids: new Set(), total: 0, lastSeenAt: now }
      counters.set(text, counter)
    }
    counter.total++
    counter.lastSeenAt = now
    counter.uids.add(message.uid)
    if (counter.uids.size < users || counter.total < sends) continue
    recent = [...recent, text].slice(-3)
    if (options.dropPercent && random() * 100 < options.dropPercent) {
      counters.delete(text)
      continue
    }
    let cooldownMs = options.cooldownMs ?? 10_000
    if (options.cooldownAuto) {
      while (timestamps.length > 0 && (timestamps[0] as number) < now - 30_000) timestamps.shift()
      const span = Math.max(2000, Math.min(now - (timestamps[0] as number), 30_000))
      const cpm = Math.round((timestamps.length * 60_000) / span)
      cooldownMs = (cpm <= 0 ? 60 : Math.min(60, Math.max(2, Math.round(300 / cpm)))) * 1000
    }
    cooldownUntil = now + cooldownMs
    counters.clear()
    let line = options.randomChar ? insertRandomChar(text, options.randomChar, random).text : text
    line = trimText(line, maxLength)[0] ?? line
    const at = Math.max(now + baseLatency + (random() - 0.5) * 2 * jitter, lastSent + SEND_QUEUE_GAP_MS)
    if (!filter.accept(persona.uid, line, at)) continue
    lastSent = at
    out.push(makeMessage({ roomId: message.roomId, ...persona }, line, at))
  }
  return out
}

export interface TrendChaserOptions {
  persona: Persona
  /** Reaction delay range, ms (log-uniform) */
  reactMs?: [number, number]
  /** Rest after each send, ms (uniform) */
  restMs?: [number, number]
  /** Share of fresh trends joined */
  chance?: number
  startAt?: number
  endAt?: number
  random?: () => number
}

/** Viewers doing 自动融入 by hand; `rested` rests about as long as its stock 10 s cooldown. */
export const TREND_CHASERS = {
  fast: { reactMs: [600, 2500], restMs: [3000, 12_000], chance: 0.7 },
  rested: { reactMs: [800, 3000], restMs: [9500, 11_500], chance: 0.9 },
  quick: { reactMs: [500, 2000], restMs: [4000, 6000], chance: 1 },
} satisfies Record<string, Omit<TrendChaserOptions, 'persona'>>

/** A viewer doing 自动融入 by hand: joins a line once 3 people sent it, after a human delay, then rests. */
export function simulateTrendChaser(room: readonly ChatMessage[], options: TrendChaserOptions): ChatMessage[] {
  const { persona } = options
  const random = options.random ?? seededRandom(persona.uid)
  const [reactMin, reactMax] = options.reactMs ?? [800, 3000]
  const [restMin, restMax] = options.restMs ?? [4000, 12_000]
  const chance = options.chance ?? 0.8
  const runs = new Map<string, { uids: Set<number>; lastAt: number; joined: boolean }>()
  const out: ChatMessage[] = []
  let busyUntil = 0
  for (const message of room) {
    if (options.startAt !== undefined && message.timestamp < options.startAt) continue
    if (options.endAt !== undefined && message.timestamp > options.endAt) break
    const text = message.text.trim()
    if (!text || message.isEmote || message.uid === persona.uid) continue
    let run = runs.get(text)
    if (!run || message.timestamp - run.lastAt > 15_000) {
      run = { uids: new Set(), lastAt: message.timestamp, joined: false }
      runs.set(text, run)
    }
    run.lastAt = message.timestamp
    run.uids.add(message.uid)
    if (run.joined || run.uids.size < 3 || message.timestamp < busyUntil) continue
    run.joined = true
    if (random() > chance) continue
    const react = Math.exp(Math.log(reactMin) + random() * (Math.log(reactMax) - Math.log(reactMin)))
    const at = message.timestamp + react
    out.push(makeMessage({ roomId: message.roomId, ...persona }, text, at))
    busyUntil = at + restMin + random() * (restMax - restMin)
  }
  return out
}

/**
 * A busy room chanting by hand: `size` viewers at human gaps, most sends picking one of the few `lines` in fashion
 * (the fashion moves every `phaseMs`), the rest chatting from the whole list.
 */
export function simulateCrowd(options: {
  uidBase: number
  size: number
  lines: string[]
  startAt: number
  durationMs: number
  roomId?: number
  phaseMs?: number
  random?: () => number
}): ChatMessage[] {
  const random = options.random ?? seededRandom(options.uidBase)
  const phaseMs = options.phaseMs ?? 40_000
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T
  const end = options.startAt + options.durationMs
  const phases: string[][] = []
  for (let at = options.startAt; at < end; at += phaseMs) phases.push([pick(options.lines), pick(options.lines)])
  const out: ChatMessage[] = []
  for (let i = 0; i < options.size; i++) {
    const persona = { uid: options.uidBase + i, uname: `crowd${i}`, roomId: options.roomId ?? 1 }
    let at = options.startAt + random() * 20_000
    while (at < end) {
      const hot = phases[Math.floor((at - options.startAt) / phaseMs)] as string[]
      out.push(makeMessage(persona, random() < 0.75 ? pick(hot) : pick(options.lines), at))
      at += Math.max(3000, Math.exp(Math.log(14_000) + 0.6 * standardNormal(random)))
    }
  }
  return mergeStreams(out)
}

/** Merge streams into one time-ordered feed. */
export function mergeStreams(...streams: ChatMessage[][]): ChatMessage[] {
  return streams.flat().sort(compareMessages)
}
