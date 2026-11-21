import { describe, expect, test } from 'bun:test'

import { CROWDED_SWITCHES, LOCKSTEP_MIN, LockstepIndex } from '@/detect/lockstep'
import { seededRandom } from '@/testing/simulate'

const T0 = Date.parse('2026-11-20T12:00:00Z')
const ROOM = 1

/** Rounds `from`–`to` of trending lines 12 s apart; each listed account switches `offset` ms into the round. */
function feed(
  index: LockstepIndex,
  to: number,
  accounts: Record<number, (round: number) => number | null>,
  from = 0
): void {
  for (let r = from; r < to; r++) {
    const sends = Object.entries(accounts)
      .map(([uid, offset]) => ({ uid: Number(uid), at: offset(r) }))
      .filter((send): send is { uid: number; at: number } => send.at !== null)
      .map(send => ({ uid: send.uid, at: T0 + r * 12_000 + send.at }))
      .sort((a, b) => a.at - b.at)
    for (const send of sends) index.observe(ROOM, send.uid, `梗${r}`, send.at)
  }
}

describe('LockstepIndex', () => {
  test('pairs accounts that answer the same trigger a steady few ms apart', () => {
    const index = new LockstepIndex()
    const jitter = seededRandom(1)
    feed(index, 12, {
      1: () => 1000 + jitter() * 120,
      2: () => 1060 + jitter() * 120,
    })
    const fit = index.fit(ROOM, 2, T0)
    expect(fit).toMatchObject({ partner: 1, inStep: 12, paired: 12, partners: 1, switches: 12 })
    expect(fit?.offsetMs).toBeGreaterThan(0)
    expect(fit?.keys.size).toBe(12)
    expect(index.fit(ROOM, 1, T0)?.offsetMs).toBeLessThan(0)
  })

  test(`needs ${LOCKSTEP_MIN} in-step switches`, () => {
    const index = new LockstepIndex()
    const pair = { 1: () => 1000, 2: () => 1050 }
    feed(index, LOCKSTEP_MIN - 1, pair)
    expect(index.fit(ROOM, 2, T0)).toBeNull()
    feed(index, LOCKSTEP_MIN, pair, LOCKSTEP_MIN - 1)
    expect(index.fit(ROOM, 2, T0)?.inStep).toBe(LOCKSTEP_MIN)
  })

  test('ignores viewers whose reaction to the same chants wanders', () => {
    const index = new LockstepIndex()
    const random = seededRandom(7)
    // A bot on a fixed latency, and a hand-chaser 0.5–2 s after the trigger: they often land within 1.5 s, rarely in step.
    feed(index, 40, { 1: () => 1100, 2: () => 500 + random() * 1500 })
    expect(index.fit(ROOM, 2, T0)).toBeNull()
    expect(index.fit(ROOM, 1, T0)).toBeNull()
  })

  test('ignores an account that completes the trigger a second before the bots answer it', () => {
    const index = new LockstepIndex()
    feed(index, 20, { 1: () => 0, 2: () => 1000, 3: () => 1040 })
    expect(index.fit(ROOM, 1, T0)).toBeNull()
    expect(index.fit(ROOM, 3, T0)).toMatchObject({ partner: 2, partners: 1 })
  })

  test('ignores switches further apart than 1.5 s, such as a Copy Ninja mirror', () => {
    const index = new LockstepIndex()
    feed(index, 20, { 1: () => 0, 2: () => 2000 })
    expect(index.fit(ROOM, 1, T0)).toBeNull()
    expect(index.fit(ROOM, 2, T0)).toBeNull()
  })

  test('only counts switches since the window start, and sweeps old ones', () => {
    const index = new LockstepIndex()
    feed(index, 12, { 1: () => 1000, 2: () => 1030 })
    expect(index.fit(ROOM, 2, T0 + 6 * 12_000)).toBeNull()
    index.sweep(T0 + 12 * 12_000)
    expect(index.fit(ROOM, 2, T0)).toBeNull()
  })

  test(`stops pairing a line once ${CROWDED_SWITCHES} switches crowd its pairing window`, () => {
    const crowd = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [100 + i, () => 100 + i * 20]))
    const early = new LockstepIndex()
    feed(early, 12, { ...crowd, 1: () => 0, 2: () => 30 })
    expect(early.fit(ROOM, 2, T0)?.inStep).toBe(12)
    // The same pair inside the crush is never paired, however steady.
    const late = new LockstepIndex()
    feed(late, 12, { ...crowd, 1: () => 900, 2: () => 930 })
    expect(late.fit(ROOM, 2, T0)).toBeNull()
  })

  test('keeps rooms apart', () => {
    const index = new LockstepIndex()
    for (let r = 0; r < 12; r++) {
      index.observe(1, 1, `梗${r}`, T0 + r * 12_000)
      index.observe(2, 2, `梗${r}`, T0 + r * 12_000 + 20)
    }
    expect(index.fit(1, 1, T0)).toBeNull()
    expect(index.fit(2, 2, T0)).toBeNull()
  })
})
