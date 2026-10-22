import { describeEndpointGap, isRecord, postJson, readPath, redact } from '@/ai/http'

/** OpenRouter's OpenAI-compatible API. */
export const LLM_DEFAULT_BASE = 'https://openrouter.ai/api/v1'
/** Default per-request timeout, ms. */
export const LLM_TIMEOUT_MS = 30_000

const SERVICE = '大模型'
const THINK_RE = /<think>[\s\S]*?<\/think>/gi
const FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/gi

/** One OpenAI-style chat message. */
export interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** OpenAI-style structured-output directive; vendor support varies, so replies are still parsed defensively. */
export type ChatCompletionResponseFormat =
  | { type: 'json_object' }
  | { type: 'json_schema'; json_schema: { name: string; strict?: boolean; schema: unknown } }

export interface ChatCompletionOptions {
  /** Defaults to {@link LLM_DEFAULT_BASE}; `/v1` is neither added nor stripped */
  apiBase?: string
  /** May be blank for keyless custom bases */
  apiKey: string
  model: string
  messages: LlmChatMessage[]
  /** Defaults to 0 */
  temperature?: number
  maxTokens?: number
  responseFormat?: ChatCompletionResponseFormat
  /** Defaults to {@link LLM_TIMEOUT_MS} */
  timeoutMs?: number
  signal?: AbortSignal
  fetch?: typeof fetch
}

/** Why the base, key or model can't be called, or null. */
export function describeLlmGap(options: Pick<ChatCompletionOptions, 'apiBase' | 'apiKey' | 'model'>): string | null {
  const gap = describeEndpointGap(SERVICE, options.apiBase ?? LLM_DEFAULT_BASE, options.apiKey)
  if (gap) return gap
  return options.model.trim() ? null : '请填写大模型 ID（如 openai/gpt-5.1-mini）'
}

/** POST `{base}/chat/completions` without streaming and return the first choice's content. */
export async function chatCompletion(options: ChatCompletionOptions): Promise<string> {
  const gap = describeLlmGap(options)
  if (gap) throw new Error(gap)
  if (options.messages.length === 0) throw new Error('大模型消息不能为空')
  const apiKey = options.apiKey.trim()
  const body: Record<string, unknown> = {
    model: options.model.trim(),
    messages: options.messages,
    temperature: options.temperature ?? 0,
    // Explicit to defeat proxies that default to streaming.
    stream: false,
  }
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
  if (options.responseFormat) body.response_format = options.responseFormat

  const json = await postJson({
    service: SERVICE,
    url: `${(options.apiBase ?? LLM_DEFAULT_BASE).trim().replace(/\/+$/, '')}/chat/completions`,
    apiKey,
    body,
    timeoutMs: options.timeoutMs ?? LLM_TIMEOUT_MS,
    signal: options.signal,
    fetch: options.fetch,
  })
  const choices = readPath(json, 'choices')
  if (!Array.isArray(choices) || choices.length === 0) {
    // OpenRouter reports some upstream failures as a 200 carrying `error`.
    const upstream = readPath(json, 'error', 'message')
    if (typeof upstream === 'string') throw new Error(`大模型返回错误：${redact(upstream, apiKey).slice(0, 200)}`)
    throw new Error('大模型返回数据缺少 choices 数组')
  }
  const message = readPath(choices[0], 'message')
  const content = readPath(message, 'content')
  if (typeof content === 'string') return content
  const refusal = readPath(message, 'refusal')
  if (typeof refusal === 'string' && refusal) throw new Error(`大模型拒绝回答：${refusal.slice(0, 200)}`)
  throw new Error('大模型返回数据缺少 content 字段')
}

/** The JSON object in a model reply: bare, inside a ```json fence, or wrapped in prose; null when none parses. */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const reply = text.replace(THINK_RE, '').trim()
  const candidates = [reply, ...Array.from(reply.matchAll(FENCE_RE), match => match[1] ?? '')]
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(reply.slice(start, end + 1))
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate)
      if (isRecord(value) && !Array.isArray(value)) return value
    } catch {
      // try the next candidate
    }
  }
  return null
}
