import { describe, expect, test } from 'bun:test'

import {
  latticeGaps,
  latticeShare,
  latticeThreshold,
  MAX_RHYTHM_GAP_MS,
  measureLattice,
  measureRhythm,
  median,
  quantile,
} from '@/detect/timing'
import { seededRandom } from '@/testing/simulate'

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

describe('send-tick lattice', () => {
  test('latticeGaps keeps 1–30 s gaps', () => {
    expect(latticeGaps(series([500, 1300, 5200, 31_000]))).toEqual([1300, 5200])
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
