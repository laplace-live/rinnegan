import { describe, expect, test } from 'bun:test'
import type { LaplaceEvent } from '@laplace.live/event-types'

import { decodeArchiveText, detectArchiveFormat, extractMessages, parseArchiveJson } from '@/sources/archive'
import { toChatMessage, toSpendEvent } from '@/sources/events'

function message(patch: Record<string, unknown> = {}): LaplaceEvent {
  return {
    type: 'message',
    id: 'm1',
    origin: 25034104,
    originIdx: 0,
    uid: 42,
    username: 'viewer',
    avatar: '',
    nameColor: '',
    message: '老公天下第一',
    userType: 0,
    userLvl: 0,
    userLvlBorder: 0,
    currentRank: 0,
    phoneVerified: 1,
    guardType: 3,
    sendType: 0,
    medal: { level: 21, name: '绿冻', room: 1, guardType: 3, lightened: 1, uid: 1, type: 0 },
    reply: {},
    idStr: 'x',
    wealthMedalLevel: 23,
    timestamp: 1_000,
    timestampNormalized: 1_000,
    read: false,
    ...patch,
  } as unknown as LaplaceEvent
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
      wealthLevel: 23,
      isEmote: false,
      isMirror: false,
    })
  })

  test('recognizes stickers', () => {
    const sticker = message({ message: '赞', emote: { emoticon_unique: 'official_1', url: '', bulge_display: 1 } })
    expect(toChatMessage(sticker)).toMatchObject({ isEmote: true })
    expect(toChatMessage(message({ emote: {} }))).toMatchObject({ isEmote: false })
  })

  test('says why a message is skipped', () => {
    expect(toChatMessage(message({ uid: 0 }))).toBe('anonymous')
    expect(toChatMessage(message({ sendType: 2 }))).toBe('auto-danmaku')
    expect(toChatMessage(message({ isMirror: true }))).toBe('mirror')
    expect(toChatMessage(message({ isMirror: true }), { includeMirror: true })).toMatchObject({ isMirror: true })
    expect(toChatMessage(message({ message: '  ' }))).toBe('empty')
    expect(toChatMessage(message({ mock: true }))).toBe('mock')
    expect(toChatMessage({ type: 'gift' } as LaplaceEvent)).toBe('not-message')
  })
})

describe('toSpendEvent', () => {
  test('counts gold gifts, SuperChats and guards in CNY', () => {
    const base = {
      id: 'g',
      origin: 1,
      uid: 7,
      username: 'fan',
      timestamp: 5,
      timestampNormalized: 5,
      priceNormalized: 30,
    }
    expect(toSpendEvent({ ...base, type: 'gift', coinType: 'gold' } as unknown as LaplaceEvent)).toMatchObject({
      kind: 'gift',
      amount: 30,
      uid: 7,
    })
    expect(toSpendEvent({ ...base, type: 'gift', coinType: 'silver' } as unknown as LaplaceEvent)).toBeNull()
    expect(toSpendEvent({ ...base, type: 'superchat' } as unknown as LaplaceEvent)?.kind).toBe('superchat')
    expect(toSpendEvent({ ...base, type: 'toast' } as unknown as LaplaceEvent)?.kind).toBe('guard')
    expect(toSpendEvent(message())).toBeNull()
  })
})

describe('archive codecs', () => {
  const sheets = [
    { name: 'main', data: [message(), message({ id: 'm2', timestamp: 500, timestampNormalized: 500 })] },
    { name: 'gifts', data: [] },
  ]
  const json = JSON.stringify(sheets)
  const encode = (text: string) => new Uint8Array(new TextEncoder().encode(text))

  test('detects and decodes every format', () => {
    const gzip = new Uint8Array(Bun.gzipSync(encode(json)))
    const zstd = new Uint8Array(Bun.zstdCompressSync(encode(json)))
    expect(detectArchiveFormat(gzip)).toBe('gzip')
    expect(detectArchiveFormat(zstd)).toBe('zstd')
    expect(detectArchiveFormat(encode(`  ${json}`))).toBe('raw')
    for (const bytes of [gzip, zstd, encode(json)]) expect(decodeArchiveText(bytes).json).toBe(json)
  })

  test('rejects anything else, such as a pre-2026 lz-string archive', () => {
    // lz-string's UTF-16 output is arbitrary high code points, never JSON or a compression magic.
    const legacy = encode('ᯡ࠽䅬ڀ⁌౰ൠ٤ᘡ䐠')
    expect(detectArchiveFormat(legacy)).toBeNull()
    expect(() => decodeArchiveText(legacy)).toThrow('重新导出')
  })

  test('accepts a bare event array as the main sheet', () => {
    expect(parseArchiveJson(JSON.stringify([message()]))).toEqual([{ name: 'main', data: [message()] }])
    expect(() => parseArchiveJson('{"a":1}')).toThrow()
    expect(() => parseArchiveJson('[1,2]')).toThrow()
  })

  test('extracts sorted, de-duplicated messages with filters', () => {
    const duplicated = [...sheets, { name: 'main', data: [message()] }]
    const { messages, skipped } = extractMessages(duplicated)
    expect(messages.map(item => item.id)).toEqual(['m2', 'm1'])
    expect(skipped).toEqual({})
    expect(extractMessages(sheets, { since: 600 }).messages.map(item => item.id)).toEqual(['m1'])
    expect(extractMessages(sheets, { rooms: [1] }).messages).toEqual([])
  })
})
