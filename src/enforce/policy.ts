import type { AiMode, BanConfig } from '@/config'
import type { Assessment } from '@/types'

import { normalizeReason } from '@/bilibili/client'
import { stripEvasionChars } from '@/detect/normalize'
import { PATTERN_LABELS } from '@/report/labels'

/** Suspects at or above this score are offered to the reviewer in `assist` mode. */
const ASSIST_MIN_SCORE = 75
/** Partial automation evidence an `assist` escalation still needs; the reviewer never bans on repetition alone. */
const ASSIST_MIN_AUTOMATION = 0.5

/** What live enforcement does with an assessment. */
export interface BanEligibility {
  /** `ban` outright, `review` first and ban only if the AI reviewer agrees, or null to leave the user alone */
  action: 'ban' | 'review' | null
  /** Why policy protects a user who would otherwise be acted on */
  exempt: string | null
}

/** Whether live mode acts on `assessment`; pass `aiMode` `off` when there is no reviewer. */
export function banEligibility(assessment: Assessment, ban: BanConfig, aiMode: AiMode): BanEligibility {
  let action: BanEligibility['action'] = null
  if (assessment.verdict === 'spam') action = aiMode === 'confirm' ? 'review' : 'ban'
  else if (
    aiMode === 'assist' &&
    assessment.verdict === 'suspect' &&
    assessment.score >= ASSIST_MIN_SCORE &&
    assessment.proof >= ASSIST_MIN_AUTOMATION
  ) {
    action = 'review'
  }
  const exempt = action ? exemptionReason(assessment, ban) : null
  return exempt ? { action: null, exempt } : { action, exempt: null }
}

/** Why a judged user must not be banned, or null when policy allows it. */
export function exemptionReason(
  assessment: Pick<Assessment, 'uid' | 'userType' | 'guardType' | 'medalLevel' | 'pattern'>,
  ban: BanConfig
): string | null {
  if (assessment.userType === 100) return '主播'
  if (assessment.userType === 1) return '房管'
  if (ban.exemptUids.includes(assessment.uid)) return '白名单'
  if (ban.exemptGuards && assessment.guardType > 0) return '大航海成员'
  if (ban.exemptMedalLevel > 0 && assessment.medalLevel >= ban.exemptMedalLevel) {
    return `粉丝牌 ${assessment.medalLevel} 级`
  }
  if (!ban.patterns.includes(assessment.pattern)) return `模式「${PATTERN_LABELS[assessment.pattern]}」不在封禁范围`
  return null
}

/** The ban reason exactly as sent to Bilibili: the template filled in, then {@link normalizeReason}. */
export function formatReason(template: string, assessment: Assessment, windowMs: number): string {
  const top = assessment.clusters[0]
  const sample = stripEvasionChars(top?.samples[0]?.text ?? top?.key ?? '').trim()
  const values: Record<string, string> = {
    count: String(top?.count ?? assessment.repeats + 1),
    minutes: String(Math.round(windowMs / 60_000)),
    sample,
    pattern: PATTERN_LABELS[assessment.pattern],
    score: String(Math.round(assessment.score)),
  }
  return normalizeReason(template.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match))
}
