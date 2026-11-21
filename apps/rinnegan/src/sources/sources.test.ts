import { describe, expect, test } from 'bun:test'
import type { LaplaceEvent } from '@laplace.live/event-types'

import { decodeArchiveText, detectArchiveFormat, parseArchiveJson } from '@/sources/archive'
import { toSpendEvent } from '@/sources/events'
import { messageEvent } from '@/testing/events'

const message = messageEvent({
  id: 'm1',
  roomId: 25034104,
  uid: 42,
  uname: 'viewer',
  text: '老公天下第一',
  timestamp: 1_000,
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
    expect(toSpendEvent(message)).toBeNull()
  })

  test('reads ids as numbers', () => {
    const event = { id: 'g', type: 'superchat', origin: '<b>1</b>', uid: 7, priceNormalized: 30 }
    expect(toSpendEvent(event as unknown as LaplaceEvent)).toMatchObject({ roomId: 0, uid: 7 })
    expect(toSpendEvent({ ...event, uid: '<b>7</b>' } as unknown as LaplaceEvent)).toBeNull()
  })
})

describe('archive codecs', () => {
  const sheets = [
    { name: 'main', data: [message] },
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
    expect(parseArchiveJson(JSON.stringify([message]))).toEqual([{ name: 'main', data: [message] }])
    expect(() => parseArchiveJson('{"a":1}')).toThrow()
    expect(() => parseArchiveJson('[1,2]')).toThrow()
  })
})
