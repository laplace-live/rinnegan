import { describe, expect, test } from 'bun:test'

import { CrowdIndex } from '@/detect/crowd'

describe('CrowdIndex', () => {
  test('counts other senders of a key per room', () => {
    const crowd = new CrowdIndex(60_000)
    crowd.add(1, '爆了', 10, 0)
    crowd.add(1, '爆了', 11, 1000)
    crowd.add(1, '爆了', 11, 2000)
    crowd.add(2, '爆了', 12, 2000)
    expect(crowd.others(1, '爆了', 10)).toBe(1)
    expect(crowd.others(1, '爆了', 99)).toBe(2)
    expect(crowd.others(2, '爆了', 10)).toBe(1)
    expect(crowd.others(1, '无语', 10)).toBe(0)
  })

  test('expires senders after the window unless they sent again', () => {
    const crowd = new CrowdIndex(10_000)
    crowd.add(1, '爆了', 10, 0)
    crowd.add(1, '爆了', 11, 0)
    crowd.add(1, '爆了', 11, 8000)
    crowd.add(1, '无语', 12, 12_000)
    expect(crowd.others(1, '爆了', 99)).toBe(1)
  })

  test('recognizes copies of a jittered raw text', () => {
    const crowd = new CrowdIndex(60_000)
    crowd.add(1, '千舰', 10, 0, '千­舰')
    expect(crowd.echoes(1, '千­舰', 11)).toBe(true)
    expect(crowd.echoes(1, '千­舰', 10)).toBe(false)
    expect(crowd.echoes(1, '­千舰', 11)).toBe(false)
  })
})
