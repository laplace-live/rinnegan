import { expect } from 'bun:test'

import type { FetchLike } from '@/util/fetch'

/** A request seen by {@link recordingFetch}. */
export interface FetchCall {
  url: string
  method: string
  headers: Headers
  body: string | null
  signal: AbortSignal | null
}

/** A `fetch` that records every request and answers through `reply`. */
export function recordingFetch(reply: (call: FetchCall) => Response | Promise<Response>): {
  fetch: FetchLike
  calls: FetchCall[]
} {
  const calls: FetchCall[] = []
  const fetch: FetchLike = (url, init) => {
    const call: FetchCall = {
      url,
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? init.body : null,
      signal: init.signal ?? null,
    }
    calls.push(call)
    return reply(call)
  }
  return { fetch, calls }
}

/** Rejects with the signal's reason once it aborts, like `fetch` against a server that never answers. */
export function hang(call: Pick<FetchCall, 'signal'>): Promise<Response> {
  return new Promise((_, reject) => call.signal?.addEventListener('abort', () => reject(call.signal?.reason)))
}

/** The single item; fails the test otherwise. */
export function only<T>(items: T[]): T {
  expect(items).toHaveLength(1)
  return items[0] as T
}
