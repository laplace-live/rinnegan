interface Entry {
  at: number
  roomId: number
  key: string
  uid: number
  /** Raw text, kept only when it carries invisible chars so copies of a jittered line can be recognized */
  raw: string | null
}

/**
 * Who else in the room is sending the same canonical text right now. A line half the room is spamming is a
 * trend, so heavy repetition of it without automation evidence is crowd behaviour, not a 独轮车.
 */
export class CrowdIndex {
  readonly #windowMs: number
  /** `${roomId}\u0000${key}` → uid → last sent at */
  readonly #senders = new Map<string, Map<number, number>>()
  /** `${roomId}\u0000${raw}` → uid → last sent at, for raw texts with invisible chars */
  readonly #echoes = new Map<string, Map<number, number>>()
  readonly #queue: Entry[] = []
  #head = 0

  constructor(windowMs: number) {
    this.#windowMs = windowMs
  }

  /** Record a send and expire entries older than the window; pass `raw` for texts carrying invisible chars. */
  add(roomId: number, key: string, uid: number, at: number, raw: string | null = null): void {
    this.#expire(at)
    touch(this.#senders, `${roomId}\u0000${key}`, uid, at)
    if (raw !== null) touch(this.#echoes, `${roomId}\u0000${raw}`, uid, at)
    this.#queue.push({ at, roomId, key, uid, raw })
  }

  /** Whether someone other than `uid` sent exactly `raw` within the window, i.e. this send is a copy (+1). */
  echoes(roomId: number, raw: string, uid: number): boolean {
    const senders = this.#echoes.get(`${roomId}\u0000${raw}`)
    if (!senders) return false
    return senders.size - (senders.has(uid) ? 1 : 0) > 0
  }

  /** Distinct users other than `uid` who sent `key` in the room within the window. */
  others(roomId: number, key: string, uid: number): number {
    const senders = this.#senders.get(`${roomId}\u0000${key}`)
    if (!senders) return 0
    return senders.size - (senders.has(uid) ? 1 : 0)
  }

  #expire(now: number): void {
    const cutoff = now - this.#windowMs
    while (this.#head < this.#queue.length) {
      const entry = this.#queue[this.#head] as Entry
      if (entry.at >= cutoff) break
      this.#head++
      release(this.#senders, `${entry.roomId}\u0000${entry.key}`, entry.uid, entry.at)
      if (entry.raw !== null) release(this.#echoes, `${entry.roomId}\u0000${entry.raw}`, entry.uid, entry.at)
    }
    if (this.#head > 4096 && this.#head * 2 > this.#queue.length) {
      this.#queue.splice(0, this.#head)
      this.#head = 0
    }
  }
}

function touch(index: Map<string, Map<number, number>>, bucketKey: string, uid: number, at: number): void {
  let senders = index.get(bucketKey)
  if (!senders) {
    senders = new Map()
    index.set(bucketKey, senders)
  }
  senders.set(uid, at)
}

/** Drop an expired send unless the same uid sent again later. */
function release(index: Map<string, Map<number, number>>, bucketKey: string, uid: number, at: number): void {
  const senders = index.get(bucketKey)
  if (senders && senders.get(uid) === at) {
    senders.delete(uid)
    if (senders.size === 0) index.delete(bucketKey)
  }
}
