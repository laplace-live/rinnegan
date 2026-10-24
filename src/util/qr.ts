import { styleText } from 'node:util'
import { encode } from 'uqr'

/**
 * `text` as a QR code for the terminal, two rows of modules per line. With `color` it prints black on bright white,
 * which scans on any theme; without, the blocks draw the light modules, which suits the usual dark terminal.
 */
export function renderQRCode(text: string, color: boolean): string {
  const { data } = encode(text, { border: 2 })
  // Past the last row counts as light, like the border
  const block = (x: number, y: number) => (data[y]?.[x] ?? false) === color
  const lines: string[] = []
  for (let y = 0; y < data.length; y += 2) {
    let line = ''
    for (let x = 0; x < data.length; x++) {
      const top = block(x, y)
      const bottom = block(x, y + 1)
      line += top ? (bottom ? '█' : '▀') : bottom ? '▄' : ' '
    }
    lines.push(color ? styleText(['black', 'bgWhiteBright'], line, { validateStream: false }) : line)
  }
  return lines.join('\n')
}
