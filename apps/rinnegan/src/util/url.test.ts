import { describe, expect, test } from 'bun:test'

import { maskUrl } from '@/util/url'

describe('maskUrl', () => {
  test('masks tokens in event source URLs', () => {
    expect(maskUrl('ws://lef:8080/?token=secret&rooms=1')).toBe('ws://lef:8080/?token=***&rooms=1')
    expect(maskUrl('ws://lef:8080/?rooms=1')).toBe('ws://lef:8080/?rooms=1')
  })

  test('masks userinfo even when the URL does not parse', () => {
    expect(maskUrl('redis://:secret@127.0.0.1:6379/0')).toBe('redis://:***@127.0.0.1:6379/0')
    expect(maskUrl('not a url://user:secret@host')).toBe('not a url://user:***@host')
  })
})
