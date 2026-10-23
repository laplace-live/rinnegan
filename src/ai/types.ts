import type { Assessment } from '@/types'

/**
 * - `jev`: a decision model (Typesafe Jev) answering a `noul` probability question, as in LAPLACE Chatterbox
 * - `llm`: any OpenAI-compatible chat-completions endpoint (OpenRouter by default) returning JSON
 */
export type AiProviderKind = 'jev' | 'llm'

/** Jev endpoint flavor: Typesafe's own API (`/systemone`) or OpenRouter's (`/api/alpha/decisions`). */
export type DecisionProtocol = 'typesafe' | 'openrouter'

export interface AiConfig {
  provider: AiProviderKind
  /** Only for `jev` */
  protocol: DecisionProtocol
  apiBase: string
  apiKey: string
  model: string
  /** Per-request timeout, ms */
  timeoutMs: number
  /** Probability at or above which the reviewer agrees the user is running a 独轮车 */
  threshold: number
  /** Reviews allowed per rolling hour, to bound cost */
  maxPerHour: number
}

/** What a reviewer sees about one suspect. */
export interface ReviewInput {
  /** The user's recent messages, oldest first; `offsetSec` is relative to the first */
  messages: { offsetSec: number; text: string }[]
  assessment: Assessment
}

export interface ReviewResult {
  /** e.g. `jev:typesafe/jev-1.13` or `llm:openai/gpt-5.1-mini` */
  provider: string
  /** 0..1 that the user is running a 独轮车 */
  probability: number
  /** `probability >= threshold` */
  agrees: boolean
  /** Short explanation, Chinese when the model gives one */
  reason: string
  latencyMs: number
}

export interface Reviewer {
  readonly label: string
  review(input: ReviewInput, signal?: AbortSignal): Promise<ReviewResult>
}
