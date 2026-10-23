import type { LaplaceEvent, Message } from '@laplace.live/event-types'

import type { ChatMessage, SpendEvent } from '@/types'

import { isRecord, toNumber } from '@/util/guards'

/** Why a `message` event was left out of detection. */
export type SkipReason = 'anonymous' | 'auto-danmaku' | 'mirror' | 'empty' | 'mock'

function num(value: unknown): number {
  return toNumber(value) ?? 0
}

/**
 * Normalize a LaplaceEvent `message` into a {@link ChatMessage}, or say why it can't be judged: no uid
 * (anonymous event stream), platform auto-danmaku (红包/天选, `sendType` ≠ 0) or a 跨房弹幕 mirror.
 */
export function toChatMessage(event: Message, options: { includeMirror?: boolean } = {}): ChatMessage | SkipReason {
  if ('mock' in event && (event as { mock?: unknown }).mock === true) return 'mock'
  if (!event.uid) return 'anonymous'
  if (event.sendType) return 'auto-danmaku'
  if (event.isMirror && !options.includeMirror) return 'mirror'
  if (typeof event.message !== 'string' || !event.message.trim()) return 'empty'
  const emote: unknown = event.emote
  return {
    id: event.id,
    roomId: event.origin,
    uid: event.uid,
    uname: event.username ?? '',
    text: event.message,
    timestamp: num(event.timestampNormalized) || num(event.timestamp),
    userType: num(event.userType),
    guardType: num(event.guardType),
    isEmote: isRecord(emote) && typeof emote.emoticon_unique === 'string' && emote.emoticon_unique.length > 0,
    medalLevel: num(event.medal?.level),
  }
}

/** Real-money events (gold gifts, SuperChats, guard purchases) as {@link SpendEvent}s; null for anything else. */
export function toSpendEvent(event: LaplaceEvent): SpendEvent | null {
  if (event.type !== 'gift' && event.type !== 'superchat' && event.type !== 'toast') return null
  if (!event.uid) return null
  if (event.type === 'gift' && event.coinType !== 'gold') return null
  return {
    id: event.id,
    roomId: event.origin,
    uid: event.uid,
    uname: event.username ?? '',
    amount: num(event.priceNormalized),
    kind: event.type === 'toast' ? 'guard' : event.type,
    timestamp: num(event.timestampNormalized) || num(event.timestamp),
  }
}
