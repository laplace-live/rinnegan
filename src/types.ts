/** A danmaku normalized from a LaplaceEvent `message`, shared by the live and offline pipelines. */
export interface ChatMessage {
  /** LaplaceEvent id */
  id: string
  /** Canonical (long) room id the danmaku was sent to */
  roomId: number
  uid: number
  uname: string
  text: string
  /** Unix ms */
  timestamp: number
  /** 0 viewer, 1 room admin, 100 streamer */
  userType: number
  /** 0 none, 1 总督, 2 提督, 3 舰长 */
  guardType: number
  /** Sticker danmaku; `text` is the sticker name */
  isEmote: boolean
  /** Fan medal level, 0 when none is worn */
  medalLevel: number
  /** @-reply to another viewer */
  isReply: boolean
}

/** A paid event (gift, SuperChat, guard) used by conditional unban rules. */
export interface SpendEvent {
  id: string
  roomId: number
  uid: number
  uname: string
  /** Real currency (CNY) value */
  amount: number
  kind: 'gift' | 'superchat' | 'guard'
  timestamp: number
}

/** Detector confidence that a user is running a 独轮车. */
export type Verdict = 'none' | 'suspect' | 'spam'

/**
 * Behaviour pattern behind a detection.
 *
 * - `loop`: one line resent on a timer (独轮车)
 * - `burst`: same content fired at machine speed with dedup-bypass variants
 * - `template`: several lines cycled in order
 * - `blend`: trend-following bot (chatterbox 自动融入) that sends whatever the room is spamming
 * - `flood`: heavy repetition without automation evidence
 */
export type Pattern = 'loop' | 'burst' | 'template' | 'blend' | 'flood'

export type EvidenceKind =
  | 'invisible-jitter'
  | 'insert-jitter'
  | 'repeat-jitter'
  | 'periodic'
  | 'send-tick'
  | 'machine-speed'
  | 'template-cycle'
  | 'trend-trigger'
  | 'volume'

export interface Evidence {
  kind: EvidenceKind
  /** 0..1 confidence that this signal alone proves automation */
  weight: number
  /** Human-readable explanation */
  detail: string
}

export interface Sample {
  timestamp: number
  text: string
}

/** Statistics for one group of near-identical messages from a user. */
export interface ClusterSummary {
  /** Canonical text shared by the cluster */
  key: string
  count: number
  /** Distinct raw texts */
  variants: number
  /** Messages carrying invisible dedup-bypass characters */
  invisible: number
  medianGapMs: number
  /** 0..1 share of gaps on the cluster's beat */
  regularity: number
  /** Other users who sent the same key inside the window */
  crowd: number
  firstAt: number
  lastAt: number
  samples: Sample[]
}

/** The detector's view of one user at one moment. */
export interface Assessment {
  roomId: number
  uid: number
  uname: string
  /** Timestamp of the message that produced this assessment */
  at: number
  /** 0..100 */
  score: number
  verdict: Verdict
  pattern: Pattern
  /** Excess repeats (messages beyond the first of each repeated line) inside the window, or {@link triggerHits} */
  repeats: number
  /** `repeats` counts 自动融入 trigger hits, not repeated messages: the replay set the score */
  triggerHits?: boolean
  /** User's messages inside the window */
  windowMessages: number
  /** 0..1 confidence behind the score, repetition volume included */
  automation: number
  /** 0..1 confidence from automation evidence alone; a `spam` verdict needs it */
  proof: number
  evidence: Evidence[]
  clusters: ClusterSummary[]
  /** Copied from the triggering message for enforcement exemptions */
  userType: number
  guardType: number
  medalLevel: number
}
