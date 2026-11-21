import type { BanPatch, BanRecord, BanRule, BanStore, LiftAction } from '@/store/types'
import type { SpendEvent } from '@/types'

import { EXPIRY_RULE, evaluateRules, type RuleHook, type RuleOutcome } from '@/store/rules'

/** What {@link BanLifecycle} reports; `rule` names the rule behind a decision. */
export type LifecycleEvent =
  | { type: 'spend'; ban: BanRecord; event: SpendEvent }
  | { type: 'lifted'; ban: BanRecord; rule: string; reason: string }
  | { type: 'lift-failed'; ban: BanRecord; rule: string; reason: string }
  | { type: 'extended'; ban: BanRecord; rule: string; reason: string }
  | { type: 'error'; error: unknown; ban?: BanRecord }

export interface BanLifecycleOptions {
  store: BanStore
  /** Evaluated in order; the first decision other than `keep` wins */
  rules: BanRule[]
  lift: LiftAction
  /** Should not throw; anything it throws is swallowed so the loop keeps running */
  onEvent?: (event: LifecycleEvent) => void
}

const noop = () => {}

/** Applies {@link BanRule}s to stored bans when users spend and on a periodic tick. */
export class BanLifecycle {
  readonly #store: BanStore
  readonly #rules: BanRule[]
  readonly #lift: LiftAction
  readonly #onEvent: ((event: LifecycleEvent) => void) | undefined
  /** Tail of the work queued per ban id */
  readonly #queues = new Map<string, Promise<void>>()
  #timer: ReturnType<typeof setInterval> | null = null
  #ticking: Promise<void> | null = null

  constructor(options: BanLifecycleOptions) {
    this.#store = options.store
    this.#rules = options.rules
    this.#lift = options.lift
    this.#onEvent = options.onEvent
  }

  /**
   * Adds a paid event to the sender's newest active ban in that room, then applies `onSpend` rules.
   * @returns The ban after any decision; null when the event carries no money or the user has no active ban there
   */
  async handleSpend(event: SpendEvent): Promise<BanRecord | null> {
    if (!(event.amount > 0)) return null
    let ban: BanRecord | null
    try {
      ban = await this.#store.addSpend(event.roomId, event.uid, event.amount)
    } catch (error) {
      this.#emit({ type: 'error', error })
      return null
    }
    if (!ban) return null
    this.#emit({ type: 'spend', ban, event })
    return this.#process(ban, { type: 'spend', event }, Date.now())
  }

  /**
   * Runs `onTick` rules over every active ban, or only the due ones when every rule is `due`-scoped. A tick still in
   * flight is joined, not repeated.
   */
  tick(now = Date.now()): Promise<void> {
    this.#ticking ??= this.#runTick(now).finally(() => {
      this.#ticking = null
    })
    return this.#ticking
  }

  /** Ticks now and every `intervalMs` after; the timer never keeps the process alive. */
  start(intervalMs = 60_000): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = setInterval(() => void this.tick(), intervalMs)
    this.#timer.unref()
    void this.tick()
  }

  /** Stops ticking and waits for in-flight work. */
  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
    await Promise.allSettled([this.#ticking, ...this.#queues.values()])
  }

  async #runTick(now: number): Promise<void> {
    let bans: BanRecord[]
    try {
      const dueOnly = this.#rules.every(rule => !rule.onTick || rule.tickScope === 'due')
      bans = await (dueOnly ? this.#store.listDue(now) : this.#store.listActive())
    } catch (error) {
      this.#emit({ type: 'error', error })
      return
    }
    for (const ban of bans) await this.#process(ban, { type: 'tick', now }, now)
  }

  /** Never throws; the decision is re-checked against the stored record before acting. */
  async #process(ban: BanRecord, hook: RuleHook, now: number): Promise<BanRecord> {
    try {
      if (!evaluateRules(this.#rules, ban, hook)) return ban
      return await this.#exclusive(ban.id, async () => {
        // A concurrent spend or tick may have lifted it already
        const current = await this.#store.get(ban.id)
        if (current?.status !== 'active') return current ?? ban
        const outcome = evaluateRules(this.#rules, current, hook)
        return outcome ? this.#apply(current, outcome, now) : current
      })
    } catch (error) {
      this.#emit({ type: 'error', error, ban })
      return ban
    }
  }

  async #apply(ban: BanRecord, outcome: RuleOutcome, now: number): Promise<BanRecord> {
    const { rule, reason } = outcome
    if (outcome.action === 'extend') {
      const patch = { expiresAt: outcome.expiresAt } satisfies BanPatch
      const extended = (await this.#store.update(ban.id, patch)) ?? { ...ban, ...patch }
      this.#emit({ type: 'extended', ban: extended, rule, reason })
      return extended
    }
    if (!(await this.#lift(ban, reason))) {
      this.#emit({ type: 'lift-failed', ban, rule, reason })
      return ban
    }
    const patch = {
      status: rule === EXPIRY_RULE ? 'expired' : 'lifted',
      liftedAt: now,
      liftReason: reason,
    } satisfies BanPatch
    const lifted = (await this.#store.update(ban.id, patch)) ?? { ...ban, ...patch }
    this.#emit({ type: 'lifted', ban: lifted, rule, reason })
    return lifted
  }

  /** Serializes work per ban so a burst of gifts or an overlapping tick never lifts it twice. */
  async #exclusive<T>(id: string, task: () => Promise<T>): Promise<T> {
    const run = (this.#queues.get(id) ?? Promise.resolve()).then(task)
    const tail = run.then(noop, noop)
    this.#queues.set(id, tail)
    try {
      return await run
    } finally {
      if (this.#queues.get(id) === tail) this.#queues.delete(id)
    }
  }

  #emit(event: LifecycleEvent): void {
    try {
      this.#onEvent?.(event)
    } catch {
      // a throwing listener must not stop the loop
    }
  }
}
