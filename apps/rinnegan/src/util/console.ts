import { styleText } from 'node:util'

import { DEFAULT_TIME_ZONE, fromWallClock, zoneOffset } from '@/util/time'

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

/** Whether {@link style} colors stdout. */
export function stdoutHasColors(): boolean {
  return style.bold('x') !== 'x'
}

const warning = styled('yellow', process.stderr)
const failure = styled('red', process.stderr)

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

let offsetAt = zoneOffset(DEFAULT_TIME_ZONE)

/** Time zone the formatters below use, whatever the machine's: an IANA name or a UTC offset. Throws when unknown. */
export function setTimeZone(zone: string): void {
  offsetAt = zoneOffset(zone)
}

/** `ms` shifted so its `getUTC*` fields read as the time zone's wall clock. */
function wallClock(ms: number): Date {
  return new Date(ms + offsetAt(ms))
}

/** `HH:MM:SS` in the configured time zone. */
export function clock(ms: number): string {
  const date = wallClock(ms)
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
}

/** `HH:MM` in the configured time zone. */
export function hourMinute(ms: number): string {
  const date = wallClock(ms)
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
}

/** `YYYY-MM-DD` in the configured time zone. */
export function localDate(ms: number): string {
  const date = wallClock(ms)
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

/** `MM-DD` in the configured time zone. */
export function monthDay(ms: number): string {
  const date = wallClock(ms)
  return `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

/** Whether both times fall in one year in the configured time zone. */
export function sameYear(a: number, b: number): boolean {
  return wallClock(a).getUTCFullYear() === wallClock(b).getUTCFullYear()
}

/** `YYYY-MM-DD HH:MM:SS` in the configured time zone. */
export function dateTime(ms: number): string {
  return `${localDate(ms)} ${clock(ms)}`
}

/** Unix ms `minutes` of wall-clock time past the midnight that starts `ms`'s day in the configured time zone. */
export function afterMidnight(ms: number, minutes: number): number {
  const date = wallClock(ms)
  return fromWallClock(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, minutes), offsetAt)
}

/** The configured time zone's offset at `ms`, as `UTC+08:00`. */
export function utcOffset(ms: number): string {
  const minutes = Math.round(offsetAt(ms) / 60_000)
  const abs = Math.abs(minutes)
  return `UTC${minutes < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/** {@link utcOffset} for a time range, naming both ends when a clock change falls inside it. */
export function utcOffsets(from: number, to: number): string {
  const start = utcOffset(from)
  const end = utcOffset(to)
  return start === end ? start : `${start} → ${end}`
}

/** `YYYYMMDD-HHMMSS` in the configured time zone, for file names. */
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
