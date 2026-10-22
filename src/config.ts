import type { AiConfig, AiProviderKind, DecisionProtocol } from '@/ai/types'
import type { DetectorOptions } from '@/detect/detector'
import type { Pattern } from '@/types'

/**
 * How AI review takes part in bans.
 *
 * - `off`: never called
 * - `confirm`: every ban needs the reviewer's agreement first (fewer false positives)
 * - `assist`: high-scoring suspects with partial automation evidence are reviewed and banned when it agrees
 */
export type AiMode = 'off' | 'confirm' | 'assist'

export interface BanConfig {
  /** Never call the ban API even with credentials */
  dryRun: boolean
  /** Patterns eligible for bans */
  patterns: Pattern[]
  /** `hour` sent to Bilibili; -1 is permanent */
  hours: number
  /** Lift bans Rinnegan placed after this many hours (0 keeps them until a rule or an operator lifts them) */
  expireAfterHours: number
  /** Ban reason (`msg`); placeholders `{count}` `{minutes}` `{sample}` `{pattern}` `{score}` */
  reasonTemplate: string
  exemptUids: number[]
  /** Never ban 舰长 / 提督 / 总督 */
  exemptGuards: boolean
  /** Never ban users wearing a fan medal at or above this level (0 disables) */
  exemptMedalLevel: number
  /** Safety brake: bans per room per rolling minute before enforcement pauses */
  maxPerMinute: number
  /** Safety brake: bans per session before enforcement stops */
  maxPerSession: number
}

export interface LiveConfig {
  /** LAPLACE Event Fetcher (bridge mode) or Event Bridge WebSocket URL */
  url: string
  /** Bridge token (`BRIDGE_TOKEN` on the fetcher, `--auth` on the bridge) */
  token: string
  /** Room ids to watch; empty watches everything the source sends */
  rooms: number[]
  /** Judge 跨房弹幕 mirrored from linked rooms too */
  includeMirror: boolean
}

export interface LoginSyncConfig {
  /** `uuid@password` from the LAPLACE Login Sync extension; empty means dry-run */
  token: string
  baseURL: string
  authKey: string
  /** Re-pull cookies this often */
  refreshMinutes: number
}

export interface RinneganConfig {
  logDir: string
  reportDir: string
  detector: Partial<DetectorOptions>
  live: LiveConfig
  loginSync: LoginSyncConfig
  ban: BanConfig
  /** `sqlite:<path>`, `memory:`, `postgres://…` or `redis://…` */
  storeUrl: string
  /** Lift a ban once the user spends this much CNY in the room afterwards (0 disables) */
  unbanSpendCny: number
  ai: AiConfig & { mode: AiMode }
}

export const DEFAULT_CONFIG: RinneganConfig = {
  logDir: 'logs',
  reportDir: 'reports',
  detector: {},
  live: {
    url: 'ws://localhost:9696',
    token: '',
    rooms: [],
    includeMirror: false,
  },
  loginSync: {
    token: '',
    baseURL: 'https://login-sync.laplace.cn',
    authKey: '',
    refreshMinutes: 30,
  },
  ban: {
    dryRun: false,
    patterns: ['loop', 'burst', 'template', 'blend'],
    hours: -1,
    expireAfterHours: 0,
    reasonTemplate: '独轮车 ×{count}：{sample}',
    exemptUids: [],
    exemptGuards: false,
    exemptMedalLevel: 0,
    maxPerMinute: 5,
    maxPerSession: 100,
  },
  storeUrl: 'sqlite:data/rinnegan.sqlite',
  unbanSpendCny: 0,
  ai: {
    mode: 'off',
    provider: 'jev',
    protocol: 'openrouter',
    apiBase: '',
    apiKey: '',
    model: '',
    timeoutMs: 8000,
    threshold: 0.8,
    maxPerHour: 120,
  },
}

/** Partial config as read from a file, env or flags. */
export type ConfigLayer = {
  logDir?: string
  reportDir?: string
  detector?: Partial<DetectorOptions>
  live?: Partial<LiveConfig>
  loginSync?: Partial<LoginSyncConfig>
  ban?: Partial<BanConfig>
  storeUrl?: string
  unbanSpendCny?: number
  ai?: Partial<RinneganConfig['ai']>
}

const PATTERNS: readonly Pattern[] = ['loop', 'burst', 'template', 'blend', 'flood']
const AI_MODES: readonly AiMode[] = ['off', 'confirm', 'assist']
const AI_PROVIDERS: readonly AiProviderKind[] = ['jev', 'llm']
const DECISION_PROTOCOLS: readonly DecisionProtocol[] = ['typesafe', 'openrouter']

/** Comma/space separated positive integers; throws on anything else. */
export function parseIdList(value: string, label: string): number[] {
  const ids: number[] = []
  for (const part of value.split(/[\s,，]+/)) {
    if (!part) continue
    const id = Number(part)
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`${label} 中的「${part}」不是有效的正整数`)
    ids.push(id)
  }
  return ids
}

export function parseNumber(value: string, label: string): number {
  const number = Number(value)
  if (!value.trim() || !Number.isFinite(number)) throw new Error(`${label} 需要数字，收到「${value}」`)
  return number
}

/** Comma separated detector patterns. */
export function parsePatterns(value: string): Pattern[] {
  const patterns = value.split(/[\s,，]+/).filter(Boolean)
  for (const pattern of patterns) {
    if (!PATTERNS.includes(pattern as Pattern))
      throw new Error(`未知的模式「${pattern}」，可选：${PATTERNS.join(', ')}`)
  }
  return patterns as Pattern[]
}

function pick<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if (!allowed.includes(value as T)) throw new Error(`${label} 只能是 ${allowed.join(' / ')}，收到「${value}」`)
  return value as T
}

/** Config layer from environment variables (Bun loads `.env` automatically). */
export function configFromEnv(env: Record<string, string | undefined> = process.env): ConfigLayer {
  const layer: ConfigLayer = {}
  const live: Partial<LiveConfig> = {}
  const loginSync: Partial<LoginSyncConfig> = {}
  const ai: Partial<RinneganConfig['ai']> = {}
  const set = (name: string, apply: (value: string) => void) => {
    const value = env[name]?.trim()
    if (value) apply(value)
  }
  set('RINNEGAN_EVENT_URL', value => {
    live.url = value
  })
  set('RINNEGAN_EVENT_TOKEN', value => {
    live.token = value
  })
  set('RINNEGAN_ROOMS', value => {
    live.rooms = parseIdList(value, 'RINNEGAN_ROOMS')
  })
  set('LOGIN_SYNC_TOKEN', value => {
    loginSync.token = value
  })
  set('LOGIN_SYNC_URL', value => {
    loginSync.baseURL = value
  })
  set('LOGIN_SYNC_AUTH_KEY', value => {
    loginSync.authKey = value
  })
  set('RINNEGAN_STORE_URL', value => {
    layer.storeUrl = value
  })
  set('RINNEGAN_LOG_DIR', value => {
    layer.logDir = value
  })
  set('RINNEGAN_REPORT_DIR', value => {
    layer.reportDir = value
  })
  set('RINNEGAN_AI_MODE', value => {
    ai.mode = pick(value, AI_MODES, 'RINNEGAN_AI_MODE')
  })
  set('RINNEGAN_AI_PROVIDER', value => {
    ai.provider = pick(value, AI_PROVIDERS, 'RINNEGAN_AI_PROVIDER')
  })
  set('RINNEGAN_AI_PROTOCOL', value => {
    ai.protocol = pick(value, DECISION_PROTOCOLS, 'RINNEGAN_AI_PROTOCOL')
  })
  set('RINNEGAN_AI_BASE', value => {
    ai.apiBase = value
  })
  set('RINNEGAN_AI_API_KEY', value => {
    ai.apiKey = value
  })
  set('RINNEGAN_AI_MODEL', value => {
    ai.model = value
  })
  set('RINNEGAN_AI_THRESHOLD', value => {
    ai.threshold = parseNumber(value, 'RINNEGAN_AI_THRESHOLD')
  })
  if (Object.keys(live).length) layer.live = live
  if (Object.keys(loginSync).length) layer.loginSync = loginSync
  if (Object.keys(ai).length) layer.ai = ai
  return layer
}

/** Read a JSON config file shaped like {@link ConfigLayer}; missing optional file → empty layer. */
export async function configFromFile(path: string, required: boolean): Promise<ConfigLayer> {
  const file = Bun.file(path)
  if (!(await file.exists())) {
    if (required) throw new Error(`找不到配置文件：${path}`)
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(await file.text())
  } catch (error) {
    throw new Error(`配置文件 ${path} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`配置文件 ${path} 必须是 JSON 对象`)
  }
  return parsed as ConfigLayer
}

/** Later layers win; nested sections merge key by key. */
export function mergeConfig(base: RinneganConfig, ...layers: ConfigLayer[]): RinneganConfig {
  const out: RinneganConfig = structuredClone(base)
  for (const layer of layers) {
    if (layer.logDir !== undefined) out.logDir = layer.logDir
    if (layer.reportDir !== undefined) out.reportDir = layer.reportDir
    if (layer.storeUrl !== undefined) out.storeUrl = layer.storeUrl
    if (layer.unbanSpendCny !== undefined) out.unbanSpendCny = layer.unbanSpendCny
    if (layer.detector) out.detector = { ...out.detector, ...layer.detector }
    if (layer.live) out.live = { ...out.live, ...layer.live }
    if (layer.loginSync) out.loginSync = { ...out.loginSync, ...layer.loginSync }
    if (layer.ban) out.ban = { ...out.ban, ...layer.ban }
    if (layer.ai) out.ai = { ...out.ai, ...layer.ai }
  }
  return out
}

/** Sanity checks that would otherwise surface as confusing runtime behaviour. */
export function validateConfig(config: RinneganConfig): void {
  const { ban, detector, ai } = config
  if (!Number.isInteger(ban.hours) || (ban.hours !== -1 && ban.hours <= 0)) {
    throw new Error('ban.hours 只能是 -1（永久）或正整数小时')
  }
  if (ban.expireAfterHours < 0) throw new Error('ban.expireAfterHours 不能为负')
  if (ban.maxPerMinute < 1 || ban.maxPerSession < 1) throw new Error('ban.maxPerMinute / maxPerSession 至少为 1')
  if (!Array.isArray(ban.patterns)) throw new Error('ban.patterns 必须是数组')
  for (const pattern of ban.patterns) pick(pattern, PATTERNS, 'ban.patterns')
  if (detector.spamScore !== undefined && (detector.spamScore <= 0 || detector.spamScore > 100)) {
    throw new Error('detector.spamScore 必须在 (0, 100] 之间')
  }
  if (detector.windowMs !== undefined && detector.windowMs < 60_000) throw new Error('detector.windowMs 至少为 60000')
  pick(ai.mode, AI_MODES, 'ai.mode')
  if (config.unbanSpendCny < 0) throw new Error('unbanSpendCny 不能为负')
}
