import { describe, expect, test } from 'bun:test'

import { boundedLevenshtein, fuzzyBudget, insertionJitter, sameChars, singleInsertion } from '@/detect/similarity'

const chars = (text: string) => Array.from(text)

describe('boundedLevenshtein', () => {
  test('exact distances within the bound', () => {
    expect(boundedLevenshtein(chars('主播今天唱歌了吗'), chars('主播今天唱歌了吗'), 2)).toBe(0)
    expect(boundedLevenshtein(chars('主播今天唱歌了吗'), chars('主播今天唱歌了么'), 2)).toBe(1)
    expect(boundedLevenshtein(chars('abc'), chars(''), 5)).toBe(3)
  })

  test('gives up past the bound', () => {
    expect(boundedLevenshtein(chars('老公天下第一'), chars('完全不同的内容'), 1)).toBe(2)
    expect(boundedLevenshtein(chars('ab'), chars('abcdef'), 2)).toBe(3)
  })
})

describe('fuzzyBudget', () => {
  test('short keys must match exactly', () => {
    expect(fuzzyBudget(2)).toBe(0)
    expect(fuzzyBudget(5)).toBe(0)
    expect(fuzzyBudget(8)).toBe(1)
    expect(fuzzyBudget(15)).toBe(2)
    expect(fuzzyBudget(30)).toBe(3)
  })
})

describe('singleInsertion', () => {
  test('finds a visible custom random char', () => {
    expect(singleInsertion(chars('主播唱歌'), chars('主播丶唱歌'))).toEqual({ char: '丶', index: 2 })
    expect(singleInsertion(chars('主播唱歌'), chars('丶主播唱歌'))).toEqual({ char: '丶', index: 0 })
    expect(singleInsertion(chars('主播唱歌'), chars('主播唱歌丶'))).toEqual({ char: '丶', index: 4 })
  })

  test('rejects anything else', () => {
    expect(singleInsertion(chars('主播唱歌'), chars('主播跳舞了'))).toBeNull()
    expect(singleInsertion(chars('主播唱歌'), chars('主播唱歌'))).toBeNull()
  })
})

describe('sameChars', () => {
  test('compares multisets', () => {
    expect(sameChars(chars('丶主播唱歌'), chars('主播丶唱歌'))).toBe(true)
    expect(sameChars(chars('主播唱歌'), chars('主播跳舞'))).toBe(false)
    expect(sameChars(chars('ab'), chars('abc'))).toBe(false)
  })
})

describe('insertionJitter', () => {
  test('finds the char a visible 随机字符 moves around', () => {
    const variants = ['丶主播唱歌了吗', '主播丶唱歌了吗', '主播唱歌了丶吗', '主播唱歌了吗'].map(chars)
    expect(insertionJitter(variants)).toEqual({ char: '丶', variants: 3 })
  })

  test('needs three variants sharing one base', () => {
    expect(insertionJitter(['丶主播唱歌', '主播丶唱歌'].map(chars))).toBeNull()
    expect(insertionJitter(['老公天下第一', '唱老公天下第一', '老公天下第一啊'].map(chars))).toBeNull()
  })
})
