import { styleText } from 'node:util'
import { renderUnicodeCompact } from 'uqr'

/**
 * `text` as a QR code for the terminal, two rows of modules per line. With `color` it prints black on bright white,
 * which scans on any theme; without, the blocks draw the light modules, which suits the usual dark terminal.
 */
export function renderQRCode(text: string, color: boolean): string {
  // uqr's blocks draw the light modules; inverted, they draw the dark ones
  const code = renderUnicodeCompact(text, { border: 2, invert: color })
  if (!color) return code
  return code
    .split('\n')
    .map(line => styleText(['black', 'bgWhiteBright'], line, { validateStream: false }))
    .join('\n')
}
