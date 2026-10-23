import { ConnectionState, LaplaceEventBridgeClient } from '@laplace.live/event-bridge-sdk'
import type { LaplaceEvent } from '@laplace.live/event-types'

import type { ChatMessage, SpendEvent } from '@/types'

import { type SkipReason, toChatMessage, toSpendEvent } from '@/sources/events'

export interface LiveSourceOptions {
  /** LAPLACE Event Fetcher (bridge mode) or Event Bridge WebSocket URL */
  url: string
  token: string
  /** Only these rooms; empty means every room the source sends */
  rooms: readonly number[]
  includeMirror: boolean
  onMessage: (message: ChatMessage) => void
  onSpend?: (event: SpendEvent) => void
  /** A `user-block` event: only the streamer's and admins' streams carry these */
  onBlock?: (roomId: number, uid: number, uname: string) => void
  onState?: (state: ConnectionState, detail: string) => void
}

export interface LiveSourceStats {
  events: number
  messages: number
  outsideRooms: number
  skipped: Partial<Record<SkipReason, number>>
}

/**
 * Add `rooms` to the source URL so LAPLACE Event Fetcher filters server-side; Event Bridge ignores the parameter,
 * so rooms are always filtered client-side as well.
 */
export function buildSourceUrl(url: string, rooms: readonly number[]): string {
  const parsed = new URL(url)
  if (!['ws:', 'wss:'].includes(parsed.protocol)) throw new Error(`事件源地址必须是 ws:// 或 wss://：${url}`)
  if (rooms.length > 0) parsed.searchParams.set('rooms', rooms.join(','))
  return parsed.toString()
}

/** First reconnect delay; doubles per failed attempt up to {@link RECONNECT_MAX_MS}. */
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30_000
/** Event ids remembered to drop duplicates (a second source, a replay after reconnect) */
const SEEN_IDS = 20_000

/**
 * Live danmaku from a LAPLACE event source via the official event-bridge SDK (auth, heartbeat). Reconnection is
 * driven here: the SDK's own loop also fires after `disconnect()`, so a stopped source would keep dialing.
 */
export class LiveSource {
  readonly stats: LiveSourceStats = { events: 0, messages: 0, outsideRooms: 0, skipped: {} }
  readonly #options: LiveSourceOptions
  readonly #rooms: Set<number> | null
  readonly #client: LaplaceEventBridgeClient
  #started = false
  #stopped = false
  #attempts = 0
  readonly #seen = new Set<string>()
  /** Ring of the remembered ids in arrival order; evicting via the Set's iterator walks its tombstones */
  readonly #seenOrder: string[] = []
  #seenHead = 0
  #retry: ReturnType<typeof setTimeout> | null = null

  constructor(options: LiveSourceOptions) {
    this.#options = options
    this.#rooms = options.rooms.length > 0 ? new Set(options.rooms) : null
    this.#client = new LaplaceEventBridgeClient({
      url: buildSourceUrl(options.url, options.rooms),
      token: options.token,
      reconnect: false,
    })
    this.#client.onAny(event => this.#handle(event))
    // The SDK replays the current state synchronously on subscribe, so nothing counts until start().
    this.#client.onConnectionStateChange((state, detail) => {
      if (!this.#started || this.#stopped) return
      if (state === ConnectionState.CONNECTED) this.#attempts = 0
      const close = detail?.closeEvent
        ? ` (${detail.closeEvent.code}${detail.closeEvent.reason ? ` ${detail.closeEvent.reason}` : ''})`
        : ''
      options.onState?.(state, close)
      if (state === ConnectionState.DISCONNECTED) this.#scheduleReconnect()
    })
  }

  /** Connect; a failed first attempt keeps retrying in the background instead of throwing. */
  async start(): Promise<void> {
    this.#started = true
    this.#stopped = false
    await this.#connect()
  }

  stop(): void {
    this.#stopped = true
    if (this.#retry) clearTimeout(this.#retry)
    this.#retry = null
    this.#client.disconnect()
  }

  async #connect(): Promise<void> {
    try {
      await this.#client.connect()
    } catch {
      // A failed attempt ends in DISCONNECTED, which schedules the next one.
    }
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#retry) return
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.#attempts, RECONNECT_MAX_MS)
    this.#attempts++
    this.#options.onState?.(
      ConnectionState.RECONNECTING,
      `，${Math.round(delay / 1000)} 秒后第 ${this.#attempts} 次重连`
    )
    this.#retry = setTimeout(() => {
      this.#retry = null
      // Connecting while a socket exists would make the SDK close it and report a spurious drop.
      if (!this.#stopped && this.#client.getConnectionState() === ConnectionState.DISCONNECTED) void this.#connect()
    }, delay)
  }

  #remember(id: string): void {
    if (this.#seenOrder.length < SEEN_IDS) this.#seenOrder.push(id)
    else {
      this.#seen.delete(this.#seenOrder[this.#seenHead] as string)
      this.#seenOrder[this.#seenHead] = id
      this.#seenHead = (this.#seenHead + 1) % SEEN_IDS
    }
    this.#seen.add(id)
  }

  #handle(event: LaplaceEvent): void {
    // The SDK also hands over bridge control frames such as `established`; real events carry a room.
    if (typeof event !== 'object' || event === null || typeof event.origin !== 'number') return
    this.stats.events++
    if (this.#rooms && !this.#rooms.has(event.origin)) {
      this.stats.outsideRooms++
      return
    }
    if (typeof event.id === 'string') {
      if (this.#seen.has(event.id)) return
      this.#remember(event.id)
    }
    if (event.type === 'message') {
      const message = toChatMessage(event, { includeMirror: this.#options.includeMirror })
      if (typeof message === 'string') {
        this.stats.skipped[message] = (this.stats.skipped[message] ?? 0) + 1
        return
      }
      this.stats.messages++
      this.#options.onMessage(message)
      return
    }
    if (event.type === 'user-block') {
      this.#options.onBlock?.(event.origin, event.uid, event.username)
      return
    }
    const spend = toSpendEvent(event)
    if (spend) this.#options.onSpend?.(spend)
  }
}

export { ConnectionState }
