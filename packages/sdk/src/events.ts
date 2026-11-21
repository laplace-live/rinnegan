import type { LaplaceEvent, Message } from '@laplace.live/event-types'

import type { ChatMessage } from './types.ts'

import { isRecord, readPath, toId, toNumber } from './guards.ts'

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
  // Archives are untrusted: a non-numeric id would reach the HTML report as markup.
  const uid = toId(event.uid)
  if (uid === null) return 'anonymous'
  if (event.sendType) return 'auto-danmaku'
  if (event.isMirror && !options.includeMirror) return 'mirror'
  if (typeof event.message !== 'string' || !event.message.trim()) return 'empty'
  const emote: unknown = event.emote
  return {
    id: event.id,
    roomId: toId(event.origin) ?? 0,
    uid,
    uname: event.username ?? '',
    text: event.message,
    timestamp: num(event.timestampNormalized) || num(event.timestamp),
    userType: num(event.userType),
    guardType: num(event.guardType),
    isEmote: isRecord(emote) && typeof emote.emoticon_unique === 'string' && emote.emoticon_unique.length > 0,
    medalLevel: num(event.medal?.level),
    medalName: typeof event.medal?.name === 'string' ? event.medal.name : '',
    isReply: num(readPath(event.reply, 'uid')) > 0,
  }
}

/** One sheet of an archive, e.g. `main`, `gifts`, `superchats`, `miscs`. */
export interface EventSheet {
  name: string
  data: LaplaceEvent[]
}

export interface ExtractOptions {
  rooms?: readonly number[]
  /** Unix ms, inclusive */
  since?: number
  /** Unix ms, inclusive */
  until?: number
  includeMirror?: boolean
}

export interface Extracted {
  messages: ChatMessage[]
  skipped: Record<string, number>
}

/** Oldest first; event id breaks timestamp ties so replays are deterministic. */
export function compareMessages(a: ChatMessage, b: ChatMessage): number {
  return a.timestamp - b.timestamp || a.id.localeCompare(b.id)
}

/** Every judgeable danmaku across all sheets, deduplicated by event id and sorted oldest first. */
export function extractMessages(sheets: readonly EventSheet[], options: ExtractOptions = {}): Extracted {
  const rooms = options.rooms && options.rooms.length > 0 ? new Set(options.rooms) : null
  const seen = new Set<string>()
  const messages: ChatMessage[] = []
  const skipped: Record<string, number> = {}
  for (const sheet of sheets) {
    for (const event of sheet.data) {
      if (event?.type !== 'message') continue
      if (seen.has(event.id)) continue
      seen.add(event.id)
      const message = toChatMessage(event, { includeMirror: options.includeMirror })
      if (typeof message === 'string') {
        skipped[message] = (skipped[message] ?? 0) + 1
        continue
      }
      if (rooms && !rooms.has(message.roomId)) continue
      if (options.since !== undefined && message.timestamp < options.since) continue
      if (options.until !== undefined && message.timestamp > options.until) continue
      messages.push(message)
    }
  }
  messages.sort(compareMessages)
  return { messages, skipped }
}
