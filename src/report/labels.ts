import type { SkipReason } from '@/sources/events'
import type { EvidenceKind, Pattern, Verdict } from '@/types'

export const PATTERN_LABELS: Record<Pattern, string> = {
  loop: '循环独轮车',
  burst: '爆发刷屏',
  template: '模板轮播',
  blend: '跟风机器人',
  flood: '高频重复',
}

export const VERDICT_LABELS: Record<Verdict, string> = {
  spam: '独轮车',
  suspect: '可疑',
  none: '正常',
}

export const EVIDENCE_LABELS: Record<EvidenceKind, string> = {
  'invisible-jitter': '不可见字符',
  'insert-jitter': '插入字符',
  'repeat-jitter': '重复次数抖动',
  periodic: '固定节拍',
  'send-tick': '发送节拍',
  'machine-speed': '机器速度',
  'template-cycle': '模板轮播',
  'trend-trigger': '跟风触发',
  lockstep: '多号同步',
  volume: '刷屏量',
}

/** By `ChatMessage.userType` */
export const USER_TYPE_LABELS: Record<number, string> = { 100: '主播', 1: '房管' }

/** By `ChatMessage.guardType` */
export const GUARD_LABELS: Record<number, string> = { 1: '总督', 2: '提督', 3: '舰长' }

export const SKIP_LABELS: Record<SkipReason, string> = {
  anonymous: '匿名弹幕',
  'auto-danmaku': '红包/天选弹幕',
  mirror: '跨房弹幕',
  empty: '空弹幕',
  mock: '模拟弹幕',
}
