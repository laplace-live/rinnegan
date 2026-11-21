import type { LaplaceEvent } from '@laplace.live/event-types'

import type { SpendEvent } from '@/types'

import { toId, toNumber } from '@/util/guards'

function num(value: unknown): number {
  return toNumber(value) ?? 0
}

/** Real-money events (gold gifts, SuperChats, guard purchases) as {@link SpendEvent}s; null for anything else. */
export function toSpendEvent(event: LaplaceEvent): SpendEvent | null {
  if (event.type !== 'gift' && event.type !== 'superchat' && event.type !== 'toast') return null
  const uid = toId(event.uid)
  if (uid === null) return null
  if (event.type === 'gift' && event.coinType !== 'gold') return null
  return {
    id: event.id,
    roomId: toId(event.origin) ?? 0,
    uid,
    uname: event.username ?? '',
    amount: num(event.priceNormalized),
    kind: event.type === 'toast' ? 'guard' : event.type,
    timestamp: num(event.timestampNormalized) || num(event.timestamp),
  }
}
