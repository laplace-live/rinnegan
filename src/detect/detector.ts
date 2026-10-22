import type { Assessment, ChatMessage, ClusterSummary, Evidence, EvidenceKind, Pattern, Sample, Verdict } from '@/types'

import { CrowdIndex } from '@/detect/crowd'
import { canonicalize, findEvasionChars, graphemeLength, multiplicity, stripEvasionChars } from '@/detect/normalize'
import { boundedLevenshtein, fuzzyBudget, insertionJitter, sameChars, singleInsertion } from '@/detect/similarity'
import {
  type Lattice,
  latticeGaps,
  latticeShare,
  latticeThreshold,
  MIN_LATTICE_GAPS,
  measureLattice,
  measureRhythm,
  median,
  type Rhythm,
} from '@/detect/timing'

export interface DetectorOptions {
  /** Per-user sliding window, ms */
  windowMs: number
  /** Hard cap on remembered messages per user */
  maxRecordsPerUser: number
  /** Score at which a user is reported as a suspect */
  suspectScore: number
  /** Score at which a user is judged a 独轮车 (also needs {@link minAutomation}) */
  spamScore: number
  /** Minimum automation confidence (0..1) for a `spam` verdict; repetition alone never qualifies */
  minAutomation: number
  /** Score curve: `score = 100 × (1 − e^(−repeats × automation / tau))` */
  tau: number
  /** Bilibili's duplicate-content cooldowns (ms); a human resending as soon as allowed looks regular, so stricter proof */
  cooldownFloorsMs: number[]
  /** Raw samples kept per cluster for reports */
  samplesPerCluster: number
}

export const DEFAULT_DETECTOR_OPTIONS: DetectorOptions = {
  windowMs: 10 * 60_000,
  maxRecordsPerUser: 300,
  suspectScore: 60,
  spamScore: 90,
  minAutomation: 0.75,
  tau: 3.3,
  cooldownFloorsMs: [5000],
  samplesPerCluster: 5,
}

/** A user flagged at least once, with their worst moment and every flagged stretch. */
export interface UserSummary {
  roomId: number
  uid: number
  uname: string
  messages: number
  firstAt: number
  lastAt: number
  peak: Assessment
  episodes: Episode[]
}

/** A continuous stretch where a user stayed at `suspect` or above. */
export interface Episode {
  startAt: number
  endAt: number
  peakScore: number
  verdict: Verdict
  pattern: Pattern
  key: string
}

export interface IngestResult {
  assessment: Assessment
  /** Verdict went up, or a flagged user's score rose by 5+ since the last emitted change */
  changed: boolean
}

interface Rec {
  at: number
  raw: string
  visible: string
  key: string
  keyChars: string[]
  evasion: string[]
  multiplicity: number
  length: number
  isEmote: boolean
  /** Exact copy of another user's jittered text (+1), so its invisible chars aren't this user's doing */
  echo: boolean
  cluster: Cluster
}

interface ClusterEval {
  repeats: number
  automation: number
  evidence: Evidence[]
  rhythm: Rhythm
  /** Gaps eligible for the send-tick lattice, with the time each gap ended */
  latticeGaps: { at: number; gap: number }[]
  summary: ClusterSummary
}

/** A group of lines that together make the strongest case. */
interface Candidate {
  repeats: number
  automation: number
  evidence: Evidence
  members: Set<ClusterEval>
}

interface Cluster {
  id: number
  key: string
  keyChars: string[]
  recs: Rec[]
  cached: ClusterEval | null
}

interface UserState {
  roomId: number
  uid: number
  uname: string
  records: Rec[]
  clusters: Map<number, Cluster>
  byKey: Map<string, Cluster>
  nextClusterId: number
  messages: number
  firstAt: number
  lastAt: number
  lastVerdict: Verdict
  lastEmittedScore: number
  peak: Assessment | null
  episodes: Episode[]
  openEpisode: Episode | null
  last: ChatMessage
  /** Recent gaps between any two consecutive sends, outliving the window, for the session tick fingerprint */
  sessionGaps: number[]
  fingerprint: Lattice | null
  /** Session gaps added since the fingerprint was last fitted */
  fingerprintAge: number
}

const VERDICT_RANK: Record<Verdict, number> = { none: 0, suspect: 1, spam: 2 }
/** Session gaps kept per user for the fingerprint */
const SESSION_GAPS = 400
/** Fewest session gaps before a fingerprint is trusted */
const MIN_FINGERPRINT_GAPS = 60

/** Noisy-OR: independent signals reinforce each other without exceeding 1. */
function combine(weights: number[]): number {
  let miss = 1
  for (const weight of weights) miss *= 1 - weight
  return 1 - miss
}

function evidence(kind: EvidenceKind, weight: number, detail: string): Evidence {
  return { kind, weight, detail }
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`
}

/** Streaming 独轮车 detector. Feed messages in time order; the same engine drives live and offline mode. */
export class Detector {
  readonly options: DetectorOptions
  readonly #users = new Map<string, UserState>()
  readonly #crowd: CrowdIndex
  #lastSweep = 0

  constructor(options: Partial<DetectorOptions> = {}) {
    this.options = { ...DEFAULT_DETECTOR_OPTIONS, ...options }
    this.#crowd = new CrowdIndex(this.options.windowMs)
  }

  /** Consume one message and return the sender's updated assessment. */
  ingest(message: ChatMessage): IngestResult {
    const state = this.#state(message)
    // Live sources can deliver a few ms out of order; keep each user's timeline monotonic.
    const at = state.messages > 0 ? Math.max(message.timestamp, state.lastAt) : message.timestamp
    if (at !== message.timestamp) message = { ...message, timestamp: at }
    if (state.messages > 0) this.#recordSessionGap(state, at - state.lastAt)
    this.#prune(state, at)

    const rec = this.#record(state, message)
    state.records.push(rec)
    rec.cluster.recs.push(rec)
    rec.cluster.cached = null
    state.messages++
    state.lastAt = at
    state.uname = message.uname || state.uname
    state.last = message
    if (state.records.length > this.options.maxRecordsPerUser) this.#dropOldest(state)
    this.#crowd.add(state.roomId, rec.key, state.uid, at, rec.evasion.length > 0 ? rec.raw : null)

    const assessment = this.#assess(state, message)
    const changed = this.#track(state, assessment)
    if (at - this.#lastSweep > this.options.windowMs) this.#sweep(at)
    return { assessment, changed }
  }

  /** Users that reached `suspect` at least once, worst first. */
  summaries(): UserSummary[] {
    const out: UserSummary[] = []
    for (const state of this.#users.values()) {
      if (!state.peak || state.peak.verdict === 'none') continue
      const episodes = state.openEpisode ? [...state.episodes, state.openEpisode] : state.episodes
      out.push({
        roomId: state.roomId,
        uid: state.uid,
        uname: state.uname,
        messages: state.messages,
        firstAt: state.firstAt,
        lastAt: state.lastAt,
        peak: state.peak,
        episodes: episodes.map(episode => ({ ...episode })),
      })
    }
    return out.sort((a, b) => b.peak.score - a.peak.score || b.peak.repeats - a.peak.repeats)
  }

  /** Users currently tracked (for status output). */
  get trackedUsers(): number {
    return this.#users.size
  }

  /** The user's messages still inside the window, oldest first. */
  recentMessages(roomId: number, uid: number): Sample[] {
    const state = this.#users.get(`${roomId}:${uid}`)
    return state ? state.records.map(rec => ({ timestamp: rec.at, text: rec.raw })) : []
  }

  #state(message: ChatMessage): UserState {
    const id = `${message.roomId}:${message.uid}`
    let state = this.#users.get(id)
    if (!state) {
      state = {
        roomId: message.roomId,
        uid: message.uid,
        uname: message.uname,
        records: [],
        clusters: new Map(),
        byKey: new Map(),
        nextClusterId: 1,
        messages: 0,
        firstAt: message.timestamp,
        lastAt: message.timestamp,
        lastVerdict: 'none',
        lastEmittedScore: 0,
        peak: null,
        episodes: [],
        openEpisode: null,
        last: message,
        sessionGaps: [],
        fingerprint: null,
        fingerprintAge: 0,
      }
      this.#users.set(id, state)
    }
    return state
  }

  #recordSessionGap(state: UserState, gap: number): void {
    const [eligible] = latticeGaps([0, gap])
    if (eligible === undefined) return
    state.sessionGaps.push(eligible)
    if (state.sessionGaps.length > SESSION_GAPS) state.sessionGaps.splice(0, state.sessionGaps.length - SESSION_GAPS)
    state.fingerprintAge++
  }

  /** Lattice fit over the user's recent sends regardless of window, refitted every 10 new gaps. */
  #sessionFingerprint(state: UserState): Lattice | null {
    if (state.sessionGaps.length < MIN_FINGERPRINT_GAPS) return null
    if (!state.fingerprint || state.fingerprintAge >= 10) {
      state.fingerprint = measureLattice(state.sessionGaps)
      state.fingerprintAge = 0
    }
    return state.fingerprint.share >= latticeThreshold(state.fingerprint.gaps) ? state.fingerprint : null
  }

  #record(state: UserState, message: ChatMessage): Rec {
    const raw = message.text
    const visible = stripEvasionChars(raw)
    const key = canonicalize(raw) || raw.trim()
    const keyChars = Array.from(key)
    const evasion = findEvasionChars(raw)
    const rec: Rec = {
      at: message.timestamp,
      raw,
      visible,
      key,
      keyChars,
      evasion,
      multiplicity: multiplicity(raw, key),
      length: graphemeLength(visible),
      isEmote: message.isEmote,
      echo: evasion.length > 0 && this.#crowd.echoes(state.roomId, raw, state.uid),
      cluster: undefined as unknown as Cluster,
    }
    rec.cluster = this.#matchCluster(state, rec)
    return rec
  }

  /**
   * Exact key, then a rotation of a repeated phrase, a single inserted or moved char (a visible 随机字符), or a small
   * edit distance; else a new cluster.
   */
  #matchCluster(state: UserState, rec: Rec): Cluster {
    const exact = state.byKey.get(rec.key)
    if (exact) return exact

    const length = rec.keyChars.length
    for (const cluster of state.clusters.values()) {
      const other = cluster.keyChars
      if (
        rec.multiplicity >= 2 &&
        length >= 2 &&
        other.length === length &&
        (cluster.key + cluster.key).includes(rec.key)
      ) {
        if (cluster.recs.some(r => r.multiplicity >= 2)) return this.#alias(state, cluster, rec.key)
      }
      if (length >= 4 && (singleInsertion(other, rec.keyChars) || singleInsertion(rec.keyChars, other))) {
        return this.#alias(state, cluster, rec.key)
      }
      if (
        length >= 3 &&
        other.length === length &&
        sameChars(rec.keyChars, other) &&
        boundedLevenshtein(rec.keyChars, other, 2) <= 2
      ) {
        return this.#alias(state, cluster, rec.key)
      }
      const budget = fuzzyBudget(Math.min(length, other.length))
      if (budget > 0 && boundedLevenshtein(rec.keyChars, other, budget) <= budget) {
        return this.#alias(state, cluster, rec.key)
      }
    }

    const cluster: Cluster = { id: state.nextClusterId++, key: rec.key, keyChars: rec.keyChars, recs: [], cached: null }
    state.clusters.set(cluster.id, cluster)
    state.byKey.set(rec.key, cluster)
    return cluster
  }

  #alias(state: UserState, cluster: Cluster, key: string): Cluster {
    state.byKey.set(key, cluster)
    return cluster
  }

  #prune(state: UserState, now: number): void {
    const cutoff = now - this.options.windowMs
    let drop = 0
    while (drop < state.records.length && (state.records[drop] as Rec).at < cutoff) drop++
    if (drop === 0) return
    const dropped = state.records.splice(0, drop)
    this.#forget(state, dropped)
  }

  #dropOldest(state: UserState): void {
    const dropped = state.records.splice(0, state.records.length - this.options.maxRecordsPerUser)
    this.#forget(state, dropped)
  }

  #forget(state: UserState, dropped: Rec[]): void {
    const gone = new Set(dropped)
    const touched = new Set<Cluster>()
    for (const rec of dropped) touched.add(rec.cluster)
    for (const cluster of touched) {
      cluster.recs = cluster.recs.filter(rec => !gone.has(rec))
      cluster.cached = null
      if (cluster.recs.length === 0) {
        state.clusters.delete(cluster.id)
        for (const [key, owner] of state.byKey) if (owner === cluster) state.byKey.delete(key)
      }
    }
  }

  /** Drop users idle for a full window so memory stays bounded in long live sessions. */
  #sweep(now: number): void {
    this.#lastSweep = now
    for (const [id, state] of this.#users) {
      if (now - state.lastAt <= this.options.windowMs) continue
      if (state.peak && state.peak.verdict !== 'none') {
        // Keep flagged users for summaries, but release their message buffers.
        state.records = []
        state.clusters.clear()
        state.byKey.clear()
        if (state.openEpisode) {
          state.episodes.push(state.openEpisode)
          state.openEpisode = null
        }
        state.lastVerdict = 'none'
        state.lastEmittedScore = 0
        continue
      }
      this.#users.delete(id)
    }
  }

  #isAtFloor(beatMs: number): boolean {
    return this.options.cooldownFloorsMs.some(floor => beatMs >= floor - 100 && beatMs <= floor + 450)
  }

  #evaluateCluster(state: UserState, cluster: Cluster): ClusterEval {
    if (cluster.cached) return cluster.cached
    const recs = cluster.recs
    const n = recs.length
    const rhythm = measureRhythm(recs.map(rec => rec.at))
    const found: Evidence[] = []
    const emote = recs.every(rec => rec.isEmote)

    // Invisible chars at shifting positions: chatterbox 随机字符 / 路怒 / AI规避. No human types U+00AD, but a +1 copies
    // someone else's, so only self-made layouts count and they must carry the line.
    const invisible = recs.filter(rec => rec.evasion.length > 0 && !rec.echo)
    if (invisible.length >= 2) {
      const layouts = new Set(invisible.map(rec => rec.raw))
      const jitter = layouts.size >= 2 || invisible.length < n
      const carries = invisible.length * 2 >= n
      let weight = invisible.length >= 3 ? (jitter ? 0.95 : 0.6) : jitter ? 0.6 : 0.3
      if (!carries) weight = Math.min(weight, 0.5)
      const chars = [...new Set(invisible.flatMap(rec => rec.evasion))]
      const names = chars.map(char => `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`)
      found.push(
        evidence(
          'invisible-jitter',
          weight,
          `${invisible.length}/${n} 条插入不可见字符 ${names.join(' ')}${jitter ? `，${layouts.size} 种位置` : ''}`
        )
      )
    }

    // The same visible char at varying spots: a custom 随机字符 that canonicalization can't strip.
    const distinctKeys = [...new Map(recs.map(rec => [rec.key, rec.keyChars])).values()]
    const jitter = insertionJitter(distinctKeys)
    if (jitter) {
      found.push(
        evidence(
          'insert-jitter',
          jitter.variants >= 4 ? 0.85 : 0.6,
          `可见字符「${jitter.char}」在 ${jitter.variants} 种位置插入`
        )
      )
    }

    // Copy-count churn at machine speed (爆了 ×13 / ×4 / ×7 …), a burst tool's dedup bypass.
    if (n >= 5 && rhythm.beatMs > 0 && rhythm.beatMs <= 3000) {
      const multiplicities = new Set(recs.map(rec => rec.multiplicity))
      if (multiplicities.size >= 3) {
        found.push(
          evidence(
            'repeat-jitter',
            0.85,
            `${seconds(rhythm.beatMs)} 间隔内重复次数在 ${multiplicities.size} 种之间变化`
          )
        )
      }
    }

    // Timer cadence. A beat on a cooldown floor is reachable by mashing send, so it needs a longer, tighter run.
    if (rhythm.gaps >= 6) {
      const atFloor = this.#isAtFloor(rhythm.beatMs)
      let weight = 0
      if (atFloor) {
        if (rhythm.gaps >= 20 && rhythm.periodic >= 0.95) weight = 0.9
        else if (rhythm.gaps >= 30 && rhythm.periodic >= 0.9) weight = 0.85
        else if (rhythm.gaps >= 12 && rhythm.periodic >= 0.95) weight = 0.5
      } else if (rhythm.gaps >= 15 && rhythm.periodic >= 0.9) weight = 0.9
      else if (rhythm.gaps >= 20 && rhythm.periodic >= 0.85) weight = 0.8
      else if (rhythm.gaps >= 9 && rhythm.periodic >= 0.95) weight = 0.7
      if (emote && atFloor) weight *= 0.6
      if (weight > 0) {
        found.push(
          evidence(
            'periodic',
            weight,
            `${percent(rhythm.periodic)} 的间隔落在 ${seconds(rhythm.beatMs)} 节拍上（${rhythm.gaps} 个间隔${atFloor ? '，冷却下限' : ''}）`
          )
        )
      } else if (!atFloor && rhythm.gaps >= 14 && rhythm.banded >= 0.92 && rhythm.cv <= 0.25) {
        found.push(
          evidence(
            'periodic',
            0.6,
            `间隔稳定在 ${seconds(rhythm.beatMs)} ±40% 内（随机间隔计时器，CV ${rhythm.cv.toFixed(2)}）`
          )
        )
      }
    }

    // Same content faster than anyone retypes it. Bilibili drops identical resends inside ~5 s, so keeping this up
    // means altering every send; a short burst is humanly possible, minutes of it are not.
    if (n >= 6 && rhythm.beatMs > 0 && rhythm.beatMs <= 2500) {
      const longText = median(recs.map(rec => rec.length)) >= 8
      let weight = n >= 40 ? 0.9 : n >= 20 ? 0.8 : longText ? 0.75 : 0.5
      if (emote) weight = 0.3
      found.push(evidence('machine-speed', weight, `${n} 条相同内容，中位间隔 ${seconds(rhythm.beatMs)}`))
    }

    const automation = combine(found.map(item => item.weight))
    const summary = this.#summarize(state, cluster, rhythm)
    const gaps: { at: number; gap: number }[] = []
    for (let i = 1; i < n; i++) {
      const at = (recs[i] as Rec).at
      const [gap] = latticeGaps([(recs[i - 1] as Rec).at, at])
      if (gap !== undefined) gaps.push({ at, gap })
    }
    cluster.cached = { repeats: n - 1, automation, evidence: found, rhythm, latticeGaps: gaps, summary }
    return cluster.cached
  }

  #summarize(state: UserState, cluster: Cluster, rhythm: Rhythm): ClusterSummary {
    const recs = cluster.recs
    const samples: Sample[] = []
    const seen = new Set<string>()
    // Prefer distinct raw layouts so reports show the jitter itself.
    for (const rec of recs) {
      if (samples.length >= this.options.samplesPerCluster) break
      if (seen.has(rec.raw)) continue
      seen.add(rec.raw)
      samples.push({ timestamp: rec.at, text: rec.raw })
    }
    return {
      key: cluster.key,
      count: recs.length,
      variants: new Set(recs.map(rec => rec.raw)).size,
      invisible: recs.filter(rec => rec.evasion.length > 0).length,
      medianGapMs: rhythm.beatMs,
      regularity: rhythm.periodic,
      crowd: this.#crowd.others(state.roomId, cluster.key, state.uid),
      firstAt: (recs[0] as Rec).at,
      lastAt: (recs[recs.length - 1] as Rec).at,
      samples,
    }
  }

  #score(repeats: number, automation: number): number {
    return 100 * (1 - Math.exp((-repeats * automation) / this.options.tau))
  }

  #assess(state: UserState, message: ChatMessage): Assessment {
    const evaluations: ClusterEval[] = []
    for (const cluster of state.clusters.values()) {
      if (cluster.recs.length >= 2) evaluations.push(this.#evaluateCluster(state, cluster))
    }
    evaluations.sort(
      (a, b) => this.#score(b.repeats, b.automation) - this.#score(a.repeats, a.automation) || b.repeats - a.repeats
    )

    const best = evaluations[0]
    let repeats = best?.repeats ?? 0
    let automation = best?.automation ?? 0
    let found: Evidence[] = best ? [...best.evidence] : []
    let pattern: Pattern = 'loop'
    let members: Set<ClusterEval> = new Set(best ? [best] : [])

    const template = this.#templateCycle(state, evaluations)
    if (template && this.#score(template.repeats, template.automation) > this.#score(repeats, automation)) {
      ;({ repeats, automation, members } = template)
      found = [template.evidence, ...found]
      pattern = 'template'
    }

    // One tool tick drives every line a looper sends, so the lattice is fitted on all their repeated lines at once.
    const tick = this.#sendTick(evaluations) ?? this.#fingerprintTick(state, evaluations)
    if (tick) {
      if (this.#score(tick.repeats, tick.automation) > this.#score(repeats, automation)) {
        ;({ repeats, automation, members } = tick)
        pattern = 'loop'
      }
      found = [tick.evidence, ...found]
    }
    const shown = [...evaluations].sort(
      (a, b) => Number(members.has(b)) - Number(members.has(a)) || b.repeats - a.repeats
    )

    // Repetition without automation evidence stays a suspect at most; a trend the room shares counts for less.
    if (best && automation < this.options.minAutomation && repeats >= 15) {
      const crowd = best.summary.crowd
      const weight = crowd >= 10 ? 0.25 : crowd >= 3 ? 0.35 : 0.45
      found.push(evidence('volume', weight, `${repeats + 1} 条相同内容${crowd > 0 ? `，同时有 ${crowd} 人在刷` : ''}`))
      automation = combine([automation, weight])
    }

    let score = Math.round(this.#score(repeats, automation) * 10) / 10
    const proof = combine(found.filter(item => item.kind !== 'volume').map(item => item.weight))
    const strong = proof >= this.options.minAutomation
    let verdict: Verdict = 'none'
    if (score >= this.options.spamScore && strong) verdict = 'spam'
    else if (score >= this.options.suspectScore) verdict = 'suspect'
    if (verdict !== 'spam' && score >= this.options.spamScore) score = this.options.spamScore - 0.1

    if (pattern !== 'template' && best) pattern = this.#classify(state, best, found)

    return {
      roomId: state.roomId,
      uid: state.uid,
      uname: state.uname,
      at: message.timestamp,
      score,
      verdict,
      pattern,
      repeats,
      windowMessages: state.records.length,
      automation: Math.round(automation * 1000) / 1000,
      evidence: found.sort((a, b) => b.weight - a.weight),
      clusters: shown.slice(0, 3).map(evaluation => evaluation.summary),
      userType: message.userType,
      guardType: message.guardType,
      medalLevel: message.medalLevel,
      wealthLevel: message.wealthLevel,
    }
  }

  /** Repeated lines whose gaps sit on one send-queue tick lattice (chatterbox ≈ 1.3 s). */
  #sendTick(evaluations: ClusterEval[]): Candidate | null {
    const pooled = evaluations.flatMap(evaluation => evaluation.latticeGaps)
    if (pooled.length < MIN_LATTICE_GAPS) return null
    const recent = pooled.sort((a, b) => a.at - b.at).slice(-150)
    const lattice: Lattice = measureLattice(recent.map(item => item.gap))
    if (lattice.share < latticeThreshold(lattice.gaps)) return null
    let repeats = 0
    const members = new Set<ClusterEval>()
    for (const evaluation of evaluations) {
      const gaps = evaluation.latticeGaps.map(item => item.gap)
      if (gaps.length >= 2 && latticeShare(gaps, lattice.tickMs) >= 0.5) {
        repeats += evaluation.repeats
        members.add(evaluation)
      }
    }
    if (repeats === 0) return null
    const lines = members.size
    const weight = lattice.gaps >= 20 ? 0.9 : 0.85
    return {
      repeats,
      members,
      automation: weight,
      evidence: evidence(
        'send-tick',
        weight,
        `${percent(lattice.share)} 的间隔是 ${seconds(lattice.tickMs)} 发送节拍的整数倍（${lattice.gaps} 个间隔，${lines} 条内容）`
      ),
    }
  }

  /** The session fingerprint's tick, when the lines repeated right now also sit on it (the tool is running now). */
  #fingerprintTick(state: UserState, evaluations: ClusterEval[]): Candidate | null {
    const fingerprint = this.#sessionFingerprint(state)
    if (!fingerprint) return null
    let repeats = 0
    let onTick = 0
    const members = new Set<ClusterEval>()
    for (const evaluation of evaluations) {
      const gaps = evaluation.latticeGaps.map(item => item.gap)
      if (gaps.length < 3) continue
      const share = latticeShare(gaps, fingerprint.tickMs)
      if (share >= 0.6) {
        repeats += evaluation.repeats
        members.add(evaluation)
        onTick += Math.round(share * gaps.length)
      }
    }
    if (repeats === 0 || onTick < 6) return null
    const lines = members.size
    return {
      repeats,
      members,
      automation: 0.85,
      evidence: evidence(
        'send-tick',
        0.85,
        `近 ${fingerprint.gaps} 个发送间隔中 ${percent(fingerprint.share)} 是 ${seconds(fingerprint.tickMs)} 节拍的整数倍，当前 ${lines} 条重复内容仍落在该节拍上`
      ),
    }
  }

  /** Several lines cycled on one timer: chatterbox's multi-line 独轮车 template. */
  #templateCycle(state: UserState, evaluations: ClusterEval[]): Candidate | null {
    const lines = evaluations.filter(evaluation => evaluation.summary.count >= 3)
    if (lines.length < 2) return null
    const covered = lines.reduce((sum, evaluation) => sum + evaluation.summary.count, 0)
    const share = covered / state.records.length
    if (share < 0.75) return null
    const rhythm = measureRhythm(state.records.map(rec => rec.at))
    if (rhythm.gaps < 12) return null
    const atFloor = this.#isAtFloor(rhythm.beatMs)
    const needed = atFloor ? 0.95 : 0.85
    if (rhythm.periodic < needed) return null
    // Clicking neighbouring stickers across the panel cycles them in order too, so sticker-only cycles stay weak.
    const stickers = state.records.every(rec => rec.isEmote)
    const weight = stickers ? 0.5 : atFloor ? 0.85 : 0.9
    return {
      repeats: lines.reduce((sum, evaluation) => sum + evaluation.repeats, 0),
      members: new Set(lines),
      automation: weight,
      evidence: evidence(
        'template-cycle',
        weight,
        `${lines.length} 条内容按 ${seconds(rhythm.beatMs)} 节拍轮播（覆盖 ${percent(share)}，${percent(rhythm.periodic)} 落拍）`
      ),
    }
  }

  #classify(state: UserState, best: ClusterEval, found: Evidence[]): Pattern {
    const kinds = new Set(found.filter(item => item.kind !== 'volume').map(item => item.kind))
    if (kinds.size === 0) return 'flood'
    const timed = kinds.has('periodic') || kinds.has('send-tick')
    const jittered = kinds.has('invisible-jitter') || kinds.has('insert-jitter')
    // Jittered resends across many trending lines: an auto-blend style bot.
    const jitteredLines = [...state.clusters.values()].filter(
      cluster => cluster.recs.length >= 2 && cluster.recs.some(rec => rec.evasion.length > 0)
    ).length
    if (kinds.has('invisible-jitter') && !timed && jitteredLines >= 3 && best.summary.crowd >= 5) return 'blend'
    // Burst tools churn copy counts; a fast line with 随机字符 is just a short-interval loop.
    if (kinds.has('repeat-jitter') || (kinds.has('machine-speed') && !timed && !jittered)) return 'burst'
    return 'loop'
  }

  #track(state: UserState, assessment: Assessment): boolean {
    const peak = state.peak
    if (
      !peak ||
      assessment.score > peak.score ||
      (assessment.score === peak.score && assessment.repeats > peak.repeats)
    ) {
      state.peak = assessment
    }

    const flagged = assessment.verdict !== 'none'
    if (flagged) {
      const topKey = assessment.clusters[0]?.key ?? ''
      if (!state.openEpisode) {
        state.openEpisode = {
          startAt: assessment.at,
          endAt: assessment.at,
          peakScore: assessment.score,
          verdict: assessment.verdict,
          pattern: assessment.pattern,
          key: topKey,
        }
      } else {
        const episode = state.openEpisode
        episode.endAt = assessment.at
        if (assessment.score > episode.peakScore) {
          episode.peakScore = assessment.score
          episode.pattern = assessment.pattern
          episode.key = topKey
        }
        if (VERDICT_RANK[assessment.verdict] > VERDICT_RANK[episode.verdict]) episode.verdict = assessment.verdict
      }
    } else if (state.openEpisode) {
      state.episodes.push(state.openEpisode)
      state.openEpisode = null
    }

    const rose = VERDICT_RANK[assessment.verdict] > VERDICT_RANK[state.lastVerdict]
    const climbed = flagged && assessment.score >= state.lastEmittedScore + 5
    state.lastVerdict = assessment.verdict
    if (rose || climbed) {
      state.lastEmittedScore = assessment.score
      return true
    }
    if (!flagged) state.lastEmittedScore = 0
    return false
  }
}
