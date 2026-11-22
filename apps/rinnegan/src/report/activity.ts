import type { ChatMessage, Episode, TalliedSend } from '@laplace.live/rinnegan-sdk'
import { median } from '@laplace.live/rinnegan-sdk'

import type { ReportUser } from '@/report/report'

import { userKey } from '@/report/report'
import { afterMidnight, hourMinute, monthDay } from '@/util/console'

/** Context shown around each flagged stretch on a timeline */
export const TIMELINE_CONTEXT_MS = 30 * 60_000
/** Periods start and end on quarter hours */
const SNAP_MS = 15 * 60_000
const MIN_PERIOD_MS = 60_000
const MAX_BUCKETS = 720
const BUCKET_MINUTES = [1, 2, 5, 10, 15, 30, 60, 120, 360, 720, 1440]
const TICK_MINUTES = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440]
const MAX_TICKS = 9
const WIDEST_GAP_SCALE = { max: 120, binMs: 2000 }
/** Histogram range (s) and bin width; the first range covering twice the median gap wins */
const GAP_SCALES = [
  { max: 10, binMs: 200 },
  { max: 15, binMs: 250 },
  { max: 20, binMs: 250 },
  { max: 30, binMs: 500 },
  { max: 60, binMs: 1000 },
  WIDEST_GAP_SCALE,
]
const MIN_GAPS = 8

/** One flagged user's row on a {@link Period}. */
export interface Lane {
  roomId: number
  uid: number
  uname: string
  /** Unix ms of the user's danmaku in the period */
  sends: number[]
  /** Flagged stretches overlapping the period */
  episodes: Episode[]
}

/** A stretch of the archive around flagged activity, drawn as one timeline. */
export interface Period {
  /** Unix ms */
  from: number
  to: number
  bucketMs: number
  /** Danmaku in the whole room per `bucketMs`, from `from` */
  counts: number[]
  /** Axis ticks on local-time boundaries */
  ticks: { at: number; label: string }[]
  lanes: Lane[]
}

/** Gaps between one user's consecutive danmaku, binned. */
export interface GapHistogram {
  /** Range, seconds */
  max: number
  binMs: number
  counts: number[]
  /** Gaps of `max` or longer */
  over: number
  /** Narrowest range holding half the gaps, ms: how closely the user keeps to one pace */
  half: [number, number]
}

/** Roles and medal from a user's danmaku. */
export interface Badges {
  userType: number
  guardType: number
  medalName: string
  medalLevel: number
}

/** Danmaku the 手动融入 tally leaves out: lone short reactions such as 「？」, stickers and @-replies. */
export type LeftOutKind = 'short' | 'emote' | 'reply'

/** What the 手动融入 tally counted a text danmaku as: a chant, a +1 or a line of their own. */
export type CountedKind = 'chant' | 'plus-one' | 'own'

/** How the 手动融入 tally read a danmaku: what it counted it as, or the kind it leaves out. */
export type DanmakuKind = CountedKind | LeftOutKind

/** One user's danmaku counted by {@link DanmakuKind}, for the bar on their card. */
export interface DanmakuMix {
  counts: Record<DanmakuKind, number>
  /** Viewers whose lines they +1'd */
  sources: number
  /** Median delay of their +1s after the line they copied, ms; null without +1s */
  lagMs: number | null
}

/** What the HTML report draws beyond the JSON report, gathered from the judged danmaku. */
export interface Activity {
  /** Streamer names by room, from their own danmaku */
  hosts: Map<number, string>
  /** Oldest first */
  periods: Period[]
  /** By {@link userKey}; absent when a user has too few gaps */
  gaps: Map<string, GapHistogram>
  /** As of each flagged user's peak, or a 手动融入 viewer's last danmaku, by {@link userKey} */
  badges: Map<string, Badges>
  /** Every danmaku of each flagged user and 手动融入 viewer, oldest first, by {@link userKey} */
  danmaku: Map<string, ChatMessage[]>
  /**
   * How the 手动融入 tally counted each of those danmaku, for users given a history; stickers, @-replies and lone short
   * reactions have no entry
   */
  tallies: Map<string, Map<ChatMessage, TalliedSend>>
  /** Each tallied user's danmaku by kind, by {@link userKey} */
  mixes: Map<string, DanmakuMix>
}

/**
 * Timelines, send-gap histograms, badges and danmaku for the flagged `users`, and badges and danmaku for the 手动融入
 * `copiers`; `messages` sorted oldest first. `histories`: tallied sends by {@link userKey}, which tag those danmaku.
 */
export function buildActivity(
  messages: readonly ChatMessage[],
  users: readonly ReportUser[],
  copiers: readonly { roomId: number; uid: number }[] = [],
  histories: ReadonlyMap<string, readonly TalliedSend[]> = new Map()
): Activity {
  const flagged = new Map(users.map(user => [userKey(user), user]))
  const marked = new Set(copiers.map(userKey))
  const danmaku = new Map<string, ChatMessage[]>()
  const badges = new Map<string, Badges>()
  const hosts = new Map<number, string>()
  for (const message of messages) {
    if (message.userType === 100 && message.uname) hosts.set(message.roomId, message.uname)
    const key = userKey(message)
    const user = flagged.get(key)
    if (!user && !marked.has(key)) continue
    const own = danmaku.get(key)
    if (own) own.push(message)
    else danmaku.set(key, [message])
    if (!user || message.timestamp <= user.peakAt || !badges.has(key)) badges.set(key, badgesOf(message))
  }
  const sends = new Map([...danmaku].map(([key, own]) => [key, own.map(message => message.timestamp)]))

  const gaps = new Map<string, GapHistogram>()
  for (const user of users) {
    const histogram = gapHistogram(sends.get(userKey(user)) ?? [])
    if (histogram) gaps.set(userKey(user), histogram)
  }
  const tallies = new Map<string, Map<ChatMessage, TalliedSend>>()
  const mixes = new Map<string, DanmakuMix>()
  for (const [key, own] of danmaku) {
    const history = histories.get(key)
    if (!history) continue
    const tags = tag(own, history)
    tallies.set(key, tags)
    mixes.set(key, mixOf(own, tags))
  }
  return { hosts, periods: periodsOf(messages, users, sends), gaps, badges, danmaku, tallies, mixes }
}

/** What a send the tally counted was. */
export function sendKind(send: TalliedSend): CountedKind {
  return send.senders === 0 ? 'own' : 'from' in send ? 'plus-one' : 'chant'
}

/** What a danmaku the tally left out is; any text the tally passes over is a lone short reaction. */
export function leftOutKind(message: ChatMessage): LeftOutKind {
  return message.isEmote ? 'emote' : message.isReply ? 'reply' : 'short'
}

function mixOf(sent: readonly ChatMessage[], tags: ReadonlyMap<ChatMessage, TalliedSend>): DanmakuMix {
  const counts: Record<DanmakuKind, number> = { chant: 0, 'plus-one': 0, own: 0, short: 0, emote: 0, reply: 0 }
  const sources = new Set<string>()
  const lags: number[] = []
  for (const message of sent) {
    const send = tags.get(message)
    counts[send ? sendKind(send) : leftOutKind(message)]++
    if (send && 'from' in send) {
      sources.add(send.from)
      lags.push(send.lagMs)
    }
  }
  return { counts, sources: sources.size, lagMs: lags.length > 0 ? median(lags) : null }
}

/** Pair each danmaku with its tally entry: both run oldest first, and the tally skips some danmaku. */
function tag(sent: readonly ChatMessage[], history: readonly TalliedSend[]): Map<ChatMessage, TalliedSend> {
  const tags = new Map<ChatMessage, TalliedSend>()
  let next = 0
  for (const message of sent) {
    // An entry older than this danmaku matched nothing; the tally never times a send before its danmaku
    while (next < history.length && (history[next] as TalliedSend).at < message.timestamp) next++
    const send = history[next]
    if (send?.at !== message.timestamp || send.text !== message.text.trim()) continue
    tags.set(message, send)
    next++
  }
  return tags
}

function badgesOf(message: ChatMessage): Badges {
  return {
    userType: message.userType,
    guardType: message.guardType,
    medalName: message.medalName ?? '',
    medalLevel: message.medalLevel,
  }
}

function periodsOf(
  messages: readonly ChatMessage[],
  users: readonly ReportUser[],
  sends: ReadonlyMap<string, number[]>
): Period[] {
  const first = messages[0]?.timestamp
  const last = messages[messages.length - 1]?.timestamp
  if (first === undefined || last === undefined) return []
  const spans = users
    .flatMap(user => user.episodes)
    .map(episode => ({
      from: Math.floor((episode.startAt - TIMELINE_CONTEXT_MS) / SNAP_MS) * SNAP_MS,
      to: Math.ceil((episode.endAt + TIMELINE_CONTEXT_MS) / SNAP_MS) * SNAP_MS,
    }))
    .sort((a, b) => a.from - b.from)
  const merged: { from: number; to: number }[] = []
  for (const span of spans) {
    const open = merged[merged.length - 1]
    if (open && span.from <= open.to) open.to = Math.max(open.to, span.to)
    else merged.push(span)
  }

  let cursor = 0
  return merged.map(span => {
    const from = Math.max(span.from, first)
    const to = Math.max(Math.min(span.to, last), from + MIN_PERIOD_MS)
    const minutes = BUCKET_MINUTES.find(m => (to - from) / (m * 60_000) <= MAX_BUCKETS) ?? 1440
    const bucketMs = minutes * 60_000
    const counts = new Array<number>(Math.ceil((to - from) / bucketMs)).fill(0)
    while (cursor < messages.length && (messages[cursor] as ChatMessage).timestamp < from) cursor++
    for (; cursor < messages.length; cursor++) {
      const at = (messages[cursor] as ChatMessage).timestamp
      if (at > to) break
      const bucket = Math.min(counts.length - 1, Math.floor((at - from) / bucketMs))
      counts[bucket] = (counts[bucket] as number) + 1
    }
    const lanes = users.flatMap((user): Lane[] => {
      const episodes = user.episodes.filter(episode => episode.endAt >= from && episode.startAt <= to)
      if (episodes.length === 0) return []
      const times = (sends.get(userKey(user)) ?? []).filter(at => at >= from && at <= to)
      return [{ roomId: user.roomId, uid: user.uid, uname: user.uname, sends: times, episodes }]
    })
    return { from, to, bucketMs, counts, ticks: ticksOf(from, to), lanes }
  })
}

/** Ticks every few minutes or hours on the configured time zone's boundaries; midnight is labelled with its date. */
function ticksOf(from: number, to: number): { at: number; label: string }[] {
  const minutes = TICK_MINUTES.find(m => (to - from) / (m * 60_000) <= MAX_TICKS) ?? 1440
  const ticks: { at: number; label: string }[] = []
  for (let i = 0; ; i++) {
    const at = afterMidnight(from, i * minutes)
    if (at > to) break
    if (at < from) continue
    const time = hourMinute(at)
    ticks.push({ at, label: time === '00:00' ? monthDay(at) : time })
  }
  return ticks
}

function gapHistogram(times: readonly number[]): GapHistogram | null {
  if (times.length - 1 < MIN_GAPS) return null
  const gaps: number[] = []
  for (let i = 1; i < times.length; i++) gaps.push((times[i] as number) - (times[i - 1] as number))
  const typical = (2 * median(gaps)) / 1000
  const scale = GAP_SCALES.find(item => item.max >= typical) ?? WIDEST_GAP_SCALE
  const counts = new Array<number>((scale.max * 1000) / scale.binMs).fill(0)
  let over = 0
  for (const gap of gaps) {
    const bin = Math.floor(gap / scale.binMs)
    if (bin < counts.length) counts[bin] = (counts[bin] as number) + 1
    else over++
  }
  return { max: scale.max, binMs: scale.binMs, counts, over, half: narrowestHalf(gaps) }
}

/** The narrowest range holding half of `values` (at least one). */
function narrowestHalf(values: readonly number[]): [number, number] {
  const sorted = Float64Array.from(values).sort()
  const span = Math.max(1, Math.ceil(sorted.length / 2)) - 1
  const width = (i: number) => (sorted[i + span] as number) - (sorted[i] as number)
  let best = 0
  for (let i = 1; i + span < sorted.length; i++) if (width(i) < width(best)) best = i
  return [sorted[best] as number, sorted[best + span] as number]
}
