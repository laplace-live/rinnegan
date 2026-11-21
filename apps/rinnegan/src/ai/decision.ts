import type { ReviewState } from '@/ai/prompt'
import type { AiConfig, DecisionProtocol } from '@/ai/types'
import type { FetchLike } from '@/util/fetch'

import { describeEndpointGap, postJson } from '@/ai/http'
import { REVIEW_GUIDE } from '@/ai/prompt'
import { readPath } from '@/util/guards'

/** Default API base and model per protocol, as in LAPLACE Chatterbox. */
export const DECISION_DEFAULTS: Readonly<Record<DecisionProtocol, { apiBase: string; model: string }>> = {
  typesafe: { apiBase: 'https://api.typesafe.ai/v1', model: 'jev-latest' },
  openrouter: { apiBase: 'https://openrouter.ai/api', model: 'typesafe/jev-1.13' },
}

/** Default per-request timeout, ms. */
export const DECISION_TIMEOUT_MS = 8_000

/** Key of the `noul` question every Jev request asks. */
export const DULUNCHE_QUESTION = 'dulunche'

const SERVICE = '决策模型'
const INSTRUCTIONS = `该用户是否在用脚本或工具刷独轮车？\n${REVIEW_GUIDE}`

export interface DecisionOptions extends Pick<AiConfig, 'protocol' | 'apiBase' | 'apiKey' | 'model'> {
  state: ReviewState
  /** Defaults to {@link DECISION_TIMEOUT_MS} */
  timeoutMs?: number
  signal?: AbortSignal
  fetch?: FetchLike
}

/** Narrow an untyped protocol string to a supported one. */
export function isDecisionProtocol(value: string): value is DecisionProtocol {
  return Object.hasOwn(DECISION_DEFAULTS, value)
}

/** Why the protocol, base, key or model can't be called, or null. */
export function describeDecisionGap(
  options: Pick<AiConfig, 'protocol' | 'apiBase' | 'apiKey' | 'model'>
): string | null {
  if (!isDecisionProtocol(options.protocol)) return '不支持的决策模型协议，可选 typesafe 或 openrouter'
  const gap = describeEndpointGap(SERVICE, options.apiBase, options.apiKey)
  if (gap) return gap
  return options.model.trim() ? null : '请填写决策模型 ID'
}

/** `{base}/systemone` for Typesafe; `{base}/alpha/decisions` for OpenRouter, minus a trailing `/v1`. */
function endpoint(protocol: DecisionProtocol, apiBase: string): string {
  const base = new URL(apiBase.trim())
  let path = base.pathname.replace(/\/+$/, '')
  if (protocol === 'openrouter') {
    path = path.replace(/\/v1$/, '')
    if (!path && base.hostname === 'openrouter.ai') path = '/api'
    path += '/alpha/decisions'
  } else {
    path += '/systemone'
  }
  base.pathname = path
  return base.toString()
}

/** The `dulunche` probability in a Jev reply, or null unless it is a `noul` answer within [0, 1]. */
export function readNoulAnswer(json: unknown): number | null {
  const answer = readPath(json, 'answers', DULUNCHE_QUESTION)
  const probability = readPath(answer, 'noul')
  if (readPath(answer, 'type') !== 'noul' || typeof probability !== 'number' || !Number.isFinite(probability)) {
    return null
  }
  return probability >= 0 && probability <= 1 ? probability : null
}

/** Ask Jev how likely the user in `state` is running a 独轮车; resolves to a probability in [0, 1]. */
export async function evaluateDecision(options: DecisionOptions): Promise<number> {
  const gap = describeDecisionGap(options)
  if (gap) throw new Error(gap)
  const json = await postJson({
    service: SERVICE,
    url: endpoint(options.protocol, options.apiBase),
    apiKey: options.apiKey,
    body: {
      model: options.model.trim(),
      state: options.state,
      questions: { [DULUNCHE_QUESTION]: { type: 'noul', instructions: INSTRUCTIONS } },
    },
    timeoutMs: options.timeoutMs ?? DECISION_TIMEOUT_MS,
    signal: options.signal,
    fetch: options.fetch,
  })
  const probability = readNoulAnswer(json)
  if (probability === null) throw new Error('决策模型返回的独轮车判断无效')
  return probability
}
