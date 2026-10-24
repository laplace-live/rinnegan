#!/usr/bin/env bun
import { parseArgs } from 'node:util'

import type { AiConfig } from '@/ai/types'
import type { AiMode, ConfigLayer, RinneganConfig } from '@/config'

import {
  configFromEnv,
  configFromFile,
  DEFAULT_CONFIG,
  defined,
  mergeConfig,
  parseIdList,
  parseNumber,
  parsePatterns,
  validateConfig,
} from '@/config'
import { fail, log } from '@/util/console'
import { errorMessage } from '@/util/guards'
import { VERSION } from '@/version'

const HELP = `LAPLACE Rinnegan 輪廻眼 ${VERSION} — 识别并处置 B 站直播间的独轮车

用法
  rinnegan offline <归档.lca...> [选项]   离线检测 LAPLACE Chat 归档，按分数列出独轮车与样本
  rinnegan live [选项]                     连接 LAPLACE Event Fetcher / Event Bridge 实时检测并封禁
  rinnegan bans --room <id> [选项]         查看房间禁言列表与 Rinnegan 封禁记录
  rinnegan unban --room <id> --uid <uid>   解除禁言；--session <id> 撤销某次运行的全部封禁
  rinnegan login [--login-file <path>]     用哔哩哔哩 App 扫码登录，供 live / bans / unban 使用

通用选项
  -c, --config <file>       JSON 配置文件（默认读取 ./rinnegan.config.json）
  -r, --room <ids>          只看这些房间（逗号分隔，可重复）
      --window <分钟>       检测窗口，默认 10
      --spam-score <n>      判定独轮车的分数，默认 90
      --suspect-score <n>   判定可疑的分数，默认 60
      --include-mirror      同时检测跨房弹幕
      --log-dir <dir>       审计日志目录，默认 ./logs
  -h, --help                显示帮助
  -v, --version             显示版本

offline
      --since <时间>        只看此时间之后（如 2026-10-20T20:00）
      --until <时间>        只看此时间之前
      --top <n>             每类最多显示 n 人，默认 30
      --samples <n>         每条内容显示 n 个样本，默认 3
      --spam-only           不显示可疑用户
      --report-dir <dir>    报告目录，默认 ./reports
      --no-report           不写 JSON / Markdown 报告

live
  -u, --url <ws>            事件源地址，默认 ws://localhost:9696（LEF 桥接模式通常为 ws://host:8080）
  -t, --token <token>       事件源令牌（LEF 的 BRIDGE_TOKEN / LEB 的 --auth）
      --login-sync-token <uuid@password>   LAPLACE Login Sync 令牌，优先于扫码登录；两者都没有时自动进入演练模式
      --login-sync-url <url>               Login Sync 服务器，默认 https://login-sync.laplace.cn
      --login-file <path>                  扫码登录的保存位置，默认 data/bilibili-login.json
      --dry-run             只检测、不封禁
      --store <url>         封禁记录：sqlite:<path>（默认 sqlite:data/rinnegan.sqlite）、postgres://…、redis://…、memory:
      --patterns <list>     可封禁的模式：loop,burst,template,blend（默认全部，flood 永不封禁）
      --ban-hours <n>       禁言时长（小时），-1 为永久（默认）
      --expire-after <小时> 由 Rinnegan 在 n 小时后自动解除（默认不解除）
      --reason <模板>       禁言理由，可用 {count} {minutes} {sample} {pattern} {score}
      --exempt-uid <ids>    白名单 UID
      --exempt-guards       不封禁大航海成员
      --exempt-medal <n>    不封禁粉丝牌 ≥ n 级的用户
      --max-per-minute <n>  每房间每分钟最多封禁 n 人（安全刹车，默认 5）
      --max-bans <n>        本次运行最多封禁 n 人（默认 100）
      --unban-spend <元>    被封禁用户在房间内消费满 n 元后自动解除
      --ai <off|confirm|assist>            AI 复核：confirm 封禁前确认，assist 复核高分可疑用户
      --ai-provider <jev|llm>              决策模型 Jev（默认）或 OpenAI 兼容 LLM
      --ai-protocol <openrouter|typesafe>  Jev 的接入方式，默认 openrouter
      --ai-model <id>  --ai-base <url>  --ai-threshold <0-1>   （API Key 用环境变量 RINNEGAN_AI_API_KEY）
      --verbose             打印所有可疑用户的变化
      --status <秒>         状态行间隔，默认 60，0 关闭

bans
      --remote / --local    只看 Bilibili 禁言列表 / 只看本地记录（默认都看）
      --limit <n>           本地记录条数，默认 100

unban
      --uid <ids>           要解除的 UID（可重复）
      --session <id>        撤销审计日志中某次运行的全部真实封禁
      --reason <text>       解除原因
      --dry-run             只列出不执行

环境变量
  LOGIN_SYNC_TOKEN  LOGIN_SYNC_URL  LOGIN_SYNC_AUTH_KEY  RINNEGAN_LOGIN_FILE  RINNEGAN_EVENT_URL  RINNEGAN_EVENT_TOKEN
  RINNEGAN_ROOMS  RINNEGAN_STORE_URL  RINNEGAN_LOG_DIR  RINNEGAN_REPORT_DIR  RINNEGAN_AI_MODE  RINNEGAN_AI_PROVIDER
  RINNEGAN_AI_PROTOCOL  RINNEGAN_AI_BASE  RINNEGAN_AI_API_KEY  RINNEGAN_AI_MODEL  RINNEGAN_AI_THRESHOLD`

const COMMON = {
  config: { type: 'string', short: 'c' },
  room: { type: 'string', short: 'r', multiple: true },
  window: { type: 'string' },
  'spam-score': { type: 'string' },
  'suspect-score': { type: 'string' },
  'include-mirror': { type: 'boolean' },
  'log-dir': { type: 'string' },
  'login-sync-token': { type: 'string' },
  'login-sync-url': { type: 'string' },
  'login-file': { type: 'string' },
  store: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const

const COMMAND_OPTIONS = {
  offline: {
    since: { type: 'string' },
    until: { type: 'string' },
    top: { type: 'string' },
    samples: { type: 'string' },
    'spam-only': { type: 'boolean' },
    'report-dir': { type: 'string' },
    'no-report': { type: 'boolean' },
  },
  live: {
    url: { type: 'string', short: 'u' },
    token: { type: 'string', short: 't' },
    'dry-run': { type: 'boolean' },
    patterns: { type: 'string' },
    'ban-hours': { type: 'string' },
    'expire-after': { type: 'string' },
    reason: { type: 'string' },
    'exempt-uid': { type: 'string', multiple: true },
    'exempt-guards': { type: 'boolean' },
    'exempt-medal': { type: 'string' },
    'max-per-minute': { type: 'string' },
    'max-bans': { type: 'string' },
    'unban-spend': { type: 'string' },
    ai: { type: 'string' },
    'ai-provider': { type: 'string' },
    'ai-protocol': { type: 'string' },
    'ai-model': { type: 'string' },
    'ai-base': { type: 'string' },
    'ai-threshold': { type: 'string' },
    verbose: { type: 'boolean' },
    status: { type: 'string' },
  },
  bans: {
    remote: { type: 'boolean' },
    local: { type: 'boolean' },
    limit: { type: 'string' },
  },
  unban: {
    uid: { type: 'string', multiple: true },
    session: { type: 'string' },
    reason: { type: 'string' },
    'dry-run': { type: 'boolean' },
  },
  login: {},
} as const

type Values = Record<string, string | boolean | string[] | undefined>

/** Not in DEFAULT_CONFIG, so in-process callers such as tests never pick up a real saved login */
const CLI_DEFAULTS: ConfigLayer = { loginFile: 'data/bilibili-login.json' }

/** Local-time parse that accepts `2026-10-20`, `2026-10-20 20:00` and full ISO strings. */
export function parseTime(value: string, label: string): number {
  let text = value.trim().replace(' ', 'T')
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) text += 'T00:00'
  const ms = Date.parse(text)
  if (!Number.isFinite(ms)) throw new Error(`${label} 不是有效时间：${value}`)
  return ms
}

function str(values: Values, name: string): string | undefined {
  const value = values[name]
  return typeof value === 'string' ? value : undefined
}

function list(values: Values, name: string): string[] {
  const value = values[name]
  return Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
}

/** A numeric flag; undefined when absent or empty, like the string flags. */
function numberFlag(values: Values, name: string): number | undefined {
  const value = str(values, name)
  return value ? parseNumber(value, `--${name}`) : undefined
}

/** CLI flags as a config layer (they override file and env); enums are checked by `validateConfig`. */
export function configFromFlags(values: Values): ConfigLayer {
  const text = (name: string) => str(values, name) || undefined
  const number = (name: string) => numberFlag(values, name)
  const ids = (name: string) => {
    const parsed = list(values, name).flatMap(value => parseIdList(value, `--${name}`))
    return parsed.length ? parsed : undefined
  }
  const on = (name: string) => (values[name] ? true : undefined)
  const windowMinutes = number('window')
  const patterns = text('patterns')
  const layer: ConfigLayer = {
    logDir: text('log-dir'),
    reportDir: text('report-dir'),
    storeUrl: text('store'),
    loginFile: text('login-file'),
    unbanSpendCny: number('unban-spend'),
    detector: defined({
      windowMs: windowMinutes === undefined ? undefined : windowMinutes * 60_000,
      spamScore: number('spam-score'),
      suspectScore: number('suspect-score'),
    }),
    live: defined({ url: text('url'), token: text('token'), rooms: ids('room'), includeMirror: on('include-mirror') }),
    loginSync: defined({ token: text('login-sync-token'), baseURL: text('login-sync-url') }),
    ban: defined({
      dryRun: on('dry-run'),
      patterns: patterns === undefined ? undefined : parsePatterns(patterns),
      hours: number('ban-hours'),
      expireAfterHours: number('expire-after'),
      reasonTemplate: text('reason'),
      exemptUids: ids('exempt-uid'),
      exemptGuards: on('exempt-guards'),
      exemptMedalLevel: number('exempt-medal'),
      maxPerMinute: number('max-per-minute'),
      maxPerSession: number('max-bans'),
    }),
    ai: defined({
      mode: text('ai') as AiMode | undefined,
      provider: text('ai-provider') as AiConfig['provider'] | undefined,
      protocol: text('ai-protocol') as AiConfig['protocol'] | undefined,
      model: text('ai-model'),
      apiBase: text('ai-base'),
      threshold: number('ai-threshold'),
    }),
  }
  return defined(layer) ?? {}
}

async function loadConfig(values: Values): Promise<RinneganConfig> {
  const path = str(values, 'config')
  const file = await configFromFile(path ?? 'rinnegan.config.json', path !== undefined)
  const config = mergeConfig(DEFAULT_CONFIG, CLI_DEFAULTS, file, configFromEnv(), configFromFlags(values))
  validateConfig(config)
  return config
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  if (!command || command === 'help' || command === '-h' || command === '--help') {
    log(HELP)
    return 0
  }
  if (command === '-v' || command === '--version' || command === 'version') {
    log(VERSION)
    return 0
  }
  if (!(command in COMMAND_OPTIONS)) {
    fail(`未知命令「${command}」，运行 rinnegan --help 查看用法`)
    return 2
  }
  const name = command as keyof typeof COMMAND_OPTIONS
  const parsed = parseArgs({
    args: rest,
    options: { ...COMMON, ...COMMAND_OPTIONS[name] },
    allowPositionals: name === 'offline',
    strict: true,
  })
  const values = parsed.values as Values
  const { positionals } = parsed
  if (values.help) {
    log(HELP)
    return 0
  }
  const config = await loadConfig(values)

  switch (name) {
    case 'offline': {
      if (positionals.length === 0) {
        fail('请指定至少一个 .lca 归档文件')
        return 2
      }
      const since = str(values, 'since')
      const until = str(values, 'until')
      const { runOffline } = await import('@/commands/offline')
      return runOffline({
        files: positionals,
        config,
        since: since ? parseTime(since, '--since') : undefined,
        until: until ? parseTime(until, '--until') : undefined,
        top: numberFlag(values, 'top') ?? 30,
        samples: numberFlag(values, 'samples') ?? 3,
        suspects: !values['spam-only'],
        writeFiles: !values['no-report'],
      })
    }
    case 'live': {
      const { runLive } = await import('@/commands/live')
      return runLive({
        config,
        verbose: values.verbose === true,
        statusEvery: numberFlag(values, 'status') ?? 60,
      })
    }
    case 'bans': {
      const room = config.live.rooms[0]
      if (!room) {
        fail('请用 --room 指定房间')
        return 2
      }
      const remote = values.remote === true
      const local = values.local === true
      const { runBans } = await import('@/commands/admin')
      return runBans({
        config,
        room,
        remote: remote || !local,
        local: local || !remote,
        limit: numberFlag(values, 'limit') ?? 100,
      })
    }
    case 'unban': {
      const { runUnban } = await import('@/commands/admin')
      return runUnban({
        config,
        room: config.live.rooms[0] ?? null,
        uids: list(values, 'uid').flatMap(value => parseIdList(value, '--uid')),
        session: str(values, 'session') ?? null,
        reason: str(values, 'reason') ?? '手动解除',
        dryRun: values['dry-run'] === true,
      })
    }
    case 'login': {
      const { runLogin } = await import('@/commands/login')
      return runLogin({ config })
    }
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await main(Bun.argv.slice(2))
  } catch (error) {
    fail(errorMessage(error))
    process.exitCode = 1
  }
}

export { main }
