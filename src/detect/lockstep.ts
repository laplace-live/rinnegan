/**
 * Accounts that keep switching to the same trending line at a fixed offset from each other. Several 自动融入 instances
 * fire on one trigger, so their sends land a steady few ms apart however the room's timing goes; viewers joining the
 * same chant by hand land seconds apart, and a viewer who completes a trigger sits a second ahead of every bot.
 */

/** Switches to one line further apart than this never pair */
const PAIR_MS = 1500
/** Half-width of the band around a pair's median offset that counts as in step */
const STEP_MS = 150
/** A pair offset further than this reacts to different moments, e.g. one account completes the trigger the other answers */
const MAX_OFFSET_MS = 400
/**
 * In-step switches a pair needs, and their share of its paired switches. Simulated hand-chasers whose reaction times
 * crowd around a bot's latency reach 8 of 9 by chance; none of 150 reached 9 at 80% against real swarms.
 */
export const LOCKSTEP_MIN = 9
const LOCKSTEP_SHARE = 0.8

interface Switch {
  uid: number
  at: number
}

/** Paired switches of two accounts, `a` < `b`; `tb[i] - ta[i]` is the offset. */
interface Pair {
  a: number
  b: number
  ta: number[]
  tb: number[]
  keys: string[]
}

/** Accounts a user kept step with inside the window. */
export interface LockstepFit {
  /** Partner with the most in-step switches */
  partner: number
  /** In-step switches with that partner, and all switches paired with it */
  inStep: number
  paired: number
  /** That partner's median offset from this user, ms (positive: this user sends later) */
  offsetMs: number
  /** Partners this user kept step with */
  partners: number
  /** This user's switches in step with any of them */
  switches: number
  /** Lines of those switches */
  keys: Set<string>
}

function median(values: readonly number[]): number {
  const sorted = Float64Array.from(values).sort()
  return sorted[sorted.length >> 1] as number
}

/** Line switches per room, paired across accounts. Feed switches in time order. */
export class LockstepIndex {
  /** room → line → switches in the last {@link PAIR_MS} */
  readonly #recent = new Map<number, Map<string, Switch[]>>()
  readonly #pairs = new Map<string, Pair>()
  /** `room:uid` → ids of its pairs */
  readonly #byUser = new Map<string, Set<string>>()

  /** Record `uid` switching to `key`, a line others were already sending, and pair it with recent switches to it. */
  observe(roomId: number, uid: number, key: string, at: number): void {
    let lines = this.#recent.get(roomId)
    if (!lines) {
      lines = new Map()
      this.#recent.set(roomId, lines)
    }
    let recent = lines.get(key)
    if (!recent) {
      recent = []
      lines.set(key, recent)
    }
    let drop = 0
    while (drop < recent.length && (recent[drop] as Switch).at < at - PAIR_MS) drop++
    if (drop > 0) recent.splice(0, drop)
    for (const other of recent) {
      if (other.uid === uid) continue
      const forward = other.uid < uid
      const a = forward ? other.uid : uid
      const b = forward ? uid : other.uid
      const id = `${roomId}:${a}:${b}`
      let pair = this.#pairs.get(id)
      if (!pair) {
        pair = { a, b, ta: [], tb: [], keys: [] }
        this.#pairs.set(id, pair)
        this.#link(roomId, a, id)
        this.#link(roomId, b, id)
      }
      pair.ta.push(forward ? other.at : at)
      pair.tb.push(forward ? at : other.at)
      pair.keys.push(key)
    }
    recent.push({ uid, at })
    if (lines.size > 4096) {
      for (const [line, switches] of lines) {
        if ((switches.at(-1) as Switch).at < at - PAIR_MS) lines.delete(line)
      }
    }
  }

  /** Partners `uid` kept step with since `since`; null when there are none. */
  fit(roomId: number, uid: number, since: number): LockstepFit | null {
    const ids = this.#byUser.get(`${roomId}:${uid}`)
    if (!ids) return null
    let best: { partner: number; inStep: number; paired: number; offsetMs: number } | null = null
    let partners = 0
    const switches = new Set<number>()
    const keys = new Set<string>()
    for (const id of ids) {
      const pair = this.#pairs.get(id)
      if (!pair) {
        ids.delete(id)
        continue
      }
      let start = 0
      while (start < pair.ta.length && Math.max(pair.ta[start] as number, pair.tb[start] as number) < since) start++
      const paired = pair.ta.length - start
      if (paired < LOCKSTEP_MIN) continue
      const self = pair.a === uid
      const offsets: number[] = []
      for (let i = start; i < pair.ta.length; i++) {
        const offset = (pair.tb[i] as number) - (pair.ta[i] as number)
        offsets.push(self ? -offset : offset)
      }
      const offsetMs = median(offsets)
      if (Math.abs(offsetMs) > MAX_OFFSET_MS) continue
      let inStep = 0
      for (const offset of offsets) if (Math.abs(offset - offsetMs) <= STEP_MS) inStep++
      if (inStep < LOCKSTEP_MIN || inStep < LOCKSTEP_SHARE * paired) continue
      partners++
      offsets.forEach((offset, i) => {
        if (Math.abs(offset - offsetMs) > STEP_MS) return
        switches.add((self ? pair.ta : pair.tb)[start + i] as number)
        keys.add(pair.keys[start + i] as string)
      })
      if (!best || inStep > best.inStep) best = { partner: self ? pair.b : pair.a, inStep, paired, offsetMs }
    }
    return best ? { ...best, partners, switches: switches.size, keys } : null
  }

  /** Forget switches before `cutoff`, and pairs left with none. */
  sweep(cutoff: number): void {
    for (const [id, pair] of this.#pairs) {
      let drop = 0
      while (drop < pair.ta.length && Math.max(pair.ta[drop] as number, pair.tb[drop] as number) < cutoff) drop++
      if (drop === 0) continue
      if (drop === pair.ta.length) {
        this.#pairs.delete(id)
        continue
      }
      pair.ta.splice(0, drop)
      pair.tb.splice(0, drop)
      pair.keys.splice(0, drop)
    }
    for (const [user, ids] of this.#byUser) {
      for (const id of ids) if (!this.#pairs.has(id)) ids.delete(id)
      if (ids.size === 0) this.#byUser.delete(user)
    }
    for (const [roomId, lines] of this.#recent) {
      for (const [line, switches] of lines) if ((switches.at(-1) as Switch).at < cutoff) lines.delete(line)
      if (lines.size === 0) this.#recent.delete(roomId)
    }
  }

  #link(roomId: number, uid: number, id: string): void {
    const user = `${roomId}:${uid}`
    let ids = this.#byUser.get(user)
    if (!ids) {
      ids = new Set()
      this.#byUser.set(user, ids)
    }
    ids.add(id)
  }
}
