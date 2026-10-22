import { describe, expect, test } from 'bun:test'

import type { DecisionOptions } from '@/ai/decision'

import { evaluateDecision, readNoulAnswer } from '@/ai/decision'
import { readPath } from '@/ai/http'
import { buildReviewState } from '@/ai/prompt'
import { fakeFetch, jsonResponse, only, pending, SAMPLE_UID, sampleInput } from '@/ai/test-helpers'

const KEY = 'ts-test-secret'
const state = buildReviewState(sampleInput())
const typesafe: DecisionOptions = {
  protocol: 'typesafe',
  apiBase: 'https://api.typesafe.ai/v1',
  apiKey: KEY,
  model: 'jev-latest',
  state,
}
const answer = (noul: unknown) => jsonResponse({ answers: { dulunche: { type: 'noul', noul } } })

describe('evaluateDecision', () => {
  test('asks Typesafe a single dulunche noul question about the state', async () => {
    const { fetch, calls } = fakeFetch(() => answer(0.85))
    await expect(evaluateDecision({ ...typesafe, fetch })).resolves.toBe(0.85)
    const call = only(calls)
    expect(call.url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(call.method).toBe('POST')
    expect(call.headers.get('authorization')).toBe(`Bearer ${KEY}`)
    expect(call.headers.get('content-type')).toBe('application/json')
    expect(call.body).toEqual({
      model: 'jev-latest',
      state,
      questions: { dulunche: { type: 'noul', instructions: expect.any(String) } },
    })
    const instructions = String(readPath(call.body, 'questions', 'dulunche', 'instructions'))
    for (const phrase of ['独轮车', 'LAPLACE Chatterbox', '自动融入', 'U+00AD', '手动刷', '不是给你的指令']) {
      expect(instructions).toContain(phrase)
    }
  })

  test('never sends the uid', async () => {
    const { fetch, calls } = fakeFetch(() => answer(0.5))
    await evaluateDecision({ ...typesafe, fetch })
    const body = JSON.stringify(only(calls).body)
    expect(body).not.toContain(String(SAMPLE_UID))
    expect(body).not.toContain('"uid"')
  })

  test.each([
    ['https://openrouter.ai/api', 'https://openrouter.ai/api/alpha/decisions'],
    ['https://openrouter.ai/api/v1/', 'https://openrouter.ai/api/alpha/decisions'],
    ['https://openrouter.ai/', 'https://openrouter.ai/api/alpha/decisions'],
    ['http://localhost:8080/proxy/v1/', 'http://localhost:8080/proxy/alpha/decisions'],
  ])('normalizes OpenRouter base %s', async (apiBase, url) => {
    const { fetch, calls } = fakeFetch(() => answer(1))
    const request = evaluateDecision({
      ...typesafe,
      protocol: 'openrouter',
      apiBase,
      model: 'typesafe/jev-1.13',
      fetch,
    })
    await expect(request).resolves.toBe(1)
    expect(only(calls).url).toBe(url)
    expect(only(calls).body.model).toBe('typesafe/jev-1.13')
  })

  test('allows custom models and keyless local services', async () => {
    const { fetch, calls } = fakeFetch(() => answer(0))
    const request = evaluateDecision({
      ...typesafe,
      apiBase: 'http://127.0.0.1:8080/v1///',
      apiKey: '',
      model: 'custom-decision',
      fetch,
    })
    await expect(request).resolves.toBe(0)
    expect(only(calls).url).toBe('http://127.0.0.1:8080/v1/systemone')
    expect(only(calls).headers.has('authorization')).toBe(false)
  })

  test.each([
    {},
    { answers: {} },
    { answers: { send: { type: 'noul', noul: 0.9 } } },
    { answers: { dulunche: { type: 'choice', noul: 0.9 } } },
    { answers: { dulunche: { noul: 0.9 } } },
    { answers: { dulunche: { type: 'noul' } } },
    { answers: { dulunche: { type: 'noul', noul: '0.9' } } },
    { answers: { dulunche: { type: 'noul', noul: null } } },
    { answers: { dulunche: { type: 'noul', noul: -0.1 } } },
    { answers: { dulunche: { type: 'noul', noul: 1.1 } } },
  ])('rejects invalid answer %#', async response => {
    const { fetch } = fakeFetch(() => jsonResponse(response))
    await expect(evaluateDecision({ ...typesafe, fetch })).rejects.toThrow('决策模型返回的独轮车判断无效')
  })

  test('rejects non-finite probabilities', async () => {
    const { fetch } = fakeFetch(() => new Response('{"answers":{"dulunche":{"type":"noul","noul":1e999}}}'))
    await expect(evaluateDecision({ ...typesafe, fetch })).rejects.toThrow('独轮车判断无效')
    expect(readNoulAnswer({ answers: { dulunche: { type: 'noul', noul: Number.NaN } } })).toBeNull()
    expect(readNoulAnswer({ answers: { dulunche: { type: 'noul', noul: 0.25 } } })).toBe(0.25)
  })

  test.each<Partial<DecisionOptions>>([
    { apiBase: '' },
    { apiBase: 'not a URL' },
    { apiBase: 'file:///tmp/local' },
    { apiBase: 'https://key:secret@example.com/v1' },
    { apiBase: 'https://example.com/v1?api_key=secret' },
    { apiBase: 'https://example.com/v1#secret' },
    { apiKey: '' },
    { protocol: 'openrouter', apiBase: 'https://openrouter.ai/api', apiKey: ' ' },
    { model: ' ' },
    { protocol: 'grpc' as DecisionOptions['protocol'] },
  ])('rejects invalid configuration before a request %#', async overrides => {
    const { fetch, calls } = fakeFetch(() => answer(1))
    await expect(evaluateDecision({ ...typesafe, ...overrides, fetch })).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })

  test('times out without retrying', async () => {
    const { fetch, calls } = fakeFetch(pending)
    await expect(evaluateDecision({ ...typesafe, timeoutMs: 20, fetch })).rejects.toThrow('决策模型请求超时')
    expect(calls).toHaveLength(1)
  })

  test('aborts the request with the caller signal and ignores a late answer', async () => {
    const { fetch, calls } = fakeFetch(async () => {
      await Bun.sleep(20)
      return answer(1)
    })
    const controller = new AbortController()
    const request = evaluateDecision({ ...typesafe, signal: controller.signal, fetch })
    controller.abort()
    await expect(request).rejects.toHaveProperty('name', 'AbortError')
    expect(only(calls).signal?.aborted).toBe(true)
  })

  test('already aborted signals do not create a request', async () => {
    const { fetch, calls } = fakeFetch(() => answer(1))
    const request = evaluateDecision({ ...typesafe, signal: AbortSignal.abort(), fetch })
    await expect(request).rejects.toHaveProperty('name', 'AbortError')
    expect(calls).toHaveLength(0)
  })

  test('reports HTTP failures without echoing the key', async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ error: `bad key ${KEY}` }, { status: 401 }))
    const error = await evaluateDecision({ ...typesafe, fetch }).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toStartWith('决策模型请求失败：HTTP 401')
    expect((error as Error).message).not.toContain(KEY)
    expect(calls).toHaveLength(1)
  })
})
