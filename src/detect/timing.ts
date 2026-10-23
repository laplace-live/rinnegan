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

const EMPTY_RHYTHM: Rhythm = { gaps: 0, beatMs: 0, cv: 0, onBeat: 0, periodic: 0, banded: 0 }

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

/** Beat tolerance: ±5% or 200 ms, whichever is wider (network jitter dominates at short intervals). */
function beatTolerance(beatMs: number): number {
  return Math.max(beatMs * 0.05, 200)
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

/** Rhythm of `timestamps` (ms, ascending). */
export function measureRhythm(timestamps: readonly number[]): Rhythm {
  const gaps: number[] = []
  for (let i = 1; i < timestamps.length; i++) {
    const gap = (timestamps[i] as number) - (timestamps[i - 1] as number)
    if (gap <= MAX_RHYTHM_GAP_MS) gaps.push(gap)
  }
  if (gaps.length === 0) return EMPTY_RHYTHM

  const beatMs = quantile(Float64Array.from(gaps).sort(), 0.5)
  const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length
  const variance = gaps.reduce((sum, gap) => sum + (gap - mean) ** 2, 0) / gaps.length
  const tolerance = beatTolerance(beatMs)

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
