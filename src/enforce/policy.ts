import type { BanConfig } from '@/config'
import type { Assessment } from '@/types'

import { stripEvasionChars } from '@/detect/normalize'
import { PATTERN_LABELS } from '@/report/labels'

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

/** Fill the ban reason template; the client caps the final length. */
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
  return template.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match).trim()
}
