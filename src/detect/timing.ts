/** Gaps longer than this are pauses, not part of a send rhythm. */
export const MAX_RHYTHM_GAP_MS = 120_000

/** Sorted-input quantile with linear interpolation. */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0
  const index = (sorted.length - 1) * q
  const lo = Math.floor(index)
  const hi = Math.ceil(index)
  const a = sorted[lo] as number
  return a + ((sorted[hi] as number) - a) * (index - lo)
}

export function median(values: readonly number[]): number {
  return quantile(
    [...values].sort((a, b) => a - b),
    0.5
  )
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

/** Gaps between consecutive `timestamps` (ms, ascending) that a send-queue lattice can explain. */
export function latticeGaps(timestamps: readonly number[]): number[] {
  const gaps: number[] = []
  for (let i = 1; i < timestamps.length; i++) {
    const gap = (timestamps[i] as number) - (timestamps[i - 1] as number)
    if (gap >= LATTICE_MIN_GAP_MS && gap <= LATTICE_MAX_GAP_MS) gaps.push(gap)
  }
  return gaps
}

/**
 * Best fit of gaps to a k × tick lattice. A loop on chatterbox's 1 s default ticks every ~1.3 s and Bilibili drops
 * identical resends inside ~5 s, so its accepted sends land on 5.2 / 6.5 / 7.8 s; human gaps don't.
 */
export function measureLattice(gaps: readonly number[]): Lattice {
  let best: Lattice = { gaps: gaps.length, tickMs: 0, share: 0 }
  if (gaps.length === 0) return best
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

  const sorted = [...gaps].sort((a, b) => a - b)
  const beatMs = quantile(sorted, 0.5)
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
