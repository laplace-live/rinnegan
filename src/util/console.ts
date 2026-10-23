import { styleText } from 'node:util'

type Format = Parameters<typeof styleText>[0]

/** `styleText` drops the escapes itself when the stream isn't a TTY or `NO_COLOR` / `TERM=dumb` is set. */
function styled(format: Format, stream: NodeJS.WriteStream = process.stdout): (text: string | number) => string {
  return text => styleText(format, String(text), { stream })
}

/** Terminal styling for stdout. */
export const style = {
  bold: styled('bold'),
  red: styled('red'),
  yellow: styled('yellow'),
  cyan: styled('cyan'),
  gray: styled('gray'),
}

const warning = styled('yellow', process.stderr)
const failure = styled('red', process.stderr)

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** `HH:MM:SS` in local time. */
export function clock(ms: number): string {
  const date = new Date(ms)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** `YYYY-MM-DD` in local time. */
export function localDate(ms: number): string {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** `YYYY-MM-DD HH:MM:SS` in local time. */
export function dateTime(ms: number): string {
  return `${localDate(ms)} ${clock(ms)}`
}

/** `YYYYMMDD-HHMMSS` in local time, for file names. */
export function fileStamp(ms: number): string {
  return dateTime(ms).replace(/[-:]/g, '').replace(' ', '-')
}

/** Thousands separators. */
export function count(n: number): string {
  return n.toLocaleString('en-US')
}

export function log(line = ''): void {
  console.log(line)
}

export function warn(line: string): void {
  console.warn(warning(line))
}

export function fail(line: string): void {
  console.error(failure(line))
}
