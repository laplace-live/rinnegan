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
  volume: '刷屏量',
}
