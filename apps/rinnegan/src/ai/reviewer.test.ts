import { describe, expect, test } from 'bun:test'

import type { AiConfig, AiProviderKind, DecisionProtocol } from '@/ai/types'

import { buildReviewMessages, buildReviewState, REVIEW_REPLY_SCHEMA } from '@/ai/prompt'
import { AiBudgetError, createReviewer, DEFAULT_AI_CONFIG, describeAiGap, resolveAiConfig } from '@/ai/reviewer'
import { fakeFetch, jsonResponse, only, pending, SAMPLE_UID, sampleInput } from '@/ai/test-helpers'
import { readPath } from '@/util/guards'

const MINUTE = 60_000
const jev = resolveAiConfig({ protocol: 'typesafe', apiKey: 'ts-test-secret' })
const llm = resolveAiConfig({ provider: 'llm', apiKey: 'sk-or-test-secret', model: 'openai/gpt-5.1-mini' })
const noul = (value: number) => jsonResponse({ answers: { dulunche: { type: 'noul', noul: value } } })
const chat = (content: string) => jsonResponse({ choices: [{ message: { role: 'assistant', content } }] })

describe('resolveAiConfig', () => {
  test('defaults to Jev over OpenRouter', () => {
    expect(resolveAiConfig()).toEqual({
      provider: 'jev',
      protocol: 'openrouter',
      apiBase: 'https://openrouter.ai/api',
      apiKey: '',
      model: 'typesafe/jev-1.13',
      timeoutMs: 8_000,
      threshold: 0.8,
      maxPerHour: 120,
    })
    expect(resolveAiConfig()).toEqual(DEFAULT_AI_CONFIG.jev)
  })

  test('uses the Typesafe endpoint and model for that protocol', () => {
    expect(resolveAiConfig({ protocol: 'typesafe' })).toMatchObject({
      apiBase: 'https://api.typesafe.ai/v1',
      model: 'jev-latest',
    })
  })

  test('gives the LLM its own timeout', () => {
    expect(resolveAiConfig({ provider: 'llm' }).timeoutMs).toBe(30_000)
  })

  test('leaves the LLM model to the user', () => {
    expect(resolveAiConfig({ provider: 'llm' })).toEqual(DEFAULT_AI_CONFIG.llm)
    expect(DEFAULT_AI_CONFIG.llm).toMatchObject({ apiBase: 'https://openrouter.ai/api/v1', model: '' })
  })

  test('treats undefined, blank strings and NaN as unset, and trims the rest', () => {
    const config = resolveAiConfig({
      provider: 'llm',
      apiBase: '  ',
      apiKey: ' sk-1 \n',
      model: undefined,
      threshold: Number.NaN,
      maxPerHour: 5,
    })
    expect(config).toEqual({ ...DEFAULT_AI_CONFIG.llm, apiKey: 'sk-1', maxPerHour: 5 })
  })
})

describe('describeAiGap', () => {
  test.each<[string, AiConfig]>([
    ['Jev over Typesafe', jev],
    ['Jev over OpenRouter', resolveAiConfig({ protocol: 'openrouter', apiKey: 'sk-or-1' })],
    ['a keyless local decision service', { ...jev, apiBase: 'http://127.0.0.1:8080/v1', apiKey: '' }],
    ['an LLM with a model', llm],
    ['a keyless local LLM', { ...llm, apiBase: 'http://localhost:11434/v1', apiKey: '' }],
    ['a threshold of 1', { ...jev, threshold: 1 }],
    ['an unlimited budget', { ...jev, maxPerHour: Number.POSITIVE_INFINITY }],
  ])('accepts %s', (_, config) => {
    expect(describeAiGap(config)).toBeNull()
  })

  test.each<[string, AiConfig, string]>([
    ['a missing Typesafe key', { ...jev, apiKey: ' ' }, '请填写决策模型 API Key'],
    [
      'a missing OpenRouter key for Jev',
      { ...jev, protocol: 'openrouter', apiBase: 'https://openrouter.ai/api', apiKey: '' },
      '请填写决策模型 API Key',
    ],
    ['a missing OpenRouter key for the LLM', { ...llm, apiKey: '' }, '请填写大模型 API Key'],
    ['a missing LLM model', { ...llm, model: ' ' }, '请填写大模型 ID'],
    ['a missing Jev model', { ...jev, model: '' }, '请填写决策模型 ID'],
    ['a blank base', { ...llm, apiBase: '' }, '请填写大模型 API 地址'],
    ['an invalid base', { ...jev, apiBase: 'not a URL' }, '决策模型 API 地址格式无效'],
    ['a non-HTTP base', { ...llm, apiBase: 'file:///tmp/llm' }, 'HTTP(S)'],
    ['credentials in the base', { ...llm, apiBase: 'https://user:pass@example.com/v1' }, '不含认证信息'],
    ['a query in the base', { ...jev, apiBase: 'https://api.typesafe.ai/v1?key=1' }, '不含认证信息'],
    ['a zero threshold', { ...jev, threshold: 0 }, '阈值'],
    ['a threshold above 1', { ...llm, threshold: 1.01 }, '阈值'],
    ['a NaN threshold', { ...jev, threshold: Number.NaN }, '阈值'],
    ['a zero timeout', { ...jev, timeoutMs: 0 }, '超时'],
    ['a zero budget', { ...jev, maxPerHour: 0 }, '每小时上限'],
    ['an unknown provider', { ...jev, provider: 'gpt' as AiProviderKind }, '不支持的 AI 复核类型'],
    ['an unknown protocol', { ...jev, protocol: 'grpc' as DecisionProtocol }, '不支持的决策模型协议'],
  ])('reports %s', (_, config, hint) => {
    expect(describeAiGap(config)).toContain(hint)
  })
})

describe('createReviewer', () => {
  test('refuses unusable configs', () => {
    expect(() => createReviewer({ ...llm, model: '' })).toThrow('请填写大模型 ID')
  })

  test('labels reviewers by provider and model', () => {
    expect(createReviewer(jev).label).toBe('jev:jev-latest')
    expect(createReviewer(resolveAiConfig({ protocol: 'openrouter', apiKey: 'k' })).label).toBe('jev:typesafe/jev-1.13')
    expect(createReviewer(llm).label).toBe('llm:openai/gpt-5.1-mini')
  })
})

describe('Jev reviews', () => {
  test('return the probability, threshold verdict and latency', async () => {
    let clock = 1_000
    const { fetch } = fakeFetch(() => {
      clock += 250
      return noul(0.85)
    })
    const result = await createReviewer(jev, { fetch, now: () => clock }).review(sampleInput())
    expect(result).toEqual({
      provider: 'jev:jev-latest',
      probability: 0.85,
      agrees: true,
      reason: '独轮车概率 85%（阈值 80%）',
      latencyMs: 250,
    })
  })

  test.each([
    [0.8, true, '独轮车概率 80%（阈值 80%）'],
    [0.7999, false, '独轮车概率 79.9%（阈值 80%）'],
    [0.57, false, '独轮车概率 57%（阈值 80%）'],
  ])('agree only at or above the threshold (%p)', async (value, agrees, reason) => {
    const { fetch } = fakeFetch(() => noul(value))
    const result = await createReviewer(jev, { fetch }).review(sampleInput())
    expect(result).toMatchObject({ probability: value, agrees, reason })
  })

  test('send the shared review state without the uid', async () => {
    const { fetch, calls } = fakeFetch(() => noul(0.9))
    await createReviewer(jev, { fetch }).review(sampleInput())
    const { body } = only(calls)
    expect(body.state).toEqual(buildReviewState(sampleInput()))
    expect(JSON.stringify(body)).not.toContain(String(SAMPLE_UID))
  })

  test('use the configured timeout', async () => {
    const { fetch } = fakeFetch(pending)
    const reviewer = createReviewer({ ...jev, timeoutMs: 20 }, { fetch })
    await expect(reviewer.review(sampleInput())).rejects.toThrow('决策模型请求超时')
  })
})

describe('LLM reviews', () => {
  test('ask for strict JSON and read a fenced reply', async () => {
    const { fetch, calls } = fakeFetch(() =>
      chat('```json\n{"probability": 0.93, "reason": "每条都插入 U+00AD，\\n间隔固定 5 秒"}\n```')
    )
    const result = await createReviewer(llm, { fetch }).review(sampleInput())
    expect(result).toMatchObject({
      provider: 'llm:openai/gpt-5.1-mini',
      probability: 0.93,
      agrees: true,
      reason: '每条都插入 U+00AD， 间隔固定 5 秒',
    })
    const call = only(calls)
    expect(call.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(call.headers.get('authorization')).toBe('Bearer sk-or-test-secret')
    expect(call.body.messages).toEqual(buildReviewMessages(buildReviewState(sampleInput())))
    expect(call.body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'dulunche_review', strict: true, schema: REVIEW_REPLY_SCHEMA },
    })
    expect(call.body.temperature).toBe(0)
    expect(JSON.stringify(call.body)).not.toContain(String(SAMPLE_UID))
  })

  test.each([
    ['{"probability": 85, "reason": ""}', 0.85, '独轮车概率 85%（阈值 80%）'],
    ['{"probability": "0.4", "reason": "像是手动跟刷"}', 0.4, '像是手动跟刷'],
    ['{"probability": -0.2, "reason": "正常观众"}', 0, '正常观众'],
    ['{"probability": 250, "reason": "确定"}', 1, '确定'],
  ])('normalize %s', async (content, probability, reason) => {
    const { fetch } = fakeFetch(() => chat(content))
    await expect(createReviewer(llm, { fetch }).review(sampleInput())).resolves.toMatchObject({ probability, reason })
  })

  test.each([
    ['我觉得是独轮车', '无法解析为 JSON'],
    ['{"probability": "high", "reason": "x"}', '概率无效'],
    ['{"reason": "x"}', '概率无效'],
  ])('reject %p', async (content, hint) => {
    const { fetch } = fakeFetch(() => chat(content))
    await expect(createReviewer(llm, { fetch }).review(sampleInput())).rejects.toThrow(hint)
  })

  test('downgrade structured output once the vendor rejects it, and remember', async () => {
    const formats: string[] = []
    const { fetch } = fakeFetch(call => {
      const format = String(readPath(call.body, 'response_format', 'type') ?? 'none')
      formats.push(format)
      if (format === 'none') return chat('{"probability": 0.9, "reason": "固定间隔"}')
      return jsonResponse(
        { error: { message: `This response_format type (${format}) is unavailable now` } },
        { status: 400 }
      )
    })
    const reviewer = createReviewer(llm, { fetch })
    await expect(reviewer.review(sampleInput())).resolves.toMatchObject({ probability: 0.9 })
    await expect(reviewer.review(sampleInput())).resolves.toMatchObject({ probability: 0.9 })
    expect(formats).toEqual(['json_schema', 'json_object', 'none', 'none'])
  })

  test('do not retry other client errors', async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse({ error: { message: 'No auth credentials found' } }, { status: 401 })
    )
    await expect(createReviewer(llm, { fetch }).review(sampleInput())).rejects.toThrow('HTTP 401')
    expect(calls).toHaveLength(1)
  })
})

describe('hourly budget', () => {
  test('caps reviews within any rolling hour', async () => {
    let clock = 0
    const { fetch, calls } = fakeFetch(() => noul(0.9))
    const reviewer = createReviewer({ ...jev, maxPerHour: 2 }, { fetch, now: () => clock })
    await reviewer.review(sampleInput())
    clock = 10 * MINUTE
    await reviewer.review(sampleInput())
    clock = 59 * MINUTE
    await expect(reviewer.review(sampleInput())).rejects.toThrow('AI 复核本小时额度已用完（每小时 2 次）')
    expect(calls).toHaveLength(2)
    clock = 60 * MINUTE
    await reviewer.review(sampleInput())
    await expect(reviewer.review(sampleInput())).rejects.toBeInstanceOf(AiBudgetError)
    clock = 70 * MINUTE
    await reviewer.review(sampleInput())
    expect(calls).toHaveLength(4)
  })

  test('counts failed reviews but not ones refused before starting', async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ error: 'upstream' }, { status: 500 }))
    const reviewer = createReviewer({ ...jev, maxPerHour: 1 }, { fetch, now: () => 0 })
    await expect(reviewer.review(sampleInput(), AbortSignal.abort())).rejects.toHaveProperty('name', 'AbortError')
    await expect(reviewer.review({ ...sampleInput(), messages: [] })).rejects.toThrow('没有可供复核的弹幕')
    await expect(reviewer.review(sampleInput())).rejects.toThrow('HTTP 500')
    await expect(reviewer.review(sampleInput())).rejects.toBeInstanceOf(AiBudgetError)
    expect(calls).toHaveLength(1)
  })
})
