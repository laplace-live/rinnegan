import type { Assessment, ManualBlend } from '@laplace.live/rinnegan-sdk'

import type { BanRecord } from '@/store/types'

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

/** A 手动融入 mark on {@link assessment}'s user: 55 of 86 text danmaku copied; `patch` overrides any field. */
export function manualBlend(patch: Partial<ManualBlend> = {}): ManualBlend {
  const at = 1_760_000_000_000
  return {
    roomId: 1,
    uid: 42,
    uname: 'bot',
    sends: 86,
    copies: 55,
    chants: 18,
    sources: 31,
    switches: 84,
    ownSwitches: 31,
    plusOneLagMs: 5800,
    samples: [
      { at, text: '才八点', senders: 22 },
      { at: at + 60_000, text: '你太云了，没玩过没发言权', senders: 1, from: '路人', lagMs: 5600 },
    ],
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
