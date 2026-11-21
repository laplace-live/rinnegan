import { describe, expect, test } from 'bun:test'
import type { Message } from '@laplace.live/event-types'

import { extractMessages, toChatMessage } from './events.ts'
import { messageEvent } from './testing/events.ts'

function message(patch: Record<string, unknown> = {}): Message {
  return messageEvent(
    { id: 'm1', roomId: 25034104, uid: 42, uname: 'viewer', text: '老公天下第一', timestamp: 1_000 },
    {
      guardType: 3,
      medal: { level: 21, name: '绿冻', room: 1, guardType: 3, lightened: 1, uid: 1, type: 0 },
      wealthMedalLevel: 23,
      ...patch,
    }
  )
}

describe('toChatMessage', () => {
  test('normalizes a danmaku', () => {
    expect(toChatMessage(message())).toMatchObject({
      roomId: 25034104,
      uid: 42,
      uname: 'viewer',
      text: '老公天下第一',
      timestamp: 1000,
      guardType: 3,
      medalLevel: 21,
      medalName: '绿冻',
      isEmote: false,
    })
  })

  test('recognizes stickers', () => {
    const sticker = message({ message: '赞', emote: { emoticon_unique: 'official_1', url: '', bulge_display: 1 } })
    expect(toChatMessage(sticker)).toMatchObject({ isEmote: true })
    expect(toChatMessage(message({ emote: {} }))).toMatchObject({ isEmote: false })
  })

  test('recognizes @-replies', () => {
    expect(toChatMessage(message({ reply: { uid: 7, uname: 'other' } }))).toMatchObject({ isReply: true })
    expect(toChatMessage(message({ reply: {} }))).toMatchObject({ isReply: false })
    expect(toChatMessage(message({ reply: undefined }))).toMatchObject({ isReply: false })
  })

  test('says why a message is skipped', () => {
    expect(toChatMessage(message({ uid: 0 }))).toBe('anonymous')
    expect(toChatMessage(message({ sendType: 2 }))).toBe('auto-danmaku')
    expect(toChatMessage(message({ isMirror: true }))).toBe('mirror')
    expect(toChatMessage(message({ isMirror: true }), { includeMirror: true })).toMatchObject({ uid: 42 })
    expect(toChatMessage(message({ message: '  ' }))).toBe('empty')
    expect(toChatMessage(message({ mock: true }))).toBe('mock')
  })

  test('reads ids as numbers, so a crafted archive cannot slip markup through them', () => {
    expect(toChatMessage(message({ origin: '<img src=x onerror=alert(1)>' }))).toMatchObject({ roomId: 0, uid: 42 })
    expect(toChatMessage(message({ uid: '<b>42</b>' }))).toBe('anonymous')
    expect(toChatMessage(message({ uid: '42' }))).toMatchObject({ uid: 42 })
  })
})

describe('extractMessages', () => {
  const sheets = [
    { name: 'main', data: [message(), message({ id: 'm2', timestamp: 500, timestampNormalized: 500 })] },
    { name: 'gifts', data: [] },
  ]

  test('extracts sorted, de-duplicated messages with filters', () => {
    const duplicated = [...sheets, { name: 'main', data: [message()] }]
    const { messages, skipped } = extractMessages(duplicated)
    expect(messages.map(item => item.id)).toEqual(['m2', 'm1'])
    expect(skipped).toEqual({})
    expect(extractMessages(sheets, { since: 600 }).messages.map(item => item.id)).toEqual(['m1'])
    expect(extractMessages(sheets, { rooms: [1] }).messages).toEqual([])
  })
})
