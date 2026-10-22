import { afterEach, describe, expect, test } from 'bun:test'

import type { ChatMessage, SpendEvent } from '@/types'

import { buildSourceUrl, LiveSource, maskSourceUrl } from '@/sources/live'
import { type FakeBridge, startFakeBridge } from '@/testing/fake-bridge'

function danmaku(id: string, origin: number, uid: number, text: string) {
  return {
    type: 'message',
    id,
    origin,
    originIdx: 0,
    uid,
    username: `u${uid}`,
    message: text,
    userType: 0,
    guardType: 0,
    sendType: 0,
    medal: { level: 0 },
    wealthMedalLevel: 0,
    timestamp: Date.now(),
    timestampNormalized: Date.now(),
  }
}

async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await Bun.sleep(10)
  }
}

describe('source URLs', () => {
  test('adds the rooms filter LAPLACE Event Fetcher understands', () => {
    expect(buildSourceUrl('ws://lef:8080/', [25034104, 456117])).toBe('ws://lef:8080/?rooms=25034104%2C456117')
    expect(buildSourceUrl('wss://lef.example/path?x=1', [])).toBe('wss://lef.example/path?x=1')
    expect(() => buildSourceUrl('http://lef:8080', [])).toThrow('ws://')
  })

  test('masks tokens for display', () => {
    expect(maskSourceUrl('ws://lef:8080/?token=secret&rooms=1')).toBe('ws://lef:8080/?token=***&rooms=1')
  })
})

describe('LiveSource', () => {
  let bridge: FakeBridge | null = null
  let source: LiveSource | null = null
  afterEach(() => {
    source?.stop()
    bridge?.stop()
    source = null
    bridge = null
  })

  test('streams danmaku for watched rooms, spends and blocks', async () => {
    bridge = startFakeBridge()
    const messages: ChatMessage[] = []
    const spends: SpendEvent[] = []
    const blocks: number[] = []
    source = new LiveSource({
      url: bridge.url,
      token: 'bridge-secret',
      rooms: [25034104],
      includeMirror: false,
      onMessage: message => messages.push(message),
      onSpend: event => spends.push(event),
      onBlock: (_room, uid) => blocks.push(uid),
    })
    await source.start()
    await bridge.waitForConnections(1)

    const url = bridge.connections[0] as URL
    expect(url.searchParams.get('rooms')).toBe('25034104')
    expect(url.searchParams.get('token')).toBe('bridge-secret')
    expect(bridge.protocols[0]).toBe('laplace-event-bridge-role-client, bridge-secret')

    bridge.broadcast(danmaku('a', 25034104, 1, '千舰'))
    bridge.broadcast(danmaku('b', 999, 2, '别的房间'))
    bridge.broadcast({ ...danmaku('c', 25034104, 0, '匿名'), uid: 0 })
    bridge.broadcast({
      type: 'gift',
      id: 'g',
      origin: 25034104,
      uid: 3,
      username: 'fan',
      coinType: 'gold',
      priceNormalized: 30,
      timestamp: 1,
    })
    bridge.broadcast({
      type: 'user-block',
      id: 'k',
      origin: 25034104,
      uid: 4,
      username: 'banned',
      operator: 2,
      timestamp: 1,
    })
    await until(() => blocks.length === 1)

    expect(messages.map(message => message.text)).toEqual(['千舰'])
    expect(spends).toMatchObject([{ uid: 3, amount: 30, kind: 'gift' }])
    expect(source.stats.outsideRooms).toBe(1)
    expect(source.stats.skipped).toEqual({ anonymous: 1 })
  })

  test('reconnects after the bridge drops', async () => {
    bridge = startFakeBridge()
    const texts: string[] = []
    source = new LiveSource({
      url: bridge.url,
      token: '',
      rooms: [],
      includeMirror: false,
      onMessage: message => texts.push(message.text),
    })
    await source.start()
    await bridge.waitForConnections(1)
    bridge.dropAll()
    await bridge.waitForConnections(2)
    bridge.broadcast(danmaku('z', 1, 9, '回来了'))
    await until(() => texts.length === 1, 8000)
    expect(texts).toEqual(['回来了'])
  }, 15_000)
})
