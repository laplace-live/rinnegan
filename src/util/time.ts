/** Bilibili runs on China time, so times are read and shown in it unless `--timezone` picks another zone. */
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai'

/** `+08:00`, `+0800`, `+8`, `UTC+8`, `GMT-5`… */
const OFFSET = /^(?:UTC|GMT)?([+-])(\d{1,2})(?::?(\d{2}))?$/i

/** `2026-10-20`, `2026/10/20 20:00`, `2026-10-20T20:00:30.5`…, optionally ending in `Z` or an offset */
const TIME =
  /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:(?:T|\s+)(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?(Z|[+-]\d{2}:?\d{2})?$/

function unknownZone(zone: string): Error {
  return new Error(`未知的时区「${zone}」，可用 IANA 名称（如 Asia/Shanghai）或 UTC 偏移（如 UTC+8）`)
}

function wallClockFormat(zone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: zone.trim(),
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
  } catch {
    throw unknownZone(zone)
  }
}

/**
 * Offset from UTC in ms at an instant, for an IANA zone or a fixed offset such as `+08:00`, `UTC+8` or `GMT-5`
 * (east positive, unlike POSIX `TZ`). Throws when the zone is unknown.
 */
export function zoneOffset(zone: string): (ms: number) => number {
  const fixed = OFFSET.exec(zone.trim())
  if (fixed) {
    const [, sign, hours = '', minutes = '0'] = fixed
    if (Number(hours) > 14 || Number(minutes) > 59) throw unknownZone(zone)
    const offset = (sign === '-' ? -60_000 : 60_000) * (Number(hours) * 60 + Number(minutes))
    return () => offset
  }
  const format = wallClockFormat(zone)
  return ms => {
    // formatToParts throws on NaN, which the formatters have always printed as NaN fields
    if (!Number.isFinite(ms)) return 0
    const fields: Record<string, number> = {}
    for (const { type, value } of format.formatToParts(ms)) fields[type] = Number(value)
    const { year = 0, month = 1, day = 1, hour = 0, minute = 0, second = 0 } = fields
    return Date.UTC(year, month - 1, day, hour, minute, second) - Math.floor(ms / 1000) * 1000
  }
}

/** Unix ms at which a zone's clock reads `wall`, given as the UTC ms of its fields. */
export function fromWallClock(wall: number, offsetAt: (ms: number) => number): number {
  // Offset at the instant itself rather than at the wall-clock reading, so DST zones land right
  return wall - offsetAt(wall - offsetAt(wall))
}

/** Unix ms of `2026-10-20`, `2026-10-20 20:00` or an ISO time, read in `zone` unless it ends in `Z` or an offset. */
export function parseTime(value: string, label: string, zone: string): number {
  const match = TIME.exec(value.trim())
  if (match) {
    const [, year, month = '', day = '', hour = '0', minute = '00', second = '00', designator] = match
    const two = (text: string) => text.padStart(2, '0')
    const ms = Date.parse(`${year}-${two(month)}-${two(day)}T${two(hour)}:${minute}:${second}${designator ?? 'Z'}`)
    if (Number.isFinite(ms)) return designator ? ms : fromWallClock(ms, zoneOffset(zone))
  }
  throw new Error(`${label} 不是有效时间：${value}（格式如 2026-10-20 20:00）`)
}
