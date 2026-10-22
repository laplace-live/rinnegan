const colorEnabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== 'dumb'

function wrap(open: number, close: number): (text: string | number) => string {
  return text => (colorEnabled ? `\x1b[${open}m${text}\x1b[${close}m` : String(text))
}

/** ANSI styling that degrades to plain text when stdout isn't a TTY or `NO_COLOR` is set. */
export const style = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
}

/** `HH:MM:SS` in local time. */
export function clock(ms: number): string {
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** `YYYY-MM-DD HH:MM:SS` in local time. */
export function dateTime(ms: number): string {
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock(ms)}`
}

/** Thousands separators. */
export function count(n: number): string {
  return n.toLocaleString('en-US')
}

export function log(line = ''): void {
  console.log(line)
}

export function warn(line: string): void {
  console.warn(style.yellow(line))
}

export function fail(line: string): void {
  console.error(style.red(line))
}
