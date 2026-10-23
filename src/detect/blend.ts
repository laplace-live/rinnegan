/**
 * Replays LAPLACE Chatterbox 自动融入 (apps/chatterbox/src/lib/auto-blend.ts) for each sender. It sends a line once
 * 3 users have sent it 3 times (a line idle for 15 s starts over), then ignores the room for a cooldown and counts
 * from zero, so every send it makes follows from the room alone: the first line to reach that threshold after the
 * cooldown, sent within the bot's own latency of the message that completed it.
 */

/** 自动融入 defaults: `autoBlendUniqueUsers`, `autoBlendMinOccurrences`, `autoBlendWindowSec` */
const TRIGGER_USERS = 3
const TRIGGER_SENDS = 3
const TRIGGER_IDLE_MS = 15_000
/** Fixed cooldowns tried, ms (chatterbox default 10 s) */
const COOLDOWNS_MS = [2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 30, 45, 60].map(sec => sec * 1000)
/** Auto cooldown: `K / CPM` seconds, clamped (`COOLDOWN_STEALTH_K`, `COOLDOWN_FLOOR_SEC`, `COOLDOWN_CEILING_SEC`) */
const AUTO_STEALTH_K = 300
const AUTO_FLOOR_SEC = 2
const AUTO_CEILING_SEC = 60
const CPM_WINDOW_MS = 30_000
/** Chatterbox's CPM extrapolation floor */
const CPM_MIN_SPAN_MS = 2000
/** `autoBlendAvoidRepeatCount` default */
const AVOID_LAST = 3
/** Bilibili drops a resend of the user's last line inside this */
const DUPLICATE_MS = 5000
/** Longest trigger-to-send delay counted as a hit: DOM render, send queue and request */
const MAX_TRIGGER_LAG_MS = 2500
/** Delay assumed until a hypothesis has hits of its own */
const DEFAULT_LAG_MS = 600
const LAGS_KEPT = 20
/** Waits past this between a cooldown's end and the next send aren't replayed */
const MAX_WAIT_MS = 120_000
/** Tape history: the longest cooldown and wait, plus CPM lookback */
const TAPE_MS = 4 * 60_000
/** Bilibili-dropped resends followed before giving up on one send */
const MAX_DROPPED = 12
/** Keys this long also match by prefix: 自动融入 cuts sends at `maxLength` */
const PREFIX_KEY_LENGTH = 8
/** Keys this long skip the crowd check: a cut send no longer shares the full line's key */
const LONG_KEY_LENGTH = 16

/** A message as {@link TrendTape} keeps it. */
export interface TapeEntry {
  at: number
  uid: number
  /** Trimmed raw text: 自动融入 counts exact strings */
  text: string
  /** Canonical key, for comparing a send with the line it copied */
  key: string
  /** False for stickers and @-replies, which 自动融入 skips */
  countable: boolean
}

interface Counter {
  /** Scan that last reset it */
  scan: number
  sends: number
  last: number
  users: number[]
}

/** One room's recent messages, oldest first, as 自动融入 would have watched them. */
export class TrendTape {
  readonly #entries: TapeEntry[] = []
  #head = 0
  /** Reused by every scan; a scan only reads counters it reset itself */
  readonly #counters = new Map<string, Counter>()
  #scan = 0

  /** Arrival time of the newest message */
  get lastAt(): number {
    return this.#entries.at(-1)?.at ?? 0
  }

  /** Append a message; times are kept monotonic so lookups can bisect. */
  add(entry: TapeEntry): void {
    const at = Math.max(entry.at, this.lastAt)
    this.#entries.push(at === entry.at ? entry : { ...entry, at })
    const cutoff = at - TAPE_MS
    while (this.#head < this.#entries.length && (this.#entries[this.#head] as TapeEntry).at < cutoff) this.#head++
    if (this.#head > 4096 && this.#head * 2 > this.#entries.length) {
      this.#entries.splice(0, this.#head)
      this.#head = 0
    }
  }

  /** Message completing the first line to reach the threshold in [`start`, `end`), ignoring `self` and `avoid`. */
  firstTrigger(start: number, end: number, self: number, avoid: readonly string[]): TapeEntry | null {
    const scan = ++this.#scan
    if (this.#counters.size > 4096) this.#counters.clear()
    for (let i = this.#lowerBound(start); i < this.#entries.length; i++) {
      const entry = this.#entries[i] as TapeEntry
      if (entry.at >= end) break
      // Half the scans avoid nothing; skipping the native call there is measurably faster.
      if (!entry.countable || entry.uid === self || (avoid.length > 0 && avoid.includes(entry.text))) continue
      let counter = this.#counters.get(entry.text)
      if (!counter) {
        counter = { scan: 0, sends: 0, last: 0, users: [] }
        this.#counters.set(entry.text, counter)
      }
      // Equivalent to chatterbox pruning every counter idle past the window before each count.
      if (counter.scan !== scan || entry.at - counter.last > TRIGGER_IDLE_MS) {
        counter.scan = scan
        counter.sends = 0
        counter.users.length = 0
      }
      counter.sends++
      counter.last = entry.at
      if (!counter.users.includes(entry.uid)) counter.users.push(entry.uid)
      if (counter.users.length >= TRIGGER_USERS && counter.sends >= TRIGGER_SENDS) return entry
    }
    return null
  }

  /** Chatterbox's chats per minute at `at` for `self`: everyone else's sends in the last 30 s. */
  cpm(at: number, self: number): number {
    const to = this.#lowerBound(at + 1)
    let sends = 0
    let oldest = at
    for (let i = this.#lowerBound(at - CPM_WINDOW_MS); i < to; i++) {
      const entry = this.#entries[i] as TapeEntry
      if (entry.uid === self) continue
      if (sends === 0) oldest = entry.at
      sends++
    }
    if (sends === 0) return 0
    return Math.round((sends * 60_000) / Math.max(CPM_MIN_SPAN_MS, Math.min(at - oldest, CPM_WINDOW_MS)))
  }

  #lowerBound(at: number): number {
    let lo = this.#head
    let hi = this.#entries.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((this.#entries[mid] as TapeEntry).at < at) lo = mid + 1
      else hi = mid
    }
    return lo
  }
}

/** One of the user's sends, as {@link TriggerReplay} judges it. */
export interface ReplaySend {
  at: number
  /** Trimmed raw text */
  text: string
  key: string
  /** Other users who sent the same key recently */
  others: number
}

/** Whether `send` copies a line the room is sending, the only kind 自动融入 makes. */
export function followsCrowd(send: ReplaySend): boolean {
  return send.others >= TRIGGER_USERS - 1 || send.key.length >= LONG_KEY_LENGTH
}

interface Hypothesis {
  /** Fixed cooldown, or null for chatterbox's auto (CPM) cooldown */
  cooldownMs: number | null
  avoid: boolean
  /** Arrival of the trigger behind the user's last send, as this setting explains it */
  anchor: number
  /** Last triggered lines, for avoid-repeat */
  recent: string[]
  lags: number[]
  /** Median of `lags` */
  lag: number
  /** Line changes in the window this setting predicted */
  hits: number
}

/** A change to a line others were sending: the sends a fit is measured on. */
interface Change {
  at: number
  key: string
  /** Bit `i` set when hypothesis `i` predicted it */
  mask: number
}

/** The 自动融入 setting that best explains a user's recent line changes. */
export interface TriggerFit {
  /** Counted sends the setting predicted */
  hits: number
  /** Counted sends: changes to a line others were sending */
  changes: number
  /** Fixed cooldown, or null for auto */
  cooldownMs: number | null
  avoid: boolean
  /** Median trigger-to-send delay, ms */
  lagMs: number
  /** Keys of the predicted sends */
  keys: Set<string>
}

const SETTINGS = [false, true].flatMap(avoid => [...COOLDOWNS_MS, null].map(cooldownMs => ({ cooldownMs, avoid })))
const NO_LINES: readonly string[] = []

function lowerMedian(values: readonly number[]): number {
  const sorted = Float64Array.from(values).sort()
  return sorted[(sorted.length - 1) >> 1] as number
}

/** Chatterbox's auto cooldown at `cpm` chats per minute, ms. */
function autoCooldownMs(cpm: number): number {
  if (cpm <= 0) return AUTO_CEILING_SEC * 1000
  return Math.min(AUTO_CEILING_SEC, Math.max(AUTO_FLOOR_SEC, Math.round(AUTO_STEALTH_K / cpm))) * 1000
}

/** Move `hypothesis`'s anchor to a trigger of `text` at `at`, remembering the line for avoid-repeat. */
function anchorAt(hypothesis: Hypothesis, at: number, text: string): void {
  hypothesis.anchor = at
  hypothesis.recent.push(text)
  if (hypothesis.recent.length > AVOID_LAST) hypothesis.recent.shift()
}

/** 自动融入 cuts long lines, so a send may be a prefix of the line it copied. */
function sameLine(lineKey: string, sendKey: string): boolean {
  return lineKey === sendKey || (sendKey.length >= PREFIX_KEY_LENGTH && lineKey.startsWith(sendKey))
}

/**
 * One user replayed under every 自动融入 setting at once (fixed cooldowns, auto cooldown, avoid-repeat), each
 * predicting the user's next send from the room. Start it at a send that {@link followsCrowd}.
 */
export class TriggerReplay {
  readonly #uid: number
  readonly #hypotheses: Hypothesis[]
  /** Oldest first */
  readonly #changes: Change[] = []
  #last: ReplaySend

  constructor(uid: number, first: ReplaySend) {
    this.#uid = uid
    this.#hypotheses = SETTINGS.map(setting => ({
      ...setting,
      anchor: first.at - DEFAULT_LAG_MS,
      recent: [first.text],
      lags: [],
      lag: DEFAULT_LAG_MS,
      hits: 0,
    }))
    this.#last = first
  }

  /** Judge the user's next send, in time order. Sends nobody else made are manual: no setting's cooldown moves. */
  observe(tape: TrendTape, send: ReplaySend): void {
    if (followsCrowd(send)) {
      let mask = 0
      for (let i = 0; i < this.#hypotheses.length; i++) {
        if (this.#judge(tape, this.#hypotheses[i] as Hypothesis, send)) mask |= 1 << i
      }
      if (send.key !== this.#last.key) {
        this.#changes.push({ at: send.at, key: send.key, mask })
        this.#count(mask, 1)
      }
    }
    this.#last = send
  }

  /** Drop judged sends older than `cutoff`. */
  forget(cutoff: number): void {
    let drop = 0
    while (drop < this.#changes.length && (this.#changes[drop] as Change).at < cutoff) {
      this.#count((this.#changes[drop] as Change).mask, -1)
      drop++
    }
    if (drop > 0) this.#changes.splice(0, drop)
  }

  /** The setting with the most hits among the judged sends, or null below `minHits`. */
  fit(minHits: number): TriggerFit | null {
    const best = this.#hypotheses.reduce((top, hypothesis) => (hypothesis.hits > top.hits ? hypothesis : top))
    if (best.hits === 0 || best.hits < minHits) return null
    const bit = 1 << this.#hypotheses.indexOf(best)
    const keys = new Set<string>()
    for (const change of this.#changes) if (change.mask & bit) keys.add(change.key)
    return {
      hits: best.hits,
      changes: this.#changes.length,
      cooldownMs: best.cooldownMs,
      avoid: best.avoid,
      lagMs: best.lag,
      keys,
    }
  }

  #count(mask: number, step: 1 | -1): void {
    this.#hypotheses.forEach((hypothesis, i) => {
      if (mask & (1 << i)) hypothesis.hits += step
    })
  }

  /** Whether `hypothesis` predicts `send`, moving its anchor to the trigger it believes fired. */
  #judge(tape: TrendTape, hypothesis: Hypothesis, send: ReplaySend): boolean {
    let start = this.#wakeAt(tape, hypothesis)
    for (let dropped = 0; dropped <= MAX_DROPPED && send.at >= start && send.at - start <= MAX_WAIT_MS; dropped++) {
      const trigger = tape.firstTrigger(start, send.at, this.#uid, hypothesis.avoid ? hypothesis.recent : NO_LINES)
      if (!trigger) break
      if (trigger.text === this.#last.text && trigger.at + hypothesis.lag - this.#last.at < DUPLICATE_MS) {
        // The dropped resend still restarted the cooldown.
        anchorAt(hypothesis, trigger.at, trigger.text)
        start = this.#wakeAt(tape, hypothesis)
        continue
      }
      const delay = send.at - trigger.at
      if (delay > MAX_TRIGGER_LAG_MS || !sameLine(trigger.key, send.key)) break
      hypothesis.lags.push(delay)
      if (hypothesis.lags.length > LAGS_KEPT) hypothesis.lags.shift()
      hypothesis.lag = lowerMedian(hypothesis.lags)
      anchorAt(hypothesis, trigger.at, trigger.text)
      return true
    }
    anchorAt(hypothesis, send.at - hypothesis.lag, send.text)
    return false
  }

  /** When `hypothesis`'s cooldown from its anchor ends. */
  #wakeAt(tape: TrendTape, hypothesis: Hypothesis): number {
    return hypothesis.anchor + (hypothesis.cooldownMs ?? autoCooldownMs(tape.cpm(hypothesis.anchor, this.#uid)))
  }
}
