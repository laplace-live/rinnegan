import { describe, expect, mock, test } from 'bun:test'

import type { BanRecord, BanRule, BanStore, LiftAction } from '@/store/types'
import type { SpendEvent } from '@/types'

import { BanLifecycle, type LifecycleEvent } from '@/store/lifecycle'
import { MemoryBanStore } from '@/store/memory'
import { EXPIRY_RULE, evaluateRules, expiryRule, SPEND_TO_UNBAN_RULE, spendToUnbanRule } from '@/store/rules'

let seq = 0

function ban(overrides: Partial<BanRecord> = {}): BanRecord {
  seq++
  return {
    id: crypto.randomUUID(),
    roomId: 1000,
    uid: 2000,
    uname: `用户${seq}`,
    reason: '独轮车',
    score: 95,
    pattern: 'loop',
    evidence: null,
    createdAt: seq,
    expiresAt: null,
    hours: -1,
    status: 'active',
    liftedAt: null,
    liftReason: null,
    spend: 0,
    operatorUid: null,
    meta: {},
    ...overrides,
  }
}

function spend(overrides: Partial<SpendEvent> = {}): SpendEvent {
  return {
    id: crypto.randomUUID(),
    roomId: 1000,
    uid: 2000,
    uname: '用户',
    amount: 10,
    kind: 'gift',
    timestamp: Date.now(),
    ...overrides,
  }
}

function setup(options: { rules?: BanRule[]; lift?: LiftAction; store?: BanStore } = {}) {
  const store = options.store ?? new MemoryBanStore()
  const events: LifecycleEvent[] = []
  const lift = mock<LiftAction>(options.lift ?? (async () => true))
  const lifecycle = new BanLifecycle({
    store,
    rules: options.rules ?? [expiryRule(), spendToUnbanRule(30)],
    lift,
    onEvent: event => events.push(event),
  })
  return { store, events, lift, lifecycle }
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await Bun.sleep(5)
  }
}

const SPEND_REASON = '累计消费 ¥30.00 ≥ ¥30，自动解除禁言'

describe('BanLifecycle', () => {
  test('lifts a ban once accumulated spend reaches the threshold', async () => {
    const { store, events, lift, lifecycle } = setup()
    const record = ban()
    await store.add(record)

    const first = await lifecycle.handleSpend(spend({ amount: 20 }))
    expect(first).toMatchObject({ id: record.id, spend: 20, status: 'active' })
    expect(lift).not.toHaveBeenCalled()

    const second = await lifecycle.handleSpend(spend({ amount: 10 }))
    expect(lift).toHaveBeenCalledTimes(1)
    expect(lift.mock.calls[0]?.[1]).toBe(SPEND_REASON)
    expect(second).toMatchObject({ status: 'lifted', liftReason: SPEND_REASON, spend: 30 })
    expect(second?.liftedAt).toBeNumber()
    expect(await store.get(record.id)).toEqual(second)
    expect(events.map(e => e.type)).toEqual(['spend', 'spend', 'lifted'])
    expect(events[0]).toMatchObject({ type: 'spend', ban: { id: record.id, spend: 20 }, event: { amount: 20 } })
    expect(events[2]).toMatchObject({ type: 'lifted', rule: SPEND_TO_UNBAN_RULE, reason: SPEND_REASON })
  })

  test('ignores spends without money or without an active ban', async () => {
    const { store, events, lifecycle } = setup()
    expect(await lifecycle.handleSpend(spend())).toBeNull()
    const record = ban()
    await store.add(record)
    expect(await lifecycle.handleSpend(spend({ amount: 0 }))).toBeNull()
    expect(await lifecycle.handleSpend(spend({ uid: 2001 }))).toBeNull()
    expect((await store.get(record.id))?.spend).toBe(0)
    expect(events).toEqual([])
  })

  test('a burst of gifts lifts the ban once', async () => {
    const { store, events, lift, lifecycle } = setup({
      lift: async () => {
        await Bun.sleep(10)
        return true
      },
    })
    const record = ban()
    await store.add(record)

    await Promise.all(Array.from({ length: 5 }, () => lifecycle.handleSpend(spend({ amount: 10 }))))
    expect(lift).toHaveBeenCalledTimes(1)
    expect(await store.get(record.id)).toMatchObject({ status: 'lifted', spend: 50 })
    expect(events.filter(e => e.type === 'lifted')).toHaveLength(1)
  })

  test('expiry lifts on tick and marks the ban expired', async () => {
    const { store, events, lift, lifecycle } = setup()
    const timed = ban({ expiresAt: 10_000, hours: 1 })
    const permanent = ban({ uid: 2001 })
    await store.add(timed)
    await store.add(permanent)

    await lifecycle.tick(9_999)
    expect(lift).not.toHaveBeenCalled()

    await lifecycle.tick(10_000)
    expect(lift).toHaveBeenCalledTimes(1)
    expect(lift.mock.calls[0]?.[0].id).toBe(timed.id)
    expect(await store.get(timed.id)).toMatchObject({ status: 'expired', liftReason: 'expired', liftedAt: 10_000 })
    expect((await store.get(permanent.id))?.status).toBe('active')
    expect(events).toEqual([
      {
        type: 'lifted',
        ban: expect.objectContaining({ id: timed.id, status: 'expired' }),
        rule: EXPIRY_RULE,
        reason: 'expired',
      },
    ])
  })

  test('a failed lift keeps the ban active and is retried on the next tick', async () => {
    let allow = false
    const { store, events, lift, lifecycle } = setup({ lift: async () => allow })
    const timed = ban({ expiresAt: 1000 })
    const paid = ban({ uid: 2001 })
    await store.add(timed)
    await store.add(paid)

    expect(await lifecycle.handleSpend(spend({ uid: 2001, amount: 30 }))).toMatchObject({ status: 'active', spend: 30 })
    await lifecycle.tick(2000)
    expect((await store.get(timed.id))?.status).toBe('active')
    expect(events.map(e => e.type)).toEqual(['spend', 'lift-failed', 'lift-failed', 'lift-failed'])
    expect(events[1]).toMatchObject({ type: 'lift-failed', ban: { id: paid.id }, reason: SPEND_REASON })

    allow = true
    await lifecycle.tick(3000)
    expect(lift).toHaveBeenCalledTimes(5)
    expect(await store.get(timed.id)).toMatchObject({ status: 'expired', liftedAt: 3000 })
    expect(await store.get(paid.id)).toMatchObject({ status: 'lifted', liftReason: SPEND_REASON })
  })

  test('extend moves expiresAt and keeps the ban active', async () => {
    const probation: BanRule = {
      name: 'probation',
      onTick: (b, now) =>
        b.expiresAt !== null && b.expiresAt - now < 1000
          ? { action: 'extend', expiresAt: b.expiresAt + 5000, reason: '仍在刷屏，延长禁言' }
          : { action: 'keep' },
    }
    const { store, events, lift, lifecycle } = setup({ rules: [probation, expiryRule()] })
    const record = ban({ expiresAt: 10_000 })
    await store.add(record)

    await lifecycle.tick(8_000)
    expect(events).toEqual([])
    await lifecycle.tick(9_500)
    expect(await store.get(record.id)).toMatchObject({ status: 'active', expiresAt: 15_000 })
    expect(lift).not.toHaveBeenCalled()
    expect(events).toEqual([
      {
        type: 'extended',
        ban: expect.objectContaining({ id: record.id, expiresAt: 15_000 }),
        rule: 'probation',
        reason: '仍在刷屏，延长禁言',
      },
    ])
  })

  test('errors are reported per ban and never stop the loop', async () => {
    const broken = ban({ uid: 2001, expiresAt: 1000 })
    const brokenRule: BanRule = {
      name: 'broken',
      onTick: b => {
        if (b.uid === 2002) throw new Error('规则出错')
        return { action: 'keep' }
      },
    }
    const { store, events, lifecycle } = setup({
      rules: [brokenRule, expiryRule()],
      lift: async b => {
        if (b.id === broken.id) throw new Error('网络错误')
        return true
      },
    })
    const first = ban({ expiresAt: 1000 })
    const throwsInRule = ban({ uid: 2002, expiresAt: 1000 })
    const last = ban({ uid: 2003, expiresAt: 1000 })
    for (const record of [first, broken, throwsInRule, last]) await store.add(record)

    await lifecycle.tick(5000)
    expect((await store.get(first.id))?.status).toBe('expired')
    expect((await store.get(last.id))?.status).toBe('expired')
    expect((await store.get(broken.id))?.status).toBe('active')
    expect((await store.get(throwsInRule.id))?.status).toBe('active')
    const errors = events.filter(e => e.type === 'error')
    expect(errors.map(e => e.ban?.id).sort()).toEqual([broken.id, throwsInRule.id].sort())
  })

  test('store failures are reported, not thrown', async () => {
    const store = new MemoryBanStore()
    store.listActive = async () => {
      throw new Error('db down')
    }
    store.addSpend = async () => {
      throw new Error('db down')
    }
    const { events, lifecycle } = setup({ store })

    await lifecycle.tick()
    expect(await lifecycle.handleSpend(spend())).toBeNull()
    expect(events).toEqual([
      { type: 'error', error: expect.any(Error) },
      { type: 'error', error: expect.any(Error) },
    ])
  })

  test('a throwing listener does not break processing', async () => {
    const store = new MemoryBanStore()
    const lift = mock(async () => true)
    const lifecycle = new BanLifecycle({
      store,
      rules: [expiryRule()],
      lift,
      onEvent: () => {
        throw new Error('listener bug')
      },
    })
    await store.add(ban({ expiresAt: 1 }))
    await store.add(ban({ uid: 2001, expiresAt: 1 }))
    await lifecycle.tick(10)
    expect(lift).toHaveBeenCalledTimes(2)
  })

  test('overlapping ticks share one pass', async () => {
    const store = new MemoryBanStore()
    const listActive = store.listActive.bind(store)
    let passes = 0
    store.listActive = async roomId => {
      passes++
      await Bun.sleep(20)
      return listActive(roomId)
    }
    const { lifecycle } = setup({ store })

    await Promise.all([lifecycle.tick(), lifecycle.tick(), lifecycle.tick()])
    expect(passes).toBe(1)
    await lifecycle.tick()
    expect(passes).toBe(2)
  })

  test('start ticks right away and on the interval until stopped', async () => {
    const { store, lift, lifecycle } = setup()
    await store.add(ban({ expiresAt: 0 }))
    lifecycle.start(10)
    await waitFor(() => lift.mock.calls.length === 1)

    await store.add(ban({ uid: 2001, expiresAt: 0 }))
    await waitFor(() => lift.mock.calls.length === 2)

    await lifecycle.stop()
    await store.add(ban({ uid: 2002, expiresAt: 0 }))
    await Bun.sleep(40)
    expect(lift).toHaveBeenCalledTimes(2)
  })
})

describe('rules', () => {
  test('expiryRule lifts at expiresAt and keeps permanent bans', () => {
    const rule = expiryRule()
    expect(rule.onTick?.(ban({ expiresAt: 100 }), 99)).toEqual({ action: 'keep' })
    expect(rule.onTick?.(ban({ expiresAt: 100 }), 100)).toEqual({ action: 'lift', reason: 'expired' })
    expect(rule.onTick?.(ban({ expiresAt: null }), Number.MAX_SAFE_INTEGER)).toEqual({ action: 'keep' })
  })

  test('spendToUnbanRule lifts at the threshold and is disabled when it is not positive', () => {
    expect(spendToUnbanRule(30).onSpend?.(ban({ spend: 29.99 }), spend())).toEqual({ action: 'keep' })
    expect(spendToUnbanRule(30).onSpend?.(ban({ spend: 30 }), spend())).toEqual({
      action: 'lift',
      reason: SPEND_REASON,
    })
    expect(spendToUnbanRule(9.9).onTick?.(ban({ spend: 10 }), 0)).toEqual({
      action: 'lift',
      reason: '累计消费 ¥10.00 ≥ ¥9.90，自动解除禁言',
    })
    for (const threshold of [0, -1, Number.NaN]) {
      expect(spendToUnbanRule(threshold).onSpend?.(ban({ spend: 1e6 }), spend())).toEqual({ action: 'keep' })
    }
  })

  test('evaluateRules returns the first decision other than keep, with its rule', () => {
    const keep: BanRule = { name: 'keep', onTick: () => ({ action: 'keep' }), onSpend: () => ({ action: 'keep' }) }
    const spendOnly: BanRule = { name: 'spend-only', onSpend: () => ({ action: 'lift', reason: 'paid' }) }
    const extend: BanRule = { name: 'extend', onTick: () => ({ action: 'extend', expiresAt: null, reason: '永久' }) }
    const lift: BanRule = { name: 'lift', onTick: () => ({ action: 'lift', reason: 'later' }) }
    const rules = [keep, spendOnly, extend, lift]

    expect(evaluateRules(rules, ban(), { type: 'tick', now: 0 })).toEqual({
      action: 'extend',
      expiresAt: null,
      reason: '永久',
      rule: 'extend',
    })
    expect(evaluateRules(rules, ban(), { type: 'spend', event: spend() })).toEqual({
      action: 'lift',
      reason: 'paid',
      rule: 'spend-only',
    })
    expect(evaluateRules([keep], ban(), { type: 'tick', now: 0 })).toBeNull()
    expect(evaluateRules([], ban(), { type: 'tick', now: 0 })).toBeNull()
  })
})
