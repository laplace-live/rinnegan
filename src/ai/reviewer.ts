import type { ChatCompletionResponseFormat } from '@/ai/llm'
import type { ReviewState } from '@/ai/prompt'
import type { AiConfig, AiProviderKind, Reviewer, ReviewInput, ReviewResult } from '@/ai/types'

import {
  DECISION_DEFAULTS,
  DECISION_TIMEOUT_MS,
  describeDecisionGap,
  evaluateDecision,
  isDecisionProtocol,
} from '@/ai/decision'
import { HttpStatusError } from '@/ai/http'
import { chatCompletion, describeLlmGap, extractJsonObject, LLM_DEFAULT_BASE, LLM_TIMEOUT_MS } from '@/ai/llm'
import { buildReviewMessages, buildReviewState, REVIEW_REPLY_SCHEMA } from '@/ai/prompt'

const HOUR_MS = 3_600_000
const MAX_REASON_LENGTH = 120

/** Defaults per provider: `jev` speaks the Typesafe protocol; `llm` has no default model. */
export const DEFAULT_AI_CONFIG: Readonly<Record<AiProviderKind, Readonly<AiConfig>>> = {
  jev: {
    provider: 'jev',
    protocol: 'typesafe',
    apiBase: DECISION_DEFAULTS.typesafe.apiBase,
    apiKey: '',
    model: DECISION_DEFAULTS.typesafe.model,
    timeoutMs: DECISION_TIMEOUT_MS,
    threshold: 0.8,
    maxPerHour: 60,
  },
  llm: {
    provider: 'llm',
    // Ignored by `llm`
    protocol: 'typesafe',
    apiBase: LLM_DEFAULT_BASE,
    apiKey: '',
    model: '',
    timeoutMs: LLM_TIMEOUT_MS,
    threshold: 0.8,
    maxPerHour: 60,
  },
}

// Strongest first: DeepSeek's own API rejects `json_schema`, and some vendors any `response_format`.
const RESPONSE_FORMATS: (ChatCompletionResponseFormat | undefined)[] = [
  { type: 'json_schema', json_schema: { name: 'dulunche_review', strict: true, schema: REVIEW_REPLY_SCHEMA } },
  { type: 'json_object' },
  undefined,
]

/** Thrown by `review()` once `maxPerHour` reviews started within the last hour. */
export class AiBudgetError extends Error {
  constructor(maxPerHour: number) {
    super(`AI 复核本小时额度已用完（每小时 ${maxPerHour} 次）`)
    this.name = 'AiBudgetError'
  }
}

export interface ReviewerOptions {
  fetch?: typeof fetch
  /** Unix ms clock for the hourly budget and latency */
  now?: () => number
}

/** Narrow an untyped provider string to a supported one. */
export function isAiProviderKind(value: string): value is AiProviderKind {
  return Object.hasOwn(DEFAULT_AI_CONFIG, value)
}

function given<T extends string>(value: T | undefined): T | undefined {
  return (value?.trim() || undefined) as T | undefined
}

function givenNumber(value: number | undefined): number | undefined {
  return value === undefined || Number.isNaN(value) ? undefined : value
}

/** `partial` over its provider's defaults (and, for `jev`, its protocol's); blank strings and NaN count as unset. */
export function resolveAiConfig(partial: Partial<AiConfig> = {}): AiConfig {
  const provider = given(partial.provider) ?? 'jev'
  const defaults = isAiProviderKind(provider) ? DEFAULT_AI_CONFIG[provider] : DEFAULT_AI_CONFIG.jev
  const protocol = given(partial.protocol) ?? defaults.protocol
  const endpoint = provider === 'jev' && isDecisionProtocol(protocol) ? DECISION_DEFAULTS[protocol] : defaults
  return {
    provider,
    protocol,
    apiBase: given(partial.apiBase) ?? endpoint.apiBase,
    apiKey: given(partial.apiKey) ?? defaults.apiKey,
    model: given(partial.model) ?? endpoint.model,
    timeoutMs: givenNumber(partial.timeoutMs) ?? defaults.timeoutMs,
    threshold: givenNumber(partial.threshold) ?? defaults.threshold,
    maxPerHour: givenNumber(partial.maxPerHour) ?? defaults.maxPerHour,
  }
}

/** Why `config` can't be used, as a Chinese hint, or null when it is ready. */
export function describeAiGap(config: AiConfig): string | null {
  if (!isAiProviderKind(config.provider)) return '不支持的 AI 复核类型，可选 jev 或 llm'
  const gap = config.provider === 'jev' ? describeDecisionGap(config) : describeLlmGap(config)
  if (gap) return gap
  if (!(config.threshold > 0 && config.threshold <= 1)) return 'AI 复核阈值须大于 0 且不超过 1'
  if (!(config.timeoutMs > 0 && Number.isFinite(config.timeoutMs))) return 'AI 复核超时须为正数（毫秒）'
  if (!(config.maxPerHour >= 1)) return 'AI 复核每小时上限须至少为 1'
  return null
}

/** A 4xx naming the structured-output directive: the vendor rejects it, not a transient failure. */
function isFormatRejection(err: unknown): boolean {
  return (
    err instanceof HttpStatusError &&
    err.status >= 400 &&
    err.status < 500 &&
    /response_format|json_schema|json_object/i.test(err.snippet)
  )
}

function parseReviewReply(content: string): { probability: number; reason: string } {
  const reply = extractJsonObject(content)
  if (!reply) throw new Error('大模型返回内容无法解析为 JSON')
  const { probability, reason } = reply
  const raw = typeof probability === 'string' && probability.trim() ? Number(probability) : probability
  if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new Error('大模型返回的概率无效')
  const text = typeof reason === 'string' ? reason.replace(/\s+/g, ' ').trim() : ''
  return {
    // Some models answer in percent despite the schema.
    probability: raw > 1 && raw <= 100 ? raw / 100 : raw,
    reason: Array.from(text).slice(0, MAX_REASON_LENGTH).join(''),
  }
}

function describeProbability(probability: number, threshold: number): string {
  // Floored to 0.1% so a probability just under the threshold never prints as equal to it.
  const percent = Math.floor(probability * 1000 + 1e-6) / 10
  return `独轮车概率 ${percent}%（阈值 ${Math.round(threshold * 1000) / 10}%）`
}

/**
 * A {@link Reviewer} for `config`; throws when {@link describeAiGap} finds a problem. Every started review counts
 * toward `maxPerHour`, failed ones included.
 */
export function createReviewer(config: AiConfig, options: ReviewerOptions = {}): Reviewer {
  const gap = describeAiGap(config)
  if (gap) throw new Error(gap)
  const cfg = { ...config }
  const now = options.now ?? Date.now
  const label = `${cfg.provider}:${cfg.model.trim()}`
  const started: number[] = []
  // Index into RESPONSE_FORMATS; a rejected format stays dropped for this reviewer's lifetime.
  let formatLevel = 0

  const reserve = (at: number) => {
    const live = started.findIndex(time => time > at - HOUR_MS)
    started.splice(0, live === -1 ? started.length : live)
    if (started.length >= cfg.maxPerHour) throw new AiBudgetError(cfg.maxPerHour)
    started.push(at)
  }

  const askLlm = async (state: ReviewState, signal?: AbortSignal) => {
    const messages = buildReviewMessages(state)
    for (let level = formatLevel; ; level++) {
      try {
        const content = await chatCompletion({
          apiBase: cfg.apiBase,
          apiKey: cfg.apiKey,
          model: cfg.model,
          messages,
          responseFormat: RESPONSE_FORMATS[level],
          timeoutMs: cfg.timeoutMs,
          signal,
          fetch: options.fetch,
        })
        return parseReviewReply(content)
      } catch (err) {
        if (level >= RESPONSE_FORMATS.length - 1 || !isFormatRejection(err)) throw err
        formatLevel = Math.max(formatLevel, level + 1)
      }
    }
  }

  const ask = async (state: ReviewState, signal?: AbortSignal) => {
    if (cfg.provider === 'llm') return askLlm(state, signal)
    const probability = await evaluateDecision({
      protocol: cfg.protocol,
      apiBase: cfg.apiBase,
      apiKey: cfg.apiKey,
      model: cfg.model,
      state,
      timeoutMs: cfg.timeoutMs,
      signal,
      fetch: options.fetch,
    })
    return { probability, reason: '' }
  }

  return {
    label,
    async review(input: ReviewInput, signal?: AbortSignal): Promise<ReviewResult> {
      signal?.throwIfAborted()
      if (input.messages.length === 0) throw new Error('没有可供复核的弹幕')
      const startedAt = now()
      reserve(startedAt)
      const answer = await ask(buildReviewState(input), signal)
      const probability = Math.min(1, Math.max(0, answer.probability))
      return {
        provider: label,
        probability,
        agrees: probability >= cfg.threshold,
        reason: answer.reason || describeProbability(probability, cfg.threshold),
        latencyMs: Math.max(0, Math.round(now() - startedAt)),
      }
    },
  }
}
