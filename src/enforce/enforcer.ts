import type { Reviewer, ReviewResult } from '@/ai/types'
import type { AuditLog } from '@/audit/audit'
import type { BilibiliClient, CredentialProvider } from '@/bilibili'
import type { ApiResult } from '@/bilibili/types'
import type { AiMode, BanConfig } from '@/config'
import type { BanRecord, BanStore } from '@/store/types'
import type { Assessment, Sample } from '@/types'

import { isAlreadyBanned, isAuthFailure, isNotBanned } from '@/bilibili'
import { escapeInvisible } from '@/detect/normalize'
import { exemptionReason, formatReason } from '@/enforce/policy'
import { PATTERN_LABELS } from '@/report/labels'

/** Gap between consecutive calls to Bilibili's moderation APIs. */
const API_GAP_MS = 1200
/** Suspects at or above this score are offered to the reviewer in `assist` mode. */
const ASSIST_MIN_SCORE = 75
/** Partial automation evidence an `assist` escalation still needs; the reviewer never bans on repetition alone. */
const ASSIST_MIN_AUTOMATION = 0.5
/** Re-review a user only after their score climbed this much. */
const REVIEW_RETRY_SCORE = 10
/** Wait before retrying a ban the API refused. */
const FAILURE_BACKOFF_MS = 60_000

export interface EnforcerOptions {
  ban: BanConfig
  /** Why bans are simulated, or null when they are real */
  dryRunReason: string | null
  client: BilibiliClient | null
  credentials: CredentialProvider | null
  store: BanStore
  audit: AuditLog
  reviewer: Reviewer | null
  aiMode: AiMode
  operatorUid: number | null
  windowMs: number
  print: (line: string, level?: 'info' | 'warn' | 'error' | 'ban') => void
  now?: () => number
  /** Gap between moderation API calls, ms (default 1200) */
  apiGapMs?: number
}

export interface EnforcerStats {
  banned: number
  simulated: number
  failed: number
  skipped: number
  reviews: number
  vetoed: number
}

type Outcome = 'banned' | 'simulated' | 'failed' | 'skipped' | 'vetoed' | 'pending'

/** Turns `spam` verdicts into bans: exemptions, de-duplication, AI review, safety brake, then the API. */
export class Enforcer {
  readonly #options: EnforcerOptions
  readonly #now: () => number
  /** Users already dealt with this session (`room:uid`) */
  readonly #handled = new Set<string>()
  readonly #inFlight = new Set<string>()
  /** Last exemption logged per user, so a skip is audited once */
  readonly #exempted = new Map<string, string>()
  /** Score at the last review per user */
  readonly #reviewed = new Map<string, number>()
  /** Room → uids on its silent list, when it could be read */
  readonly #remoteBanned = new Map<number, Set<number>>()
  /** Rooms this account can't moderate; bans there are simulated */
  readonly #unmanaged = new Map<number, string>()
  readonly #preparing = new Map<number, Promise<void>>()
  /** Last refused ban per user */
  readonly #failedAt = new Map<string, number>()
  readonly #recentBans: { roomId: number; at: number }[] = []
  #queue: Promise<unknown> = Promise.resolve()
  #lastCallAt = 0
  #halted: string | null = null
  readonly stats: EnforcerStats = { banned: 0, simulated: 0, failed: 0, skipped: 0, reviews: 0, vetoed: 0 }

  constructor(options: EnforcerOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
  }

  get dryRun(): boolean {
    return this.#options.dryRunReason !== null
  }

  /** Read the room's silent list once: skips users already banned and proves this account may moderate the room. */
  prepareRoom(roomId: number): Promise<void> {
    let pending = this.#preparing.get(roomId)
    if (!pending) {
      pending = this.#prepare(roomId)
      this.#preparing.set(roomId, pending)
    }
    return pending
  }

  async #prepare(roomId: number): Promise<void> {
    const { client, audit, print } = this.#options
    if (!client || this.dryRun) return
    try {
      const users = await this.#call(() => client.getAllSilentUsers(roomId))
      this.#remoteBanned.set(roomId, new Set(users.map(user => user.uid)))
      audit.write('room-ready', { roomId, silentUsers: users.length })
      print(`房间 ${roomId}：已读取禁言列表（${users.length} 人），封禁已启用`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#unmanaged.set(roomId, message)
      audit.write('room-unmanaged', { roomId, error: message })
      print(`房间 ${roomId}：无法读取禁言列表（${message}），当前账号可能不是主播或房管，该房间仅检测不封禁`, 'warn')
    }
  }

  /** Bilibili reported a ban in this room (user-block event); never ban the same user twice. */
  noteBlocked(roomId: number, uid: number): void {
    let set = this.#remoteBanned.get(roomId)
    if (!set) {
      set = new Set()
      this.#remoteBanned.set(roomId, set)
    }
    set.add(uid)
  }

  /** Act on a changed assessment. Resolves once any ban attempt for it has finished. */
  async consider(assessment: Assessment, recent: Sample[]): Promise<Outcome> {
    const key = `${assessment.roomId}:${assessment.uid}`
    if (this.#handled.has(key) || this.#inFlight.has(key)) return 'skipped'
    const failedAt = this.#failedAt.get(key)
    if (failedAt !== undefined && this.#now() - failedAt < FAILURE_BACKOFF_MS) return 'skipped'
    const { ban, aiMode, reviewer, audit } = this.#options

    const exempt = exemptionReason(assessment, ban)
    if (exempt) {
      if (assessment.verdict === 'spam' && this.#exempted.get(key) !== exempt) {
        this.#exempted.set(key, exempt)
        this.stats.skipped++
        audit.write('skip', { ...identity(assessment), reason: 'exempt', detail: exempt, score: assessment.score })
        this.#options.print(`跳过 ${label(assessment)}：${exempt}`)
      }
      return 'skipped'
    }

    const automation = proofOf(assessment)
    const assist =
      aiMode === 'assist' &&
      reviewer !== null &&
      assessment.verdict === 'suspect' &&
      assessment.score >= ASSIST_MIN_SCORE &&
      automation >= ASSIST_MIN_AUTOMATION
    if (assessment.verdict !== 'spam' && !assist) return 'skipped'

    this.#inFlight.add(key)
    try {
      await this.prepareRoom(assessment.roomId)
      if (this.#remoteBanned.get(assessment.roomId)?.has(assessment.uid)) {
        return this.#skip(key, assessment, 'already-banned', '已在禁言列表中')
      }
      const active = await this.#options.store.findActive(assessment.roomId, assessment.uid).catch(() => null)
      if (active) return this.#skip(key, assessment, 'already-banned', `已有封禁记录 ${active.id}`)

      const needsReview = reviewer !== null && (aiMode === 'confirm' || assist)
      let review: ReviewResult | null = null
      if (needsReview) {
        const last = this.#reviewed.get(key)
        if (last !== undefined && assessment.score < last + REVIEW_RETRY_SCORE) return 'skipped'
        this.#reviewed.set(key, assessment.score)
        review = await this.#review(assessment, recent)
        if (!review) return 'skipped'
        if (!review.agrees) {
          this.stats.vetoed++
          audit.write('veto', { ...identity(assessment), score: assessment.score, review })
          this.#options.print(
            `AI 未确认 ${label(assessment)}：${(review.probability * 100).toFixed(0)}%，${review.reason}`,
            'warn'
          )
          return 'vetoed'
        }
      }

      const brake = this.#brake(assessment.roomId)
      if (brake) {
        audit.write('brake', { ...identity(assessment), score: assessment.score, reason: brake })
        this.#options.print(`安全刹车：${brake}，未封禁 ${label(assessment)}`, 'warn')
        return 'pending'
      }
      return await this.#ban(key, assessment, review)
    } finally {
      this.#inFlight.delete(key)
    }
  }

  #skip(key: string, assessment: Assessment, reason: string, detail: string): Outcome {
    this.#handled.add(key)
    this.stats.skipped++
    this.#options.audit.write('skip', { ...identity(assessment), reason, detail, score: assessment.score })
    return 'skipped'
  }

  async #review(assessment: Assessment, recent: Sample[]): Promise<ReviewResult | null> {
    const { reviewer, audit, print } = this.#options
    if (!reviewer) return null
    const first = recent[0]?.timestamp ?? assessment.at
    this.stats.reviews++
    try {
      const review = await reviewer.review({
        uname: assessment.uname,
        roomId: assessment.roomId,
        messages: recent.map(sample => ({
          offsetSec: Math.round((sample.timestamp - first) / 100) / 10,
          text: sample.text,
        })),
        assessment,
      })
      audit.write('review', { ...identity(assessment), score: assessment.score, review })
      return review
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      audit.write('review-error', { ...identity(assessment), error: message })
      print(`AI 复核失败 ${label(assessment)}：${message}，本次不封禁`, 'warn')
      return null
    }
  }

  /** Why bans must pause right now, or null. */
  #brake(roomId: number): string | null {
    const { ban } = this.#options
    if (this.#halted) return this.#halted
    const total = this.stats.banned + this.stats.simulated
    if (total >= ban.maxPerSession) {
      this.#halted = `本次运行已封禁 ${total} 人，达到上限 ${ban.maxPerSession}`
      return this.#halted
    }
    const now = this.#now()
    while (this.#recentBans.length && now - (this.#recentBans[0] as { at: number }).at > 60_000)
      this.#recentBans.shift()
    const lastMinute = this.#recentBans.filter(item => item.roomId === roomId).length
    if (lastMinute >= ban.maxPerMinute) return `房间 ${roomId} 一分钟内已封禁 ${lastMinute} 人`
    return null
  }

  async #ban(key: string, assessment: Assessment, review: ReviewResult | null): Promise<Outcome> {
    const { ban, client, audit, print, windowMs } = this.#options
    const reason = formatReason(ban.reasonTemplate, assessment, windowMs)
    const unmanaged = this.#unmanaged.get(assessment.roomId)
    const simulated = this.#options.dryRunReason ?? (unmanaged ? `房间不可管理：${unmanaged}` : null)
    const entry = {
      ...identity(assessment),
      score: assessment.score,
      pattern: assessment.pattern,
      repeats: assessment.repeats,
      reason,
      hours: ban.hours,
      evidence: assessment.evidence,
      clusters: assessment.clusters,
      review,
    }
    this.#recentBans.push({ roomId: assessment.roomId, at: this.#now() })

    if (simulated || !client) {
      this.#handled.add(key)
      this.stats.simulated++
      audit.write('ban', { ...entry, dryRun: true, dryRunReason: simulated ?? 'no client' })
      print(`[演练] 将封禁 ${label(assessment)} · ${reason}`, 'ban')
      return 'simulated'
    }

    let result = await this.#call(() => client.addSilentUser(assessment.roomId, assessment.uid, reason, ban.hours))
    if (!result.ok && isAuthFailure(result) && this.#options.credentials) {
      this.#options.credentials.invalidate()
      audit.write('credentials-refresh', { reason: `${result.code} ${result.message}` })
      result = await this.#call(() => client.addSilentUser(assessment.roomId, assessment.uid, reason, ban.hours))
    }
    const already = !result.ok && isAlreadyBanned(result)
    if (!result.ok && !already) {
      this.#failedAt.set(key, this.#now())
      this.stats.failed++
      audit.write('ban-failed', { ...entry, result: brief(result) })
      print(`封禁失败 ${label(assessment)}：${result.code} ${result.message}`, 'error')
      return 'failed'
    }

    this.#handled.add(key)
    this.#failedAt.delete(key)
    this.noteBlocked(assessment.roomId, assessment.uid)
    this.stats.banned++
    const now = this.#now()
    const record: BanRecord = {
      id: crypto.randomUUID(),
      roomId: assessment.roomId,
      uid: assessment.uid,
      uname: assessment.uname,
      reason,
      score: assessment.score,
      pattern: assessment.pattern,
      evidence: { evidence: assessment.evidence, clusters: assessment.clusters, review },
      createdAt: now,
      expiresAt: ban.expireAfterHours > 0 ? now + ban.expireAfterHours * 3_600_000 : null,
      hours: ban.hours,
      status: 'active',
      liftedAt: null,
      liftReason: null,
      spend: 0,
      operatorUid: this.#options.operatorUid,
      meta: already ? { alreadyBanned: true } : {},
    }
    try {
      await this.#options.store.add(record)
    } catch (error) {
      audit.write('store-error', { banId: record.id, error: error instanceof Error ? error.message : String(error) })
    }
    audit.write('ban', { ...entry, dryRun: false, banId: record.id, alreadyBanned: already, result: brief(result) })
    print(`已封禁 ${label(assessment)} · ${reason}${already ? '（此前已被禁言）' : ''}`, 'ban')
    return 'banned'
  }

  /** Lift a ban through Bilibili; used by the ban lifecycle (expiry, spend rules) and the `unban` command. */
  readonly lift = async (record: BanRecord, reason: string): Promise<boolean> => {
    const { client, audit, print } = this.#options
    if (!client || this.dryRun) {
      audit.write('unban', { roomId: record.roomId, uid: record.uid, banId: record.id, reason, dryRun: true })
      print(`[演练] 将解除 ${record.uname}（${record.uid}）的禁言：${reason}`)
      return false
    }
    const result = await this.#call(() => client.delSilentUser(record.roomId, record.uid))
    const ok = result.ok || isNotBanned(result)
    audit.write(ok ? 'unban' : 'unban-failed', {
      roomId: record.roomId,
      uid: record.uid,
      uname: record.uname,
      banId: record.id,
      reason,
      result: brief(result),
    })
    if (ok) {
      this.#remoteBanned.get(record.roomId)?.delete(record.uid)
      this.#handled.delete(`${record.roomId}:${record.uid}`)
      print(`已解除 ${record.uname}（${record.uid}）在房间 ${record.roomId} 的禁言：${reason}`)
    } else {
      print(`解除禁言失败 ${record.uname}（${record.uid}）：${result.code} ${result.message}`, 'error')
    }
    return ok
  }

  /** Serialize moderation calls with a minimum gap so a burst of verdicts can't hammer the API. */
  #call<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(async () => {
      const wait = this.#lastCallAt + (this.#options.apiGapMs ?? API_GAP_MS) - Date.now()
      if (wait > 0) await Bun.sleep(wait)
      try {
        return await task()
      } finally {
        this.#lastCallAt = Date.now()
      }
    })
    this.#queue = run.catch(() => undefined)
    return run
  }
}

function proofOf(assessment: Assessment): number {
  let miss = 1
  for (const item of assessment.evidence) if (item.kind !== 'volume') miss *= 1 - item.weight
  return 1 - miss
}

function identity(assessment: Assessment): { roomId: number; uid: number; uname: string } {
  return { roomId: assessment.roomId, uid: assessment.uid, uname: assessment.uname }
}

function label(assessment: Assessment): string {
  const sample = assessment.clusters[0]?.samples[0]?.text ?? ''
  return `${assessment.uname}（${assessment.uid}）${PATTERN_LABELS[assessment.pattern]} ${assessment.score}「${escapeInvisible(sample).slice(0, 24)}」`
}

function brief(result: ApiResult): { ok: boolean; code: number; message: string; status: number } {
  return { ok: result.ok, code: result.code, message: result.message, status: result.status }
}
