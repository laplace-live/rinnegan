import { afterEach, describe, expect, test } from 'bun:test'

import { afterMidnight, clock, dateTime, fileStamp, localDate, setTimeZone, utcOffset } from '@/util/console'
import { DEFAULT_TIME_ZONE, parseTime, zoneOffset } from '@/util/time'

const HOUR = 3_600_000
const LA = 'America/Los_Angeles'

describe('zoneOffset', () => {
  test('IANA zones, DST included', () => {
    expect(zoneOffset(DEFAULT_TIME_ZONE)(Date.UTC(2026, 10, 18))).toBe(8 * HOUR)
    expect(zoneOffset(LA)(Date.UTC(2026, 6, 1))).toBe(-7 * HOUR)
    expect(zoneOffset(LA)(Date.UTC(2026, 11, 1))).toBe(-8 * HOUR)
    expect(zoneOffset('utc')(0)).toBe(0)
  })

  test('UTC offsets count east as positive', () => {
    for (const zone of ['+08:00', '+0800', '+8', 'UTC+8', 'gmt+08:00']) expect(zoneOffset(zone)(0)).toBe(8 * HOUR)
    expect(zoneOffset(' UTC-3:30 ')(0)).toBe(-3.5 * HOUR)
  })

  test('rejects unknown zones', () => {
    for (const zone of ['Mars/Olympus', 'UTC+15', '+08:60', 'local', '']) {
      expect(() => zoneOffset(zone)).toThrow('未知的时区')
    }
  })
})

describe('parseTime', () => {
  test('reads dates and times on the zone wall clock', () => {
    expect(parseTime('2026-11-18 20:00', 'x', DEFAULT_TIME_ZONE)).toBe(Date.UTC(2026, 10, 18, 12))
    expect(parseTime('2026-11-18', 'x', DEFAULT_TIME_ZONE)).toBe(Date.UTC(2026, 10, 17, 16))
    expect(parseTime(' 2026/11/8 9:05:30.5 ', 'x', 'UTC')).toBe(Date.UTC(2026, 10, 8, 9, 5, 30, 500))
    expect(parseTime('2026-07-01T20:00', 'x', LA)).toBe(Date.UTC(2026, 6, 2, 3))
    expect(parseTime('2026-12-01T20:00', 'x', LA)).toBe(Date.UTC(2026, 11, 2, 4))
  })

  test('an explicit Z or offset wins over the zone', () => {
    expect(parseTime('2026-10-20T12:00:00.000Z', 'x', DEFAULT_TIME_ZONE)).toBe(Date.UTC(2026, 9, 20, 12))
    expect(parseTime('2026-10-20T20:00+08:00', 'x', LA)).toBe(Date.UTC(2026, 9, 20, 12))
  })

  test('rejects anything else', () => {
    for (const value of ['yesterday', '20:00', 'Oct 20 2026', '2026-10-20 20', '2026-10-20 25:00', '2026-13-01']) {
      expect(() => parseTime(value, '--since', 'UTC')).toThrow('--since 不是有效时间')
    }
  })
})

describe('formatters', () => {
  const at = Date.UTC(2026, 10, 18, 12, 0, 5)
  afterEach(() => setTimeZone(DEFAULT_TIME_ZONE))

  test('show China time by default', () => {
    expect(dateTime(at)).toBe('2026-11-18 20:00:05')
    expect(utcOffset(at)).toBe('UTC+08:00')
  })

  test('follow setTimeZone', () => {
    setTimeZone(LA)
    expect(localDate(at)).toBe('2026-11-18')
    expect(clock(at)).toBe('04:00:05')
    expect(fileStamp(at)).toBe('20261118-040005')
    expect(utcOffset(at)).toBe('UTC-08:00')
    setTimeZone('UTC+5:45')
    expect(dateTime(at)).toBe('2026-11-18 17:45:05')
    expect(utcOffset(at)).toBe('UTC+05:45')
  })

  test('afterMidnight counts wall-clock minutes from the zone’s midnight', () => {
    expect(afterMidnight(at, 0)).toBe(Date.UTC(2026, 10, 17, 16))
    expect(afterMidnight(at, 90)).toBe(Date.UTC(2026, 10, 17, 17, 30))
    setTimeZone(LA)
    // Clocks spring forward on Mar 8, so 03:00 comes two hours after midnight and the next midnight 23
    const noon = Date.UTC(2026, 2, 8, 19)
    expect(afterMidnight(noon, 180)).toBe(Date.UTC(2026, 2, 8, 10))
    expect(afterMidnight(noon, 1440)).toBe(Date.UTC(2026, 2, 9, 7))
  })

  test('never throw on a bad timestamp', () => {
    expect(() => dateTime(Number.NaN)).not.toThrow()
  })
})
