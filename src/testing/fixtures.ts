import type { BanRecord } from '@/store/types'
import type { Assessment } from '@/types'

let seq = 0

/** A spam verdict on a soft-hyphen loop of `千舰`; `patch` overrides any field. */
export function assessment(patch: Partial<Assessment> = {}): Assessment {
  return {
    roomId: 1,
    uid: 42,
    uname: 'bot',
    at: 1_760_000_000_000,
    score: 100,
    verdict: 'spam',
    pattern: 'loop',
    repeats: 30,
    windowMessages: 31,
    automation: 0.95,
    evidence: [{ kind: 'invisible-jitter', weight: 0.95, detail: 'U+00AD' }],
    clusters: [
      {
        key: '千舰',
        count: 31,
        variants: 20,
        invisible: 31,
        medianGapMs: 1300,
        regularity: 1,
        crowd: 0,
        firstAt: 0,
        lastAt: 1,
        samples: [{ timestamp: 0, text: '千­舰' }],
      },
    ],
    userType: 0,
    guardType: 0,
    medalLevel: 0,
    proof: 0.95,
    ...patch,
  }
}

/** An active permanent ban; ids are unique and `createdAt` grows with each call. */
export function banRecord(patch: Partial<BanRecord> = {}): BanRecord {
  seq++
  return {
    id: crypto.randomUUID(),
    roomId: 1000,
    uid: 2000,
    uname: `用户${seq}`,
    reason: '独轮车',
    score: 92.5,
    pattern: 'loop',
    evidence: { evidence: [{ kind: 'periodic', weight: 0.9, detail: '每 5.0s 一条' }], clusters: [] },
    createdAt: 1_760_000_000_000 + seq,
    expiresAt: null,
    hours: -1,
    status: 'active',
    liftedAt: null,
    liftReason: null,
    spend: 0,
    operatorUid: null,
    meta: {},
    ...patch,
  }
}
