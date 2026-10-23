import type { Reviewer, ReviewResult } from '@/ai/types'
import type { AuditLog } from '@/audit/audit'
import type { BilibiliClient } from '@/bilibili'
import type { ApiResult } from '@/bilibili/types'
import type { AiMode, BanConfig } from '@/config'
import type { BanEligibility } from '@/enforce/policy'
import type { BanRecord, BanStore } from '@/store/types'
import type { Assessment, Sample } from '@/types'

import { formatProbability } from '@/ai'
import { briefResult, describeResult, isAlreadyBanned, isNotBanned } from '@/bilibili'
import { clip, escapeInvisible } from '@/detect/normalize'
import { banEligibility, formatReason } from '@/enforce/policy'
import { PATTERN_LABELS } from '@/report/labels'
import { errorMessage } from '@/util/guards'

/** Gap between consecutive calls to Bilibili's moderation APIs. */
export const API_GAP_MS = 1200
/** Re-review a vetoed user only after their score climbed this much. */
const REVIEW_RETRY_SCORE = 10
/** Wait before retrying a ban the API refused or a review that failed. */
const RETRY_BACKOFF_MS = 60_000
/** How long a ban counts toward the per-room safety brake. */
const BRAKE_WINDOW_MS = 60_000

export interface EnforcerOptions {
  ban: BanConfig
  /** Why bans are simulated, or null when they are real */
  dryRunReason: string | null
  client: BilibiliClient | null
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

/**
 * Where enforcement stands for one user; no entry means never acted on. `waiting` users are retried from `notBefore`
 * on, reusing an agreeing review; `vetoed` ones are reviewed again only once their score climbs past the veto.
 */
type Standing =
  | { phase: 'busy' }
  | { phase: 'waiting'; notBefore: number; approval: ReviewResult | null }
  | { phase: 'vetoed'; score: number }
  | { phase: 'done' }

/** What {@link liftSilentUser} lifts. */
export interface LiftTarget {
  roomId: number
  uid: number
  uname: string
  banId: string | null
}

/** Lift a 禁言 and audit it as `unban` / `unban-failed`; Bilibili saying the user isn't banned counts as lifted. */
export async function liftSilentUser(
  client: BilibiliClient,
  audit: AuditLog,
  target: LiftTarget,
  reason: string
): Promise<{ ok: boolean; result: ApiResult }> {
  const result = await client.delSilentUser(target.roomId, target.uid)
  const ok = result.ok || isNotBanned(result)
  audit.write(ok ? 'unban' : 'unban-failed', { ...target, reason, result: briefResult(result) })
  return { ok, result }
}

/** Turns `spam` verdicts into bans: exemptions, de-duplication, AI review, safety brake, then the API. */
export class Enforcer {
  readonly #options: EnforcerOptions
  readonly #now: () => number
  /** Keyed `room:uid` */
  readonly #users = new Map<string, Standing>()
  /** Last exemption logged per user, so a skip is audited once */
  readonly #exempted = new Map<string, string>()
  /** Room → uids on its silent list, when it could be read */
  readonly #remoteBanned = new Map<number, Set<number>>()
  /** Rooms this account can't moderate; bans there are simulated */
  readonly #unmanaged = new Map<number, string>()
  readonly #preparing = new Map<number, Promise<void>>()
  readonly #recentBans: { roomId: number; at: number }[] = []
  #queue: Promise<unknown> = Promise.resolve()
  #lastCallAt = 0
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
      const message = errorMessage(error)
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

  /**
   * Act on an assessment. Safe to call on every message: users in flight, done or backing off are skipped. Resolves once
   * any ban attempt has finished.
   */
  async consider(assessment: Assessment, recent: Sample[]): Promise<Outcome> {
    const key = `${assessment.roomId}:${assessment.uid}`
    const standing = this.#users.get(key)
    if (standing?.phase === 'busy' || standing?.phase === 'done') return 'skipped'
    if (standing?.phase === 'waiting' && this.#now() < standing.notBefore) return 'skipped'
    const { ban, aiMode, reviewer, audit } = this.#options

    const { action, exempt } = banEligibility(assessment, ban, reviewer ? aiMode : 'off')
    if (exempt) {
      if (this.#exempted.get(key) !== exempt) {
        this.#exempted.set(key, exempt)
        this.stats.skipped++
        audit.write('skip', { ...identity(assessment), reason: 'exempt', detail: exempt, score: assessment.score })
        this.#options.print(`跳过 ${label(assessment)}：${exempt}`)
      }
      return 'skipped'
    }
    if (!action) return 'skipped'
    if (action === 'review' && standing?.phase === 'vetoed' && assessment.score < standing.score + REVIEW_RETRY_SCORE) {
      return 'skipped'
    }
    const approval = standing?.phase === 'waiting' ? standing.approval : null
    if (this.#braked(key, assessment, approval)) return 'pending'

    this.#users.set(key, { phase: 'busy' })
    try {
      return await this.#enforce(key, assessment, recent, action, approval)
    } finally {
      if (this.#users.get(key)?.phase === 'busy') this.#users.delete(key)
    }
  }

  async #enforce(
    key: string,
    assessment: Assessment,
    recent: Sample[],
    action: NonNullable<BanEligibility['action']>,
    approval: ReviewResult | null
  ): Promise<Outcome> {
    const { reviewer, audit, print } = this.#options
    await this.prepareRoom(assessment.roomId)
    if (this.#remoteBanned.get(assessment.roomId)?.has(assessment.uid)) {
      return this.#alreadyBanned(key, assessment, '已在禁言列表中')
    }
    const active = await this.#options.store.findActive(assessment.roomId, assessment.uid).catch(() => null)
    if (active) return this.#alreadyBanned(key, assessment, `已有封禁记录 ${active.id}`)

    let review = approval
    if (action === 'review' && reviewer && !review) {
      review = await this.#review(reviewer, assessment, recent)
      if (!review) {
        this.#users.set(key, { phase: 'waiting', notBefore: this.#now() + RETRY_BACKOFF_MS, approval: null })
        return 'skipped'
      }
      if (!review.agrees) {
        this.#users.set(key, { phase: 'vetoed', score: assessment.score })
        this.stats.vetoed++
        audit.write('veto', { ...identity(assessment), score: assessment.score, review })
        print(`AI 未确认 ${label(assessment)}：${formatProbability(review.probability)}，${review.reason}`, 'warn')
        return 'vetoed'
      }
    }
    // Again: other bans may have landed while this one awaited
    if (this.#braked(key, assessment, review)) return 'pending'
    return this.#ban(key, assessment, review)
  }

  #alreadyBanned(key: string, assessment: Assessment, detail: string): Outcome {
    this.#users.set(key, { phase: 'done' })
    this.stats.skipped++
    this.#options.audit.write('skip', {
      ...identity(assessment),
      reason: 'already-banned',
      detail,
      score: assessment.score,
    })
    return 'skipped'
  }

  async #review(reviewer: Reviewer, assessment: Assessment, recent: Sample[]): Promise<ReviewResult | null> {
    const { audit, print } = this.#options
    const first = recent[0]?.timestamp ?? assessment.at
    this.stats.reviews++
    try {
      const review = await reviewer.review({
        messages: recent.map(sample => ({
          offsetSec: Math.round((sample.timestamp - first) / 100) / 10,
          text: sample.text,
        })),
        assessment,
      })
      audit.write('review', { ...identity(assessment), score: assessment.score, review })
      return review
    } catch (error) {
      const message = errorMessage(error)
      audit.write('review-error', { ...identity(assessment), error: message })
      print(`AI 复核失败 ${label(assessment)}：${message}，本次不封禁`, 'warn')
      return null
    }
  }

  /** When the safety brake is on, park the user until it lifts (audited once per wait) and return true. */
  #braked(key: string, assessment: Assessment, approval: ReviewResult | null): boolean {
    const brake = this.#brake(assessment.roomId)
    if (!brake) return false
    this.#users.set(key, { phase: 'waiting', notBefore: brake.until, approval })
    this.#options.audit.write('brake', { ...identity(assessment), score: assessment.score, reason: brake.reason })
    this.#options.print(`安全刹车：${brake.reason}，未封禁 ${label(assessment)}`, 'warn')
    return true
  }

  /** Why bans must pause and until when (forever once the session cap is hit), or null. */
  #brake(roomId: number): { reason: string; until: number } | null {
    const { ban } = this.#options
    const total = this.stats.banned + this.stats.simulated
    if (total >= ban.maxPerSession) {
      return { reason: `本次运行已封禁 ${total} 人，达到上限 ${ban.maxPerSession}`, until: Number.POSITIVE_INFINITY }
    }
    const now = this.#now()
    while (this.#recentBans.length && now - (this.#recentBans[0] as { at: number }).at >= BRAKE_WINDOW_MS) {
      this.#recentBans.shift()
    }
    const inRoom = this.#recentBans.filter(item => item.roomId === roomId)
    const oldest = inRoom[0]
    if (!oldest || inRoom.length < ban.maxPerMinute) return null
    return { reason: `房间 ${roomId} 一分钟内已封禁 ${inRoom.length} 人`, until: oldest.at + BRAKE_WINDOW_MS }
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
      this.#users.set(key, { phase: 'done' })
      this.stats.simulated++
      audit.write('ban', { ...entry, dryRun: true, dryRunReason: simulated ?? 'no client' })
      print(`[演练] 将封禁 ${label(assessment)} · ${reason}`, 'ban')
      return 'simulated'
    }

    const result = await this.#call(() => client.addSilentUser(assessment.roomId, assessment.uid, reason, ban.hours))
    const already = isAlreadyBanned(result)
    if (!result.ok && !already) {
      this.#users.set(key, { phase: 'waiting', notBefore: this.#now() + RETRY_BACKOFF_MS, approval: review })
      this.stats.failed++
      audit.write('ban-failed', { ...entry, result: briefResult(result) })
      print(`封禁失败 ${label(assessment)}：${describeResult(result)}`, 'error')
      return 'failed'
    }

    this.#users.set(key, { phase: 'done' })
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
      audit.write('store-error', { banId: record.id, error: errorMessage(error) })
    }
    audit.write('ban', {
      ...entry,
      dryRun: false,
      banId: record.id,
      alreadyBanned: already,
      result: briefResult(result),
    })
    print(`已封禁 ${label(assessment)} · ${reason}${already ? '（此前已被禁言）' : ''}`, 'ban')
    return 'banned'
  }

  /** Lift a ban through Bilibili for the ban lifecycle (expiry, spend rules); the user may be banned again later. */
  readonly lift = async (record: BanRecord, reason: string): Promise<boolean> => {
    const { client, audit, print } = this.#options
    if (!client || this.dryRun) {
      audit.write('unban', { roomId: record.roomId, uid: record.uid, banId: record.id, reason, dryRun: true })
      print(`[演练] 将解除 ${record.uname}（${record.uid}）的禁言：${reason}`)
      return false
    }
    const target = { roomId: record.roomId, uid: record.uid, uname: record.uname, banId: record.id }
    const { ok, result } = await this.#call(() => liftSilentUser(client, audit, target, reason))
    if (ok) {
      this.#remoteBanned.get(record.roomId)?.delete(record.uid)
      this.#users.delete(`${record.roomId}:${record.uid}`)
      print(`已解除 ${record.uname}（${record.uid}）在房间 ${record.roomId} 的禁言：${reason}`)
    } else {
      print(`解除禁言失败 ${record.uname}（${record.uid}）：${describeResult(result)}`, 'error')
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

function identity(assessment: Assessment): { roomId: number; uid: number; uname: string } {
  return { roomId: assessment.roomId, uid: assessment.uid, uname: assessment.uname }
}

function label(assessment: Assessment): string {
  const sample = assessment.clusters[0]?.samples[0]?.text ?? ''
  return `${assessment.uname}（${assessment.uid}）${PATTERN_LABELS[assessment.pattern]} ${assessment.score}「${escapeInvisible(clip(sample, 24))}」`
}
