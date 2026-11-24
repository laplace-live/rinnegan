/** Gaps longer than this are pauses, not part of a send rhythm. */
export const MAX_RHYTHM_GAP_MS = 120_000

/** Sorted-input quantile with linear interpolation. */
export function quantile(sorted: ArrayLike<number>, q: number): number {
  if (sorted.length === 0) return 0
  const index = (sorted.length - 1) * q
  const lo = Math.floor(index)
  const hi = Math.ceil(index)
  const a = sorted[lo] as number
  return a + ((sorted[hi] as number) - a) * (index - lo)
}

/** Middle value, interpolated between the two middle ones for an even count; 0 when empty. */
export function median(values: readonly number[]): number {
  return quantile(Float64Array.from(values).sort(), 0.5)
}

/** Send-rhythm statistics for a time-ordered series. */
export interface Rhythm {
  /** Gaps considered (pauses excluded) */
  gaps: number
  /** Median gap, ms */
  beatMs: number
  /** Coefficient of variation of the considered gaps */
  cv: number
  /** Share of gaps within the beat tolerance */
  onBeat: number
  /** Share of gaps on the beat or on a skipped beat (2× / 3×), as a timer whose sends sometimes fail produces */
  periodic: number
  /** Share of gaps within ±40% of the beat or twice it: chatterbox's clamped Gaussian jitter never leaves that band */
  banded: number
}

export const EMPTY_RHYTHM: Rhythm = { gaps: 0, beatMs: 0, cv: 0, onBeat: 0, periodic: 0, banded: 0 }

/** Send-queue tick search range: chatterbox's 1010 ms queue gap plus 140–440 ms request latency. */
const TICK_MIN_MS = 1150
const TICK_MAX_MS = 1450
const TICK_STEP_MS = 5
const TICK_TOLERANCE_MS = 100
const TICK_COUNT = (TICK_MAX_MS - TICK_MIN_MS) / TICK_STEP_MS + 1
const LATTICE_MIN_GAP_MS = 1000
const LATTICE_MAX_GAP_MS = 30_000

/** Fit of gaps to multiples of one send-queue tick. */
export interface Lattice {
  /** Gaps tested */
  gaps: number
  /** Best tick, ms */
  tickMs: number
  /** Share of gaps within ±100 ms of a tick multiple */
  share: number
}

/** Whether a send-queue lattice can explain `gap` (ms): shorter is a burst, longer a pause. */
export function isLatticeGap(gap: number): boolean {
  return gap >= LATTICE_MIN_GAP_MS && gap <= LATTICE_MAX_GAP_MS
}

const tickHits = new Int32Array(TICK_COUNT)

/**
 * Best fit of gaps to a k × tick lattice. A loop on chatterbox's 1 s default ticks every ~1.3 s and Bilibili drops
 * identical resends inside ~5 s, so its accepted sends land on 5.2 / 6.5 / 7.8 s; human gaps don't.
 */
export function measureLattice(gaps: readonly number[]): Lattice {
  let best: Lattice = { gaps: gaps.length, tickMs: 0, share: 0 }
  if (gaps.length === 0) return best
  if (!gaps.every(Number.isInteger)) return scanLattice(gaps)
  // Ticks are ≥ 1150 ms, so only k = round(gap / tick) can put a tick within ±100 ms of the gap: counting, per gap,
  // the ticks inside each multiple's window gives exactly the scan's shares without trying every tick.
  tickHits.fill(0)
  for (const gap of gaps) {
    const kMax = Math.floor((gap + TICK_TOLERANCE_MS) / TICK_MIN_MS)
    for (let k = Math.max(1, Math.ceil((gap - TICK_TOLERANCE_MS) / TICK_MAX_MS)); k <= kMax; k++) {
      const lo = Math.max(TICK_MIN_MS, Math.ceil((gap - TICK_TOLERANCE_MS) / k))
      const hi = Math.min(TICK_MAX_MS, Math.floor((gap + TICK_TOLERANCE_MS) / k))
      const last = Math.floor((hi - TICK_MIN_MS) / TICK_STEP_MS)
      for (let i = Math.ceil((lo - TICK_MIN_MS) / TICK_STEP_MS); i <= last; i++) {
        tickHits[i] = (tickHits[i] as number) + 1
      }
    }
  }
  for (let i = 0; i < TICK_COUNT; i++) {
    const share = (tickHits[i] as number) / gaps.length
    if (share > best.share) best = { gaps: gaps.length, tickMs: TICK_MIN_MS + i * TICK_STEP_MS, share }
  }
  return best
}

/** {@link measureLattice} by trying every tick; also the reference the counting version must equal. */
export function scanLattice(gaps: readonly number[]): Lattice {
  let best: Lattice = { gaps: gaps.length, tickMs: 0, share: 0 }
  for (let tick = TICK_MIN_MS; tick <= TICK_MAX_MS; tick += TICK_STEP_MS) {
    const share = latticeShare(gaps, tick)
    if (share > best.share) best = { gaps: gaps.length, tickMs: tick, share }
  }
  return best
}

/** Fewest gaps a lattice fit is judged on; shorter series fit some tick by chance too often. */
export const MIN_LATTICE_GAPS = 12

/**
 * Share a lattice fit needs before it counts. Searching the tick inflates chance fits, so this sits above the
 * maximum of 200k bootstrap resamples of real human gaps at every length (e.g. 0.83 at 12 gaps, 0.65 at 20).
 */
export function latticeThreshold(gaps: number): number {
  return 0.3 + 2 / Math.sqrt(Math.max(1, gaps))
}

/** How far whole-second timestamps, as some Bilibili logs keep them, blur a gap: a 10.2 s timer reads 10 s and 11 s */
export const COARSE_SLACK_MS = 1000
/** Widest a beat tolerance gets with slack, as a share of the beat, so a coarse clock can't stretch it to fit anyone */
const MAX_SLACK_SHARE = 0.15

/**
 * Beat tolerance: ±5% or 200 ms, whichever is wider (network jitter dominates at short intervals), plus `slackMs` for a
 * coarse clock, up to 15% of the beat.
 */
function beatTolerance(beatMs: number, slackMs: number): number {
  const tolerance = Math.max(beatMs * 0.05, 200)
  return Math.max(tolerance, Math.min(tolerance + slackMs, beatMs * MAX_SLACK_SHARE))
}

/** Share of `gaps` within ±100 ms of a multiple of `tickMs`. */
export function latticeShare(gaps: readonly number[], tickMs: number): number {
  if (gaps.length === 0 || tickMs <= 0) return 0
  let on = 0
  for (const gap of gaps) {
    const k = Math.round(gap / tickMs)
    if (k >= 1 && Math.abs(gap - k * tickMs) <= TICK_TOLERANCE_MS) on++
  }
  return on / gaps.length
}

/** Rhythm of `timestamps` (ms, ascending); `slackMs` widens the beat for a coarse clock. */
export function measureRhythm(timestamps: readonly number[], slackMs = 0): Rhythm {
  const gaps: number[] = []
  for (let i = 1; i < timestamps.length; i++) {
    const gap = (timestamps[i] as number) - (timestamps[i - 1] as number)
    if (gap <= MAX_RHYTHM_GAP_MS) gaps.push(gap)
  }
  if (gaps.length === 0) return EMPTY_RHYTHM

  const beatMs = quantile(Float64Array.from(gaps).sort(), 0.5)
  const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length
  const variance = gaps.reduce((sum, gap) => sum + (gap - mean) ** 2, 0) / gaps.length
  const tolerance = beatTolerance(beatMs, slackMs)

  let onBeat = 0
  let skipped = 0
  let banded = 0
  for (const gap of gaps) {
    if (Math.abs(gap - beatMs) <= tolerance) onBeat++
    else if (Math.abs(gap - beatMs * 2) <= tolerance * 2 || Math.abs(gap - beatMs * 3) <= tolerance * 3) skipped++
    const ratio = beatMs > 0 ? gap / beatMs : 0
    if ((ratio >= 0.6 && ratio <= 1.4) || (ratio >= 1.6 && ratio <= 2.4)) banded++
  }
  const onBeatShare = onBeat / gaps.length
  return {
    gaps: gaps.length,
    beatMs,
    cv: mean > 0 ? Math.sqrt(variance) / mean : 0,
    onBeat: onBeatShare,
    // Skipped beats only count once most gaps already sit on the beat, else any jitter would look periodic.
    periodic: onBeatShare >= 0.6 ? (onBeat + skipped) / gaps.length : onBeatShare,
    banded: banded / gaps.length,
  }
}

/** Gaps shorter than this are bursts, not a timer's beat: chatterbox's send queue waits 1010 ms between sends */
const MIN_PACE_MS = 1000
/** Missed beats in a row a timed chain still bridges, such as sends Bilibili's filter swallowed */
const MAX_SKIPPED_BEATS = 2

/**
 * Beats a timer behind `timestamps` may keep, likeliest first: medians of the densest bands of gaps, each a beat
 * tolerance either way, up to `count` that share no gap. Lines slipped in between split a beat, so bands can tie.
 */
export function likelyBeats(timestamps: readonly number[], slackMs = 0, count = 3): number[] {
  const gaps: number[] = []
  for (let i = 1; i < timestamps.length; i++) {
    const gap = (timestamps[i] as number) - (timestamps[i - 1] as number)
    if (gap >= MIN_PACE_MS && gap <= MAX_RHYTHM_GAP_MS) gaps.push(gap)
  }
  const sorted = Float64Array.from(gaps).sort()
  // The widest band ending at each gap starts at `start[i]` in `sorted`
  const start = new Int32Array(sorted.length)
  for (let i = 0, j = 0; i < sorted.length; i++) {
    while ((sorted[i] as number) - (sorted[j] as number) > 2 * beatTolerance(sorted[j] as number, slackMs)) j++
    start[i] = j
  }
  const beats: number[] = []
  const picked: number[] = []
  while (beats.length < count) {
    let end = -1
    for (let i = 0; i < sorted.length; i++) {
      const from = start[i] as number
      // Densest first, the lowest of equals; a band sharing a gap with one already taken is out
      if (end !== -1 && i - from <= end - (start[end] as number)) continue
      if (picked.some(other => from <= other && (start[other] as number) <= i)) continue
      end = i
    }
    if (end === -1) break
    picked.push(end)
    beats.push(quantile(sorted.subarray(start[end] as number, end + 1), 0.5))
  }
  return beats
}

/** Sends one timer made, as indices into the series. */
export interface PacedChain {
  /** Timed sends, oldest first */
  timed: number[]
  /** Timed sends a single beat after the previous one, not after missed beats */
  onBeat: number
  /** Other sends between the first timed send and the last */
  extras: number
  /** Timed sends whose `lines` entry differs from the previous one's; all but the first without `lines` */
  switches: number
}

/**
 * The best chain of sends a beat apart (or a missed beat or two) by line changes, or by length without `lines`, skipping
 * sends in between such as lines typed by hand: a best chain, so one typed near a beat can't knock it off the timer.
 */
export function pacedChain(
  timestamps: readonly number[],
  beatMs: number,
  slackMs = 0,
  lines?: readonly unknown[]
): PacedChain | null {
  const n = timestamps.length
  if (beatMs <= 0 || n < 2) return null
  const tolerance = beatTolerance(beatMs, slackMs)
  const score = new Int32Array(n)
  const onBeat = new Int32Array(n)
  const offset = new Float64Array(n)
  const prev = new Int32Array(n).fill(-1)
  // More changes, then more single beats, then tighter timing than the chain ending at `k`: a timer's own sends fit best
  const ahead = (s: number, o: number, f: number, k: number) =>
    s > (score[k] as number) ||
    (s === score[k] && (o > (onBeat[k] as number) || (o === onBeat[k] && f < (offset[k] as number))))
  // Sends `beats` beats before the current one lie in [lo, hi); both bounds only move forward
  const lo = new Int32Array(MAX_SKIPPED_BEATS + 2)
  const hi = new Int32Array(MAX_SKIPPED_BEATS + 2)
  let best = -1
  for (let j = 1; j < n; j++) {
    const at = timestamps[j] as number
    for (let beats = 1; beats <= MAX_SKIPPED_BEATS + 1; beats++) {
      const target = at - beats * beatMs
      while ((lo[beats] as number) < j && (timestamps[lo[beats] as number] as number) < target - tolerance) {
        lo[beats] = (lo[beats] as number) + 1
      }
      if ((hi[beats] as number) < (lo[beats] as number)) hi[beats] = lo[beats] as number
      while ((hi[beats] as number) < j && (timestamps[hi[beats] as number] as number) <= target + tolerance) {
        hi[beats] = (hi[beats] as number) + 1
      }
      for (let i = (hi[beats] as number) - 1; i >= (lo[beats] as number); i--) {
        const s = (score[i] as number) + (lines === undefined || lines[i] !== lines[j] ? 1 : 0)
        const o = (onBeat[i] as number) + (beats === 1 ? 1 : 0)
        const f = (offset[i] as number) + Math.abs((timestamps[i] as number) - target)
        if (prev[j] !== -1 && !ahead(s, o, f, j)) continue
        score[j] = s
        onBeat[j] = o
        offset[j] = f
        prev[j] = i
      }
    }
    // Later chains win ties
    if (
      prev[j] !== -1 &&
      (best === -1 || !ahead(score[best] as number, onBeat[best] as number, offset[best] as number, j))
    ) {
      best = j
    }
  }
  if (best === -1) return null
  const timed: number[] = []
  for (let k = best; k !== -1; k = prev[k] as number) timed.push(k)
  timed.reverse()
  const extras = best - (timed[0] as number) + 1 - timed.length
  return { timed, onBeat: onBeat[best] as number, extras, switches: score[best] as number }
}

/**
 * `chain` if at least `share` of its links are single beats, else (with `trim`) its stretch with the most line changes
 * that is: a timer that sped up from twice the beat joins the chain through missed beats, which would sink the whole run.
 */
export function steadyStretch(
  chain: PacedChain,
  timestamps: readonly number[],
  beatMs: number,
  share: number,
  lines?: readonly unknown[],
  trim = true
): PacedChain | null {
  const { timed } = chain
  const links = timed.length - 1
  if (chain.onBeat >= share * links) return chain
  if (!trim) return null
  const single = new Int32Array(links + 1)
  const changes = new Int32Array(links + 1)
  for (let k = 1; k <= links; k++) {
    const from = timed[k - 1] as number
    const to = timed[k] as number
    const gap = (timestamps[to] as number) - (timestamps[from] as number)
    single[k] = (single[k - 1] as number) + (Math.round(gap / beatMs) === 1 ? 1 : 0)
    changes[k] = (changes[k - 1] as number) + (lines === undefined || lines[from] !== lines[to] ? 1 : 0)
  }
  // Sends timed[a..b], by most changes, later on ties
  let a0 = -1
  let b0 = -1
  for (let a = 0; a < links; a++) {
    for (let b = a + 1; b <= links; b++) {
      if ((single[b] as number) - (single[a] as number) < share * (b - a)) continue
      const c = (changes[b] as number) - (changes[a] as number)
      if (a0 === -1 || c >= (changes[b0] as number) - (changes[a0] as number)) {
        a0 = a
        b0 = b
      }
    }
  }
  if (a0 === -1) return null
  const stretch = timed.slice(a0, b0 + 1)
  return {
    timed: stretch,
    onBeat: (single[b0] as number) - (single[a0] as number),
    extras: (stretch[stretch.length - 1] as number) - (stretch[0] as number) + 1 - stretch.length,
    switches: (changes[b0] as number) - (changes[a0] as number),
  }
}

/** How far apart a timer's single-beat gaps spread at most: chatterbox's ±40 ms request jitter, plus network spikes */
const TIMER_SPREAD_MS = 400

/**
 * Share of `chain`'s single-beat gaps inside the tightest window `TIMER_SPREAD_MS` plus `slackMs` wide: a timer's land
 * within a few hundred ms (two neighbouring whole seconds on a coarse clock), while a chance chain fills its tolerance.
 */
export function tightShare(chain: PacedChain, timestamps: readonly number[], beatMs: number, slackMs = 0): number {
  const gaps: number[] = []
  for (let k = 1; k < chain.timed.length; k++) {
    const gap = (timestamps[chain.timed[k] as number] as number) - (timestamps[chain.timed[k - 1] as number] as number)
    if (Math.round(gap / beatMs) === 1) gaps.push(gap)
  }
  if (gaps.length === 0) return 0
  gaps.sort((a, b) => a - b)
  let most = 0
  for (let i = 0, j = 0; i < gaps.length; i++) {
    while ((gaps[i] as number) - (gaps[j] as number) > TIMER_SPREAD_MS + slackMs) j++
    most = Math.max(most, i - j + 1)
  }
  return most / gaps.length
}
