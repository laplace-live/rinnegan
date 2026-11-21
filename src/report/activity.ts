import type { ReportUser } from '@/report/report'
import type { ChatMessage, Verdict } from '@/types'

import { median } from '@/detect/timing'
import { afterMidnight, clock, localDate } from '@/util/console'

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

/** One flagged user's row on a {@link Period}; times are seconds from the period start. */
export interface Lane {
  roomId: number
  uid: number
  uname: string
  sends: number[]
  /** Flagged stretches as `[start, end, verdict]` */
  flagged: [number, number, Verdict][]
  /** Unix ms of the user's first and last danmaku in the period, null when none */
  firstAt: number | null
  lastAt: number | null
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
  /** The tick of the user's `send-tick` evidence, for guide lines */
  tickMs: number | null
}

/** Roles and medal from a user's danmaku. */
export interface Badges {
  userType: number
  guardType: number
  medalName: string
  medalLevel: number
}

/** What the HTML report draws beyond the JSON report, gathered from the judged danmaku. */
export interface Activity {
  /** Streamer names by room, from their own danmaku */
  hosts: Map<number, string>
  /** Oldest first */
  periods: Period[]
  /** By {@link userKey}; absent when a user has too few gaps */
  gaps: Map<string, GapHistogram>
  /** As of each user's peak, by {@link userKey} */
  badges: Map<string, Badges>
}

export function userKey(user: { roomId: number; uid: number }): string {
  return `${user.roomId}:${user.uid}`
}

/** Timelines, send-gap histograms and badges for the flagged `users`; `messages` sorted oldest first. */
export function buildActivity(messages: readonly ChatMessage[], users: readonly ReportUser[]): Activity {
  const flagged = new Map(users.map(user => [userKey(user), user]))
  const sends = new Map<string, number[]>()
  const badges = new Map<string, Badges>()
  const hosts = new Map<number, string>()
  for (const message of messages) {
    if (message.userType === 100 && message.uname) hosts.set(message.roomId, message.uname)
    const key = userKey(message)
    const user = flagged.get(key)
    if (!user) continue
    const times = sends.get(key)
    if (times) times.push(message.timestamp)
    else sends.set(key, [message.timestamp])
    if (message.timestamp <= user.peakAt || !badges.has(key)) {
      badges.set(key, {
        userType: message.userType,
        guardType: message.guardType,
        medalName: message.medalName ?? '',
        medalLevel: message.medalLevel,
      })
    }
  }

  const gaps = new Map<string, GapHistogram>()
  for (const user of users) {
    const tickMs = user.evidence.find(item => item.kind === 'send-tick')?.tickMs ?? null
    const histogram = gapHistogram(sends.get(userKey(user)) ?? [], tickMs)
    if (histogram) gaps.set(userKey(user), histogram)
  }
  return { hosts, periods: periodsOf(messages, users, sends), gaps, badges }
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
    const seconds = (ms: number) => Math.round((Math.min(Math.max(ms, from), to) - from) / 1000)
    const lanes = users.flatMap((user): Lane[] => {
      const episodes = user.episodes.filter(episode => episode.endAt >= from && episode.startAt <= to)
      if (episodes.length === 0) return []
      const times = (sends.get(userKey(user)) ?? []).filter(at => at >= from && at <= to)
      return [
        {
          roomId: user.roomId,
          uid: user.uid,
          uname: user.uname,
          sends: times.map(seconds),
          flagged: episodes.map(episode => [seconds(episode.startAt), seconds(episode.endAt), episode.verdict]),
          firstAt: times[0] ?? null,
          lastAt: times[times.length - 1] ?? null,
        },
      ]
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
    const time = clock(at).slice(0, 5)
    ticks.push({ at, label: time === '00:00' ? localDate(at).slice(5) : time })
  }
  return ticks
}

function gapHistogram(times: readonly number[], tickMs: number | null): GapHistogram | null {
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
  return { max: scale.max, binMs: scale.binMs, counts, over, tickMs }
}
