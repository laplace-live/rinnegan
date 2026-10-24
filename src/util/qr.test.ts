import { describe, expect, test } from 'bun:test'
import { stripVTControlCharacters } from 'node:util'
import { encode } from 'uqr'

import { qrCodeUrl } from '@/testing/qr-login'
import { renderQRCode } from '@/util/qr'

const URL = qrCodeUrl('0123456789abcdef0123456789abcdef')
const HALVES: Record<string, [top: boolean, bottom: boolean]> = {
  '█': [true, true],
  '▀': [true, false],
  '▄': [false, true],
  ' ': [false, false],
}

/** Which modules the blocks cover, one row per half line. */
function blocks(rendered: string): boolean[][] {
  return stripVTControlCharacters(rendered)
    .split('\n')
    .flatMap(line => {
      const halves = [...line].map(char => HALVES[char] ?? [])
      return [halves.map(([top]) => top), halves.map(([, bottom]) => bottom)]
    })
}

describe('renderQRCode', () => {
  const { data } = encode(URL, { border: 2 })
  // The odd module count leaves half a line past the last row, with no blocks
  const pastEnd = data.map(() => false)

  test('in color, blocks draw the dark modules, black on bright white', () => {
    const rendered = renderQRCode(URL, true)
    expect(blocks(rendered)).toEqual([...data, pastEnd])
    for (const line of rendered.split('\n')) {
      expect(line).toStartWith('\x1b[30m\x1b[107m')
      expect(line).toEndWith('\x1b[49m\x1b[39m')
    }
  })

  test('plain, blocks draw the light modules for a dark terminal', () => {
    const rendered = renderQRCode(URL, false)
    expect(rendered).toBe(stripVTControlCharacters(rendered))
    expect(blocks(rendered)).toEqual([...data.map(row => row.map(dark => !dark)), pastEnd])
  })

  test("fits Bilibili's login URL in a small terminal", () => {
    const lines = renderQRCode(URL, false).split('\n')
    expect(lines.length).toBeLessThanOrEqual(24)
    expect(Math.max(...lines.map(line => line.length))).toBeLessThanOrEqual(80)
  })
})
