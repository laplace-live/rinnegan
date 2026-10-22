import { describe, expect, test } from 'bun:test'

import type { ChatCompletionOptions, ChatCompletionResponseFormat } from '@/ai/llm'

import { chatCompletion, extractJsonObject } from '@/ai/llm'
import { fakeFetch, jsonResponse, only, pending } from '@/ai/test-helpers'

const KEY = 'sk-or-test-secret'
const options: ChatCompletionOptions = {
  apiKey: KEY,
  model: 'openai/gpt-5.1-mini',
  messages: [
    { role: 'system', content: '只返回 JSON' },
    { role: 'user', content: '{"uname":"测试用户"}' },
  ],
}
const reply = (content: unknown) => jsonResponse({ choices: [{ message: { role: 'assistant', content } }] })

async function failure(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => null,
    (err: unknown) => err
  )
  expect(error).toBeInstanceOf(Error)
  return error as Error
}

describe('chatCompletion', () => {
  test('posts a non-streaming OpenRouter request with attribution headers', async () => {
    const { fetch, calls } = fakeFetch(() => reply('{"probability":0.9}'))
    const responseFormat: ChatCompletionResponseFormat = {
      type: 'json_schema',
      json_schema: { name: 'review', strict: true, schema: { type: 'object' } },
    }
    await expect(chatCompletion({ ...options, responseFormat, fetch })).resolves.toBe('{"probability":0.9}')
    const call = only(calls)
    expect(call.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(call.method).toBe('POST')
    expect(Object.fromEntries(call.headers)).toEqual({
      accept: 'application/json',
      authorization: `Bearer ${KEY}`,
      'content-type': 'application/json',
      'http-referer': 'https://github.com/laplace-live/rinnegan',
      'x-title': 'LAPLACE Rinnegan',
      'x-openrouter-title': 'LAPLACE Rinnegan',
    })
    expect(call.body).toEqual({
      model: 'openai/gpt-5.1-mini',
      messages: options.messages,
      temperature: 0,
      stream: false,
      response_format: responseFormat,
    })
  })

  test('trims the base, forwards tuning options and omits Authorization for keyless custom bases', async () => {
    const { fetch, calls } = fakeFetch(() => reply('好'))
    await chatCompletion({
      ...options,
      apiBase: ' http://127.0.0.1:11434/v1// ',
      apiKey: '',
      temperature: 0.3,
      maxTokens: 64,
      fetch,
    })
    const call = only(calls)
    expect(call.url).toBe('http://127.0.0.1:11434/v1/chat/completions')
    expect(call.headers.has('authorization')).toBe(false)
    expect(call.body).toMatchObject({ temperature: 0.3, max_tokens: 64 })
    expect(call.body).not.toHaveProperty('response_format')
  })

  const unusable: [Partial<ChatCompletionOptions>, string][] = [
    [{ apiBase: 'not a URL' }, '格式无效'],
    [{ apiBase: 'https://user:pass@example.com/v1' }, '不含认证信息'],
    [{ apiBase: 'https://example.com/v1?api_key=x' }, '不含认证信息'],
    [{ apiBase: 'ftp://example.com/v1' }, 'HTTP(S)'],
    [{ apiKey: ' ' }, '请填写大模型 API Key'],
    [{ model: ' ' }, '请填写大模型 ID'],
    [{ messages: [] }, '消息不能为空'],
  ]
  test.each(unusable)('rejects unusable options %# before any request', async (overrides, hint) => {
    const { fetch, calls } = fakeFetch(() => reply('{}'))
    await expect(chatCompletion({ ...options, ...overrides, fetch })).rejects.toThrow(hint)
    expect(calls).toHaveLength(0)
  })

  test('reports HTTP failures with a short body snippet and never the key', async () => {
    const body = JSON.stringify({ error: { message: `Invalid key ${KEY}`, trace: 'x'.repeat(500) } })
    const { fetch } = fakeFetch(() => new Response(body, { status: 401, statusText: 'Unauthorized' }))
    const { message } = await failure(chatCompletion({ ...options, fetch }))
    const prefix = '大模型请求失败：HTTP 401 Unauthorized: '
    expect(message).toStartWith(`${prefix}{"error":{"message":"Invalid key ***"`)
    expect(message).not.toContain(KEY)
    expect(message.length).toBe(prefix.length + 200)
  })

  test('reports network failures without the key', async () => {
    const { fetch } = fakeFetch(() => {
      throw new TypeError(`Unable to connect (Bearer ${KEY})`)
    })
    const { message } = await failure(chatCompletion({ ...options, fetch }))
    expect(message).toBe('无法连接大模型：Unable to connect (Bearer ***)')
  })

  const malformed: [Response, string][] = [
    [new Response('<html>502 Bad Gateway</html>'), '大模型返回内容不是合法 JSON：<html>502 Bad Gateway</html>'],
    [
      jsonResponse({ error: { message: 'Provider returned error', code: 502 } }),
      '大模型返回错误：Provider returned error',
    ],
    [jsonResponse({ choices: [] }), '缺少 choices'],
    [jsonResponse({ choices: [{ message: { content: null, refusal: 'I cannot help' } }] }), '拒绝回答：I cannot help'],
    [jsonResponse({ choices: [{ message: {} }] }), '缺少 content'],
  ]
  test.each(malformed)('rejects malformed replies %#', async (response, hint) => {
    const { fetch } = fakeFetch(() => response)
    await expect(chatCompletion({ ...options, fetch })).rejects.toThrow(hint)
  })

  test('returns an empty reply as an empty string', async () => {
    const { fetch } = fakeFetch(() => reply(''))
    await expect(chatCompletion({ ...options, fetch })).resolves.toBe('')
  })

  test('times out with a readable error', async () => {
    const { fetch, calls } = fakeFetch(pending)
    await expect(chatCompletion({ ...options, timeoutMs: 20, fetch })).rejects.toThrow('大模型请求超时（0.02 秒）')
    expect(only(calls).signal?.aborted).toBe(true)
  })

  test('passes caller aborts through untouched', async () => {
    const { fetch, calls } = fakeFetch(pending)
    const controller = new AbortController()
    const request = chatCompletion({ ...options, signal: controller.signal, fetch })
    controller.abort()
    await expect(request).rejects.toHaveProperty('name', 'AbortError')
    expect(only(calls).signal?.aborted).toBe(true)
  })

  test('sends nothing when the signal is already aborted', async () => {
    const { fetch, calls } = fakeFetch(() => reply('{}'))
    const request = chatCompletion({ ...options, signal: AbortSignal.abort(), fetch })
    await expect(request).rejects.toHaveProperty('name', 'AbortError')
    expect(calls).toHaveLength(0)
  })
})

describe('extractJsonObject', () => {
  const expected = { probability: 0.9, reason: '固定间隔' }
  const json = JSON.stringify(expected)

  test.each([
    json,
    `\`\`\`json\n${json}\n\`\`\``,
    `\`\`\`\n${json}\n\`\`\``,
    `结果如下：\`\`\`JSON\n${json}\n\`\`\` 备注 {无}`,
    `判断如下：\n${json}\n以上。`,
    `<think>先看 {间隔} 是否固定</think>\n${json}`,
  ])('finds the object in %p', text => {
    expect(extractJsonObject(text)).toEqual(expected)
  })

  test.each(['不是 JSON', '[1, 2]', '{"probability": ', '', 'null'])('returns null for %p', text => {
    expect(extractJsonObject(text)).toBeNull()
  })
})
