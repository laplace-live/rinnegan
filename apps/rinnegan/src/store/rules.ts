import type { BanRecord, BanRule, RuleDecision } from '@/store/types'
import type { SpendEvent } from '@/types'

/** Name of {@link expiryRule}; bans it lifts end as `expired` rather than `lifted`. */
export const EXPIRY_RULE = 'expiry'

/** Name of {@link spendToUnbanRule}. */
export const SPEND_TO_UNBAN_RULE = 'spend-to-unban'

const KEEP: RuleDecision = { action: 'keep' }

/** Which rule hook {@link evaluateRules} runs. */
export type RuleHook = { type: 'spend'; event: SpendEvent } | { type: 'tick'; now: number }

/** A decision other than `keep`, tagged with the name of the rule that made it. */
export type RuleOutcome = Exclude<RuleDecision, { action: 'keep' }> & { rule: string }

/** Lifts a ban once its `expiresAt` has passed; permanent bans are kept. */
export function expiryRule(): BanRule {
  return {
    name: EXPIRY_RULE,
    onTick: (ban, now) =>
      ban.expiresAt !== null && ban.expiresAt <= now ? { action: 'lift', reason: 'expired' } : KEEP,
    tickScope: 'due',
  }
}

/**
 * Lifts a ban once the user has spent `thresholdCny` in the room since it was placed; disabled when `thresholdCny <= 0`.
 * Also checked on every tick, so a lift that failed is retried.
 */
export function spendToUnbanRule(thresholdCny: number): BanRule {
  const decide = (ban: BanRecord): RuleDecision =>
    thresholdCny > 0 && ban.spend >= thresholdCny
      ? { action: 'lift', reason: `累计消费 ¥${ban.spend.toFixed(2)} ≥ ¥${formatCny(thresholdCny)}，自动解除禁言` }
      : KEEP
  return { name: SPEND_TO_UNBAN_RULE, onSpend: decide, onTick: decide }
}

/** First decision other than `keep` from `rules` in order; null when every rule keeps the ban. */
export function evaluateRules(rules: readonly BanRule[], ban: BanRecord, hook: RuleHook): RuleOutcome | null {
  for (const rule of rules) {
    const decision = hook.type === 'spend' ? rule.onSpend?.(ban, hook.event) : rule.onTick?.(ban, hook.now)
    if (decision && decision.action !== 'keep') return { ...decision, rule: rule.name }
  }
  return null
}

function formatCny(amount: number): string {
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2)
}
