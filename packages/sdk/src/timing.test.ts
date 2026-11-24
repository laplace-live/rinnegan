import { describe, expect, test } from 'bun:test'

import type { PacedChain } from './timing.ts'

import { seededRandom } from './testing/simulate.ts'
import {
  COARSE_SLACK_MS,
  isLatticeGap,
  latticeShare,
  latticeThreshold,
  likelyBeats,
  MAX_RHYTHM_GAP_MS,
  measureLattice,
  measureRhythm,
  median,
  pacedChain,
  quantile,
  scanLattice,
  steadyStretch,
  tightShare,
} from './timing.ts'

function series(gaps: number[], start = 0): number[] {
  const out = [start]
  for (const gap of gaps) out.push((out[out.length - 1] as number) + gap)
  return out
}

describe('quantile / median', () => {
  test('interpolate', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(quantile([], 0.5)).toBe(0)
  })
})

describe('measureRhythm', () => {
  test('a fixed timer is periodic', () => {
    const rhythm = measureRhythm(series(Array.from({ length: 20 }, (_, i) => 6400 + (i % 3) * 30)))
    expect(rhythm.gaps).toBe(20)
    expect(rhythm.periodic).toBe(1)
    expect(rhythm.cv).toBeLessThan(0.02)
  })

  test('skipped beats still count once most gaps are on the beat', () => {
    const gaps = [5200, 5210, 10_400, 5190, 5205, 15_600, 5200, 5195, 5210, 5200]
    expect(measureRhythm(series(gaps)).periodic).toBe(1)
  })

  test('human gaps are not periodic', () => {
    const random = seededRandom(3)
    const gaps = Array.from({ length: 40 }, () => Math.exp(Math.log(9000) + 0.6 * (random() * 2 - 1)))
    expect(measureRhythm(series(gaps)).periodic).toBeLessThan(0.6)
  })

  test('pauses are excluded', () => {
    expect(measureRhythm(series([1000, MAX_RHYTHM_GAP_MS + 1, 1000])).gaps).toBe(2)
  })

  test('banded catches clamped Gaussian jitter', () => {
    const random = seededRandom(9)
    const gaps = Array.from({ length: 30 }, () => 8000 * (1 + 0.2 * Math.max(-2, Math.min(2, random() * 4 - 2))))
    const rhythm = measureRhythm(series(gaps))
    expect(rhythm.banded).toBeGreaterThanOrEqual(0.9)
    expect(rhythm.onBeat).toBeLessThan(0.6)
  })
})

describe('whole-second slack', () => {
  // A 10.2 s timer read off a clock that keeps whole seconds only
  const coarse = Array.from({ length: 30 }, (_, i) => Math.floor((i * 10_200 + 300) / 1000) * 1000)

  test('keeps a timer periodic on whole seconds', () => {
    expect(measureRhythm(coarse).periodic).toBeLessThan(0.85)
    expect(measureRhythm(coarse, COARSE_SLACK_MS).periodic).toBe(1)
  })

  test('never widens the beat past 15%', () => {
    // 3.3 s reads as 3 s and 4 s gaps; 1 s either way would be a third of the beat.
    const fast = Array.from({ length: 30 }, (_, i) => Math.floor((i * 3300) / 1000) * 1000)
    expect(measureRhythm(fast, COARSE_SLACK_MS).onBeat).toBeLessThan(0.8)
  })
})

describe('paced chains', () => {
  // A 10.2 s timer with a line typed by hand after every third send, and one send swallowed
  const timer = Array.from({ length: 40 }, (_, i) => 5000 + i * 10_200 + ((i * 37) % 60)).filter((_, i) => i !== 20)
  const typed = timer.filter((_, i) => i % 3 === 0).map(at => at + 4100)
  const sends = [...timer, ...typed].sort((a, b) => a - b)
  const gaps = sends.slice(1).map((at, i) => at - (sends[i] as number))

  test('the likeliest beat is the timer the median misses', () => {
    expect(Math.abs((likelyBeats(sends)[0] as number) - 10_200)).toBeLessThanOrEqual(60)
    expect(median(gaps)).toBeLessThan(7000)
  })

  test('tied bands all come up as beats, each band once', () => {
    // A line typed 3 s after every other send: gaps of 3, 7 and 10 s, equally often
    const tied = Array.from({ length: 30 }, (_, i) => i * 10_000).flatMap((at, i) => (i % 2 ? [at] : [at, at + 3000]))
    expect(likelyBeats(tied).sort((a, b) => a - b)).toEqual([3000, 7000, 10_000])
    expect(likelyBeats(tied, 0, 1)).toHaveLength(1)
  })

  test('the chain follows the timer through the typed lines and the swallowed send', () => {
    const chain = pacedChain(sends, likelyBeats(sends)[0] as number)
    expect(chain?.timed.map(i => sends[i])).toEqual(timer)
    expect(chain?.onBeat).toBe(timer.length - 2)
    expect(chain?.extras).toBe(typed.length)
    expect(chain?.switches).toBe(timer.length - 1)
  })

  test('a line typed close to a beat does not knock the chain off the timer', () => {
    // Typed 1.6 s early, then the timer's own send: a greedy pass would take the typed line and lose the beat
    const chain = pacedChain([0, 40_000, 78_400, 80_000, 120_000, 160_000, 200_000], 40_000, COARSE_SLACK_MS)
    expect(chain?.timed).toEqual([0, 1, 3, 4, 5, 6])
    expect(chain?.extras).toBe(1)
  })

  test('counts line changes when given lines, and prefers the chain with more', () => {
    const chain = pacedChain([0, 10_000, 20_000, 30_000, 40_000], 10_000, 0, ['a', 'a', 'b', 'c', 'c'])
    expect(chain?.timed).toHaveLength(5)
    expect(chain?.switches).toBe(2)
  })

  test('of chains as good on line changes, the one more often a single beat apart wins', () => {
    // Two runs of four changes: the earlier one beat apart, the later one two beats apart
    const runs = [0, 10_000, 20_000, 30_000, 40_000, 100_000, 120_000, 140_000, 160_000, 180_000]
    expect(pacedChain(runs, 10_000)?.timed).toEqual([0, 1, 2, 3, 4])
  })

  test('a pause longer than three beats ends a chain', () => {
    const paused = [0, 10_000, 20_000, 30_000, 45_000, 78_000, 88_000, 98_000, 108_000, 118_000]
    expect(pacedChain(paused, 10_000)?.timed).toEqual([5, 6, 7, 8, 9])
  })

  test('null with nothing on the beat', () => {
    expect(pacedChain([0, 3000, 17_000], 10_000)).toBeNull()
    expect(pacedChain([0], 10_000)).toBeNull()
  })

  test('a timer that sped up from twice the beat keeps its steady stretch', () => {
    // Every 20 s, then every 10 s: one chain, but only its fast part is mostly single beats
    const sped = [
      ...Array.from({ length: 11 }, (_, i) => i * 20_000),
      ...Array.from({ length: 20 }, (_, i) => 210_000 + i * 10_000),
    ]
    const chain = pacedChain(sped, 10_000) as PacedChain
    expect(chain.timed).toHaveLength(31)
    expect(chain.onBeat).toBe(20)
    const stretch = steadyStretch(chain, sped, 10_000, 0.8)
    expect(stretch?.timed[0]).toBeLessThanOrEqual(10)
    expect(stretch?.timed.at(-1)).toBe(30)
    expect(stretch?.onBeat).toBeGreaterThanOrEqual(0.8 * ((stretch?.timed.length ?? 0) - 1))
    expect(steadyStretch(chain, sped, 10_000, 0.5)).toBe(chain)
    expect(steadyStretch(chain, sped, 10_000, 0.8, undefined, false)).toBeNull()
  })

  test("a timer's single beats sit close together; a chance chain's fill the tolerance", () => {
    const chain = (gaps: number[]) => {
      const at = [0]
      for (const gap of gaps) at.push((at[at.length - 1] as number) + gap)
      return { at, chain: pacedChain(at, 10_000, COARSE_SLACK_MS) as PacedChain }
    }
    // A 10.4 s timer on whole seconds reads 10 s and 11 s; a chance chain at the same tolerance also reads 9 s and 12 s
    const timer = chain([10_000, 11_000, 10_000, 11_000, 11_000, 10_000, 11_000, 10_000, 11_000, 10_000])
    const chance = chain([9000, 11_000, 12_000, 10_000, 9000, 12_000, 11_000, 9000, 10_000, 12_000])
    expect(tightShare(timer.chain, timer.at, 10_000, COARSE_SLACK_MS)).toBe(1)
    expect(tightShare(chance.chain, chance.at, 10_000, COARSE_SLACK_MS)).toBeLessThan(0.9)
  })
})

describe('send-tick lattice', () => {
  test('isLatticeGap keeps 1–30 s gaps', () => {
    expect([500, 1300, 5200, 31_000].filter(isLatticeGap)).toEqual([1300, 5200])
  })

  test('the counting fit equals trying every tick', () => {
    for (let gap = 900; gap <= 31_000; gap++) expect(measureLattice([gap])).toEqual(scanLattice([gap]))
    for (let seed = 1; seed <= 300; seed++) {
      const random = seededRandom(seed)
      const gaps = Array.from({ length: 1 + Math.floor(random() * 150) }, () => 1000 + Math.floor(random() * 29_000))
      expect(measureLattice(gaps)).toEqual(scanLattice(gaps))
    }
    expect(measureLattice([5200.5, 6500])).toEqual(scanLattice([5200.5, 6500]))
  })

  test('a throttled 1 s chatterbox loop lands on 1.3 s multiples', () => {
    const gaps = [5200, 5230, 6510, 5180, 7800, 5220, 10_400, 5190, 6500, 5210, 5200, 6520]
    const lattice = measureLattice(gaps)
    expect(lattice.share).toBe(1)
    expect(Math.abs(lattice.tickMs - 1300)).toBeLessThanOrEqual(25)
    expect(lattice.share).toBeGreaterThanOrEqual(latticeThreshold(gaps.length))
  })

  test('human gaps stay below the threshold', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const random = seededRandom(seed)
      const gaps = Array.from({ length: 20 }, () => 5000 + random() * 20_000)
      const lattice = measureLattice(gaps)
      expect(lattice.share).toBeLessThan(latticeThreshold(gaps.length))
    }
  })

  test('latticeShare at a given tick', () => {
    expect(latticeShare([2600, 3900, 4150], 1300)).toBeCloseTo(2 / 3)
    expect(latticeShare([], 1300)).toBe(0)
  })

  test('threshold falls with more gaps', () => {
    expect(latticeThreshold(12)).toBeGreaterThan(latticeThreshold(20))
    expect(latticeThreshold(400)).toBeCloseTo(0.4)
  })
})
