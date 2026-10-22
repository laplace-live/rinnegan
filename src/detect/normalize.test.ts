import { describe, expect, test } from 'bun:test'

import {
  canonicalize,
  describeEvasionChar,
  escapeInvisible,
  findEvasionChars,
  graphemeLength,
  multiplicity,
  reduceToPeriod,
  stripEvasionChars,
} from '@/detect/normalize'
import { INVISIBLE_PRESETS } from '@/testing/simulate'

describe('findEvasionChars', () => {
  test.each([...INVISIBLE_PRESETS])('flags chatterbox preset %p', char => {
    expect(findEvasionChars(`老公天${char}下第一`)).toEqual([char])
  })

  test('flags blank-rendering fillers', () => {
    expect(findEvasionChars('爆⠀了')).toEqual(['⠀'])
    expect(findEvasionChars('爆ㅤ了')).toEqual(['ㅤ'])
    expect(findEvasionChars('爆͏了')).toEqual(['͏'])
  })

  test('ignores legit emoji sequences', () => {
    expect(findEvasionChars('👨‍👩‍👧 全家福')).toEqual([])
    expect(findEvasionChars('❤️‍🔥 燃起来了')).toEqual([])
    expect(findEvasionChars('☂️ 伞来')).toEqual([])
    expect(findEvasionChars('🏴󠁧󠁢󠁳󠁣󠁴󠁿 苏格兰')).toEqual([])
  })

  test('flags a ZWJ that joins nothing and tag chars outside a flag', () => {
    expect(findEvasionChars('懂‍你意思')).toEqual(['‍'])
    expect(findEvasionChars('奶姐\u{E0020}，资源发你私信了\u{E0021}')).toEqual(['\u{E0020}', '\u{E0021}'])
  })

  test('ignores whitespace controls', () => {
    expect(findEvasionChars('第一行\r\n第二行\t')).toEqual([])
  })
})

describe('stripEvasionChars', () => {
  test('removes tool chars but keeps emoji joiners', () => {
    expect(stripEvasionChars('千­舰👨‍👩‍👧​')).toBe('千舰👨‍👩‍👧')
  })

  test('returns plain text untouched', () => {
    const text = '主播晚上好'
    expect(stripEvasionChars(text)).toBe(text)
  })
})

describe('canonicalize', () => {
  test('folds every invisible preset into one key', () => {
    const keys = new Set(INVISIBLE_PRESETS.map(char => canonicalize(`老公天${char}下第一！`)))
    keys.add(canonicalize('老公天下第一'))
    expect([...keys]).toEqual(['老公天下第一'])
  })

  test('folds full-width forms, case and punctuation', () => {
    expect(canonicalize('ＬＬＴＴＨＨＢ！！')).toBe('lltthhb')
    expect(canonicalize('【主播好】')).toBe('主播好')
    expect(canonicalize('懂 你 意 思 ~')).toBe('懂你意思')
  })

  test('reduces repeated phrases, including a cut-off tail at the length limit', () => {
    expect(canonicalize('千舰！千舰！千舰！千舰！千舰！')).toBe('千舰')
    expect(canonicalize('米虫骂你出生，米虫骂你出生，米虫骂你出生，米虫骂你出生，米虫骂你出生，米虫骂你出')).toBe(
      '米虫骂你出生'
    )
    expect(canonicalize('老公天下第一！老公天下第一！老公天下第一！老公天下第一！老公')).toBe('老公天下第一')
  })

  test('collapses character runs', () => {
    expect(canonicalize('23333')).toBe(canonicalize('2333333'))
    expect(canonicalize('哈哈哈哈哈哈')).toBe('哈')
    expect(canonicalize('🍷🍷🍷🍷🍷')).toBe('🍷')
  })

  test('keeps pure punctuation meaningful', () => {
    expect(canonicalize('？？？')).toBe('?')
    expect(canonicalize('?')).toBe('?')
    expect(canonicalize('。。。')).toBe('。')
  })

  test('does not merge different short messages', () => {
    expect(canonicalize('好好学习')).not.toBe(canonicalize('学习'))
    expect(canonicalize('懂你意思')).not.toBe(canonicalize('不懂你意思'))
  })

  test('is empty only for blank input', () => {
    expect(canonicalize('   ')).toBe('')
    expect(canonicalize('­')).toBe('')
  })
})

describe('reduceToPeriod', () => {
  test('needs two full copies', () => {
    expect(reduceToPeriod(Array.from('abcabca')).join('')).toBe('abc')
    expect(reduceToPeriod(Array.from('abcab')).join('')).toBe('abcab')
    expect(reduceToPeriod(Array.from('🍆奶绿🥖🍆奶绿🥖')).join('')).toBe('🍆奶绿🥖')
  })
})

describe('multiplicity', () => {
  test('counts copies of the key', () => {
    expect(multiplicity('爆了爆了爆了', '爆了')).toBe(3)
    expect(multiplicity('爆了', '爆了')).toBe(1)
    expect(multiplicity('千舰！千舰！千舰！', canonicalize('千舰！千舰！千舰！'))).toBe(3)
  })
})

describe('display helpers', () => {
  test('escapeInvisible marks tool chars and leaves emoji sequences alone', () => {
    expect(escapeInvisible('千­舰')).toBe('千⟨U+00AD⟩舰')
    expect(escapeInvisible('a\nb')).toBe('a\\nb')
    expect(escapeInvisible('伞来☂️ 👨‍👩‍👧')).toBe('伞来☂️ 👨‍👩‍👧')
    expect(escapeInvisible('懂‍你')).toBe('懂⟨U+200D⟩你')
  })

  test('describeEvasionChar names known chars', () => {
    expect(describeEvasionChar('­')).toBe('U+00AD 软连字符')
    expect(describeEvasionChar('\u{E0021}')).toBe('U+E0021 标签字符')
  })

  test('graphemeLength counts user-perceived chars', () => {
    expect(graphemeLength('👨‍👩‍👧好')).toBe(2)
  })
})
