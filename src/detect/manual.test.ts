import { describe, expect, test } from 'bun:test'

import { ManualBlendIndex } from '@/detect/manual'

const T0 = Date.parse('2026-11-20T12:00:00Z')
const ROOM = 1
const ME = 7

type Send = [uid: number, line: string, seconds: number]

function feed(index: ManualBlendIndex, sends: Send[]): void {
  for (const [uid, line, seconds] of [...sends].sort((a, b) => a[2] - b[2])) {
    index.observe(ROOM, uid, `user${uid}`, line, line, T0 + seconds * 1000)
  }
}

/** Rounds a minute apart: `plusOnes` copies of one viewer's line 5 s later, `chants` joined after 3 others, `own` lines. */
function session(plusOnes: number, chants: number, own: number): Send[] {
  const sends: Send[] = []
  const rounds = Math.max(plusOnes, chants, own)
  for (let r = 0; r < rounds; r++) {
    const at = r * 60
    if (r < plusOnes) sends.push([100 + r, `今天的第${r}句话`, at], [ME, `今天的第${r}句话`, at + 5])
    if (r < chants) sends.push([201, `口号${r}`, at + 20], [202, `口号${r}`, at + 21], [203, `口号${r}`, at + 22])
    if (r < chants) sends.push([ME, `口号${r}`, at + 25])
    if (r < own) sends.push([ME, `我自己想说的第${r}句`, at + 40])
  }
  return sends
}

describe('ManualBlendIndex', () => {
  test('marks a viewer who mostly copies others but writes lines of their own', () => {
    const index = new ManualBlendIndex()
    feed(index, session(15, 10, 10))
    expect(index.get(ROOM, ME)).toMatchObject({
      uname: `user${ME}`,
      sends: 35,
      copies: 25,
      chants: 10,
      sources: 15,
      switches: 35,
      ownSwitches: 10,
      plusOneLagMs: 5000,
    })
    expect(index.all().map(blend => blend.uid)).toEqual([ME])
  })

  test('never marks an account that only copies, as 自动融入 does', () => {
    const index = new ManualBlendIndex()
    feed(index, session(15, 15, 0))
    expect(index.get(ROOM, ME)).toBeNull()
  })

  test('needs 20 copies making up half of the text', () => {
    const fewer = new ManualBlendIndex()
    feed(fewer, session(10, 9, 5))
    expect(fewer.get(ROOM, ME)).toBeNull()
    const minority = new ManualBlendIndex()
    feed(minority, session(10, 10, 21))
    expect(minority.get(ROOM, ME)).toBeNull()
  })

  test('counts a line as copied only while someone sent it in the last minute', () => {
    const index = new ManualBlendIndex()
    feed(index, [
      [100, '今天的第一句话', 0],
      [ME, '今天的第一句话', 61],
    ])
    feed(
      index,
      session(20, 0, 5).map(([uid, line, at]): Send => [uid, line, at + 120])
    )
    expect(index.get(ROOM, ME)).toMatchObject({ sends: 26, copies: 20, ownSwitches: 6 })
  })

  test('counts a short reaction only as part of a chant', () => {
    const index = new ManualBlendIndex()
    feed(index, [
      [100, '草', 0],
      [ME, '草', 2],
      [101, '考', 10],
      [102, '考', 11],
      [103, '考', 12],
      [ME, '考', 14],
    ])
    feed(
      index,
      session(19, 0, 6).map(([uid, line, at]): Send => [uid, line, at + 60])
    )
    expect(index.get(ROOM, ME)).toMatchObject({ sends: 26, copies: 20, chants: 1 })
  })

  test('automation proof on any assessment rules the mark out', () => {
    const index = new ManualBlendIndex()
    feed(index, session(15, 10, 10))
    index.judged(ROOM, ME, `user${ME}`, 0.4)
    expect(index.get(ROOM, ME)).not.toBeNull()
    index.judged(ROOM, ME, `user${ME}`, 0.6)
    expect(index.get(ROOM, ME)).toBeNull()
    expect(index.all()).toEqual([])
  })

  test('tallies a chant thousands strong in linear time', () => {
    const index = new ManualBlendIndex()
    const started = performance.now()
    // 30,000 viewers in one minute: a scan of every earlier sender per send would take seconds.
    for (let i = 0; i < 30_000; i++) index.observe(ROOM, 10_000 + i, `v${i}`, '一起刷', '一起刷', T0 + i * 2)
    expect(performance.now() - started).toBeLessThan(1000)
    expect(index.get(ROOM, 39_999)).toBeNull()
  })

  test('keeps rooms apart', () => {
    const index = new ManualBlendIndex()
    for (const [uid, line, seconds] of session(15, 10, 10)) {
      index.observe(uid === ME ? 2 : ROOM, uid, `user${uid}`, line, line, T0 + seconds * 1000)
    }
    expect(index.get(2, ME)).toBeNull()
    expect(index.get(ROOM, ME)).toBeNull()
  })

  test('samples the longest copies, oldest first, with who sent the line before', () => {
    const index = new ManualBlendIndex()
    feed(index, [
      ...session(15, 10, 10),
      [300, '这一句话特别特别长所以会被留作样本', 1000],
      [ME, '这一句话特别特别长所以会被留作样本', 1006],
    ])
    const samples = index.get(ROOM, ME)?.samples ?? []
    expect(samples).toHaveLength(3)
    expect(samples.map(sample => sample.at)).toEqual([...samples.map(sample => sample.at)].sort((a, b) => a - b))
    expect(samples.at(-1)).toEqual({
      at: T0 + 1_006_000,
      text: '这一句话特别特别长所以会被留作样本',
      senders: 1,
      from: 'user300',
      lagMs: 6000,
    })
  })
})
