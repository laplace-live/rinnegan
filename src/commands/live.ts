import type { Reviewer } from '@/ai/types'
import type { RinneganConfig } from '@/config'
import type { BanRule } from '@/store/types'
import type { Assessment } from '@/types'
import type { FetchLike } from '@/util/fetch'

import { createReviewer, describeAiGap, resolveAiConfig } from '@/ai'
import { AuditLog } from '@/audit/audit'
import { BilibiliClient } from '@/bilibili'
import { connectLoginSync, openStore } from '@/commands/session'
import { Detector } from '@/detect/detector'
import { clip, escapeInvisible } from '@/detect/normalize'
import { Enforcer } from '@/enforce/enforcer'
import { EVIDENCE_LABELS, PATTERN_LABELS, VERDICT_LABELS } from '@/report/labels'
import { ConnectionState, LiveSource } from '@/sources/live'
import { BanLifecycle, describeStoreUrl, expiryRule, MemoryBanStore, spendToUnbanRule } from '@/store'
import { clock, count, fail, log, style, warn } from '@/util/console'
import { errorMessage } from '@/util/guards'
import { maskUrl } from '@/util/url'
import { VERSION } from '@/version'

export interface LiveOptions {
  config: RinneganConfig
  /** Print every suspect update, not just new verdicts */
  verbose: boolean
  /** Seconds between status lines; 0 disables */
  statusEvery: number
  /** Injected Bilibili/login-sync/AI fetch, for tests */
  fetch?: FetchLike
}

/** A running live session. */
export interface LiveSession {
  detector: Detector
  enforcer: Enforcer
  audit: AuditLog
  source: LiveSource
  /** Disconnect, write the session summary and close the store. */
  stop(reason?: string): Promise<void>
}

function describeAssessment(assessment: Assessment): string {
  const top = assessment.clusters[0]
  const sample = top?.samples[top.samples.length - 1]?.text ?? top?.key ?? ''
  const evidence = assessment.evidence.map(item => EVIDENCE_LABELS[item.kind]).join('、')
  return `${assessment.uname}（${assessment.uid}）房间 ${assessment.roomId} · ${PATTERN_LABELS[assessment.pattern]} · 窗口重复 ${assessment.repeats} · ${evidence || '无自动化证据'} ·「${escapeInvisible(clip(sample, 30))}」`
}

/** Watch live danmaku until SIGINT/SIGTERM. Returns the exit code. */
export async function runLive(options: LiveOptions): Promise<number> {
  const session = await startLive(options)
  if (!session) return 1
  return await new Promise<number>(resolve => {
    const stop = (signal: string) => void session.stop(signal).then(() => resolve(0))
    process.once('SIGINT', () => stop('SIGINT'))
    process.once('SIGTERM', () => stop('SIGTERM'))
  })
}

/** Start judging live danmaku and banning 独轮车 users (simulated without credentials); null when setup failed. */
export async function startLive(options: LiveOptions): Promise<LiveSession | null> {
  const { config } = options
  const audit = new AuditLog({ dir: config.logDir, mode: 'live' })
  const print = (line: string, level: 'info' | 'warn' | 'error' | 'ban' = 'info') => {
    const prefix = style.gray(clock(Date.now()))
    if (level === 'warn') warn(`${clock(Date.now())} ${line}`)
    else if (level === 'error') fail(`${clock(Date.now())} ${line}`)
    else if (level === 'ban') log(`${prefix} ${style.red(style.bold(line))}`)
    else log(`${prefix} ${line}`)
  }

  log(style.bold(`LAPLACE Rinnegan 輪廻眼 ${VERSION} · 实时模式`))

  let dryRunReason: string | null = null
  if (config.ban.dryRun) dryRunReason = '已指定 --dry-run'
  else if (!config.loginSync.token) dryRunReason = '未提供 LOGIN_SYNC_TOKEN'

  // Independent of each other, so started together; reported in a fixed order once all have settled.
  const anonymous = new BilibiliClient({
    credentials: () => ({ cookie: '', csrf: '', uid: null }),
    fetch: options.fetch,
  })
  const [login, resolved, store] = await Promise.all([
    config.loginSync.token
      ? connectLoginSync(config, options.fetch, audit).catch((error: unknown) => new Error(errorMessage(error)))
      : null,
    Promise.allSettled(config.live.rooms.map(room => anonymous.resolveRoom(room))),
    dryRunReason ? new MemoryBanStore() : openStore(config, fail),
  ])
  if (login instanceof Error) {
    fail(`无法使用 Login Sync 凭据：${login.message}`)
    audit.write('session-error', { error: login.message })
    await store?.close().catch(() => undefined)
    return null
  }
  const client = login?.client ?? null
  const operatorUid = login?.nav.uid ?? null
  const operatorName = login?.nav.uname ?? null
  if (login) log(`登录账号 ${operatorName}（${operatorUid}）· ${login.cookies} 个 Cookie`)

  const rooms = config.live.rooms.map((room, index) => {
    const result = resolved[index]
    if (result?.status === 'fulfilled') {
      if (result.value.roomId !== room) log(`房间 ${room} → ${result.value.roomId}`)
      return result.value.roomId
    }
    warn(`无法解析房间 ${room}（${errorMessage(result?.reason)}），按原样使用`)
    return room
  })

  if (!store) return null
  if (!dryRunReason) log(`封禁记录 ${describeStoreUrl(config.storeUrl)}`)

  let reviewer: Reviewer | null = null
  if (config.ai.mode !== 'off') {
    const ai = resolveAiConfig(config.ai)
    const gap = describeAiGap(ai)
    if (gap) {
      fail(`AI 复核配置不完整：${gap}`)
      return null
    }
    reviewer = createReviewer(ai, { fetch: options.fetch })
    log(`AI 复核 ${config.ai.mode === 'confirm' ? '（封禁前确认）' : '（辅助升级可疑用户）'} ${reviewer.label}`)
  }

  const detector = new Detector(config.detector)
  const enforcer = new Enforcer({
    ban: config.ban,
    dryRunReason,
    client,
    store,
    audit,
    reviewer,
    aiMode: config.ai.mode,
    operatorUid,
    windowMs: detector.options.windowMs,
    print,
  })

  const rules: BanRule[] = [expiryRule()]
  if (config.unbanSpendCny > 0) rules.push(spendToUnbanRule(config.unbanSpendCny))
  const lifecycle = new BanLifecycle({
    store,
    rules,
    lift: enforcer.lift,
    onEvent: event => {
      if (event.type === 'error') audit.write('lifecycle-error', { error: String(event.error) })
      else if (event.type === 'spend') {
        audit.write('spend', {
          banId: event.ban.id,
          uid: event.ban.uid,
          spend: event.ban.spend,
          amount: event.event.amount,
        })
      }
    },
  })

  if (dryRunReason) log(style.yellow(`演练模式：${dryRunReason}，只检测不封禁`))
  const sourceUrl = maskUrl(config.live.url)
  log(`事件源 ${sourceUrl} · 房间 ${rooms.length ? rooms.join(', ') : '全部'}`)
  audit.write('session-start', {
    version: VERSION,
    dryRun: dryRunReason !== null,
    dryRunReason,
    operatorUid,
    operatorName,
    source: sourceUrl,
    rooms,
    store: dryRunReason ? 'memory' : describeStoreUrl(config.storeUrl),
    ai: { mode: config.ai.mode, provider: reviewer?.label ?? null },
    detector: detector.options,
    ban: config.ban,
    unbanSpendCny: config.unbanSpendCny,
  })

  // Not awaited: `consider()` waits for its room, and danmaku sent before the source connects are lost
  if (!dryRunReason) for (const room of rooms) void enforcer.prepareRoom(room)

  let judged = 0
  let flagged = 0
  const consider = (assessment: Assessment) =>
    enforcer
      .consider(assessment, detector.recentMessages(assessment.roomId, assessment.uid))
      .catch(error => audit.write('enforce-error', { uid: assessment.uid, error: String(error) }))
  const source = new LiveSource({
    url: config.live.url,
    token: config.live.token,
    rooms,
    includeMirror: config.live.includeMirror,
    onMessage: message => {
      judged++
      const { assessment, changed } = detector.ingest(message)
      // A change always carries a flagged verdict
      if (changed) {
        flagged++
        const verdict = VERDICT_LABELS[assessment.verdict]
        if (assessment.verdict === 'spam' || options.verbose) {
          print(
            `${assessment.verdict === 'spam' ? style.red(verdict) : style.yellow(verdict)} ${assessment.score} ${describeAssessment(assessment)}`
          )
        }
        audit.write('detection', {
          roomId: assessment.roomId,
          uid: assessment.uid,
          uname: assessment.uname,
          verdict: assessment.verdict,
          score: assessment.score,
          pattern: assessment.pattern,
          repeats: assessment.repeats,
          evidence: assessment.evidence,
          clusters: assessment.clusters,
        })
      }
      // Spam re-enters enforcement on every message so a refused or braked ban is retried; it dedupes itself.
      if (changed || assessment.verdict === 'spam') void consider(assessment)
    },
    onSpend: event => {
      void lifecycle.handleSpend(event).catch(error => audit.write('lifecycle-error', { error: String(error) }))
    },
    onBlock: (roomId, uid, uname) => {
      enforcer.noteBlocked(roomId, uid)
      audit.write('user-block', { roomId, uid, uname })
    },
    onState: (state, detail) => {
      const labels: Record<ConnectionState, string> = {
        [ConnectionState.CONNECTED]: '已连接',
        [ConnectionState.CONNECTING]: '连接中',
        [ConnectionState.RECONNECTING]: '重连中',
        [ConnectionState.DISCONNECTED]: '已断开',
      }
      print(`事件源${labels[state]}${detail}`, state === ConnectionState.CONNECTED ? 'info' : 'warn')
      audit.write('connection', { state, detail })
    },
  })

  lifecycle.start(60_000)
  await source.start()

  const status =
    options.statusEvery > 0
      ? setInterval(() => {
          const { banned, simulated, failed, vetoed } = enforcer.stats
          print(
            style.gray(
              `已检测 ${count(judged)} 条 · 跟踪 ${count(detector.trackedUsers)} 人 · 标记 ${flagged} 次 · ${dryRunReason ? `演练封禁 ${simulated}` : `封禁 ${banned}，失败 ${failed}`}${vetoed ? ` · AI 否决 ${vetoed}` : ''}`
            )
          )
        }, options.statusEvery * 1000)
      : null

  let stopping: Promise<void> | null = null
  const stop = (reason = 'stop'): Promise<void> => {
    stopping ??= (async () => {
      if (status) clearInterval(status)
      source.stop()
      // Let in-flight lifts finish before the store closes under them.
      await lifecycle.stop()
      audit.write('session-end', {
        reason,
        messages: judged,
        events: source.stats.events,
        skipped: source.stats.skipped,
        enforcement: enforcer.stats,
        flagged: detector.summaries().map(summary => ({
          uid: summary.uid,
          uname: summary.uname,
          roomId: summary.roomId,
          score: summary.peak.score,
          verdict: summary.peak.verdict,
          pattern: summary.peak.pattern,
        })),
      })
      await store.close().catch(() => undefined)
      log('')
      log(style.gray(`已停止 · 审计日志 ${audit.path}`))
    })()
    return stopping
  }
  return { detector, enforcer, audit, source, stop }
}
