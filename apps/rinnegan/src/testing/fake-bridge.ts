import type { ServerWebSocket } from 'bun'

/** A minimal LAPLACE Event Fetcher bridge (`/` WebSocket, `established` greeting, JSON events) for tests. */
export interface FakeBridge {
  url: string
  /** Request URLs clients connected with */
  connections: URL[]
  /** `Sec-WebSocket-Protocol` headers clients sent */
  protocols: string[]
  broadcast(event: unknown): void
  /** Resolves once `count` clients have connected in total */
  waitForConnections(count: number): Promise<void>
  /** Drop every open socket (to exercise reconnects) */
  dropAll(): void
  stop(): void
}

export function startFakeBridge(): FakeBridge {
  const sockets = new Set<ServerWebSocket<unknown>>()
  const connections: URL[] = []
  const protocols: string[] = []
  const waiters: { count: number; resolve: () => void }[] = []
  const server = Bun.serve({
    port: 0,
    fetch(request, srv) {
      connections.push(new URL(request.url))
      const protocol = request.headers.get('sec-websocket-protocol') ?? ''
      protocols.push(protocol)
      const role = protocol.split(',')[0]?.trim()
      const headers = role ? { 'Sec-WebSocket-Protocol': role } : undefined
      if (srv.upgrade(request, { headers })) return undefined
      return new Response('expected a WebSocket', { status: 400 })
    },
    websocket: {
      open(ws) {
        sockets.add(ws)
        ws.send(
          JSON.stringify({
            type: 'established',
            version: '4.0.26',
            clientId: crypto.randomUUID(),
            timestamp: Date.now(),
          })
        )
        for (const waiter of [...waiters]) {
          if (connections.length >= waiter.count) {
            waiters.splice(waiters.indexOf(waiter), 1)
            waiter.resolve()
          }
        }
      },
      message() {},
      close(ws) {
        sockets.delete(ws)
      },
    },
  })
  return {
    url: `ws://127.0.0.1:${server.port}/`,
    connections,
    protocols,
    broadcast(event) {
      const data = JSON.stringify(event)
      for (const ws of sockets) ws.send(data)
    },
    waitForConnections(count) {
      if (connections.length >= count && sockets.size > 0) return Promise.resolve()
      return new Promise(resolve => waiters.push({ count, resolve }))
    },
    dropAll() {
      for (const ws of sockets) ws.close(1001, 'bye')
    },
    stop() {
      server.stop(true)
    },
  }
}
