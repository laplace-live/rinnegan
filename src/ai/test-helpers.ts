/** Test doubles for `src/ai` tests; never imported by app code. */

import { expect } from 'bun:test'

import type { ReviewInput } from '@/ai/types'

/** A request seen by {@link fakeFetch}. */
export interface FetchCall {
  url: string
  method: string
  headers: Headers
  /** Parsed JSON body */
  body: Record<string, unknown>
  signal: AbortSignal | undefined
}

/** A uid that must never reach a model. */
export const SAMPLE_UID = 987_654_321

/** A JSON `Response`. */
export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' }, ...init })
}

/** A reply that never settles, so only a timeout or abort ends the request. */
export function pending(): Promise<Response> {
  return new Promise(() => {})
}

/** A recording `fetch` answering through `reply`; like real fetch, it rejects with the signal's reason on abort. */
export function fakeFetch(reply: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = []
  const fetcher = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const signal = init.signal ?? undefined
    const call: FetchCall = {
      url: String(input),
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : {},
      signal,
    }
    calls.push(call)
    signal?.throwIfAborted()
    const answer = Promise.resolve().then(() => reply(call))
    if (!signal) return answer
    const aborted = new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    return Promise.race([answer, aborted])
  }
  return { fetch: fetcher as unknown as typeof fetch, calls }
}

/** The single recorded call; fails the test otherwise. */
export function only(calls: FetchCall[]): FetchCall {
  expect(calls).toHaveLength(1)
  return calls[0] as FetchCall
}

/** A looping suspect: one line resent every 5.04 s with a soft hyphen moved around. */
export function sampleInput(): ReviewInput {
  const lines = ['主播好\u00AD棒', '主\u00AD播好棒', '主播\u00AD好棒', '主播好棒\u00AD']
  return {
    uname: '测试用户',
    roomId: 21_452_505,
    messages: Array.from({ length: 8 }, (_, i) => ({ offsetSec: i * 5.04, text: lines[i % lines.length] ?? '' })),
    assessment: {
      roomId: 21_452_505,
      uid: SAMPLE_UID,
      uname: '测试用户',
      at: 1_760_000_035_280,
      score: 96.3,
      verdict: 'spam',
      pattern: 'loop',
      repeats: 7,
      windowMessages: 8,
      automation: 0.95,
      evidence: [
        { kind: 'invisible-jitter', weight: 0.95, detail: '8/8 条插入不可见字符 U+00AD，4 种位置' },
        { kind: 'periodic', weight: 0.9, detail: '100% 的间隔落在 5.0s 节拍上（7 个间隔）' },
      ],
      clusters: [
        {
          key: '主播好棒',
          count: 8,
          variants: 4,
          invisible: 8,
          medianGapMs: 5040,
          regularity: 1,
          crowd: 0,
          firstAt: 1_760_000_000_000,
          lastAt: 1_760_000_035_280,
          samples: [{ timestamp: 1_760_000_000_000, text: '主播好\u00AD棒' }],
        },
      ],
      userType: 0,
      guardType: 0,
      medalLevel: 3,
      wealthLevel: 12,
    },
  }
}
