/**
 * Text canonicalization for duplicate matching. Folds every dedup-bypass trick LAPLACE Chatterbox and similar
 * tools use (invisible chars, punctuation noise, full-width forms, repeated phrases) into one bucket key.
 */

/** Format, default-ignorable and control chars, plus U+2800 which renders blank but isn't ignorable. */
const HIDDEN_RE = /[\p{Cf}\p{Default_Ignorable_Code_Point}\p{Cc}⠀]/gu
const HAS_HIDDEN_RE = /[\p{Cf}\p{Default_Ignorable_Code_Point}\p{Cc}⠀]/u
const HIDDEN_CHAR_RE = /^[\p{Cf}\p{Default_Ignorable_Code_Point}\p{Cc}⠀]$/u
/** Cosmetic noise: punctuation, math symbols (`~+=<>`), separators/whitespace, combining marks left after NFKC. */
const DECORATION_RE = /[\p{P}\p{Sm}\p{Z}\s\p{Mn}\p{Me}]/gu
const PICTOGRAPHIC_RE = /^\p{Extended_Pictographic}$/u
const WHITESPACE_CONTROLS = new Set(['\t', '\n', '\r'])
const ZWJ = '‍'
const BLACK_FLAG = '\u{1F3F4}'
const TAG_END = '\u{E007F}'

const graphemeSegmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' })

/** Names for the invisible chars spam tools are known to insert. */
const EVASION_CHAR_NAMES: Record<string, string> = {
  '­': '软连字符',
  '͏': '组合用字形连接符',
  '؜': '阿拉伯字母标记',
  ᅟ: '韩文初声填充符',
  ᅠ: '韩文中声填充符',
  '᠎': '蒙古文元音分隔符',
  '​': '零宽空格',
  '‌': '零宽非连接符',
  '‍': '零宽连接符',
  '‎': '左至右标记',
  '‏': '右至左标记',
  '⁠': '词连接符',
  '⠀': '盲文空白',
  ㅤ: '韩文填充符',
  '﻿': '零宽不换行空格',
  ﾠ: '半角韩文填充符',
}

function isTag(char: string): boolean {
  const cp = char.codePointAt(0) ?? 0
  return cp >= 0xe0000 && cp <= 0xe007f
}

function isVariationSelector(char: string): boolean {
  const cp = char.codePointAt(0) ?? 0
  return (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef)
}

function isPictographic(char: string | undefined): boolean {
  return char !== undefined && PICTOGRAPHIC_RE.test(char)
}

/** Indices (into `chars`) of tag chars that belong to a legit emoji tag sequence like 🏴󠁧󠁢󠁳󠁣󠁴󠁿. */
function legitTagIndices(chars: string[]): Set<number> {
  const legit = new Set<number>()
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== BLACK_FLAG) continue
    let j = i + 1
    while (j < chars.length && isTag(chars[j] as string) && chars[j] !== TAG_END) j++
    if (j < chars.length && chars[j] === TAG_END && j > i + 1) {
      for (let k = i + 1; k <= j; k++) legit.add(k)
    }
    i = j
  }
  return legit
}

/** Previous char that isn't a variation selector, so `❤️‍🔥` (heart, VS16, ZWJ, fire) counts as emoji-ZWJ-emoji. */
function previousBase(chars: string[], index: number): string | undefined {
  let i = index - 1
  while (i >= 0 && isVariationSelector(chars[i] as string)) i--
  return chars[i]
}

/**
 * Positions (into `Array.from(text)`) of invisible chars only a tool would put there. Variation selectors, emoji ZWJ
 * sequences, flag tag sequences and plain whitespace controls are legit and skipped.
 */
function evasionIndices(chars: string[]): Set<number> {
  const found = new Set<number>()
  let legitTags: Set<number> | undefined
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i] as string
    if (!HIDDEN_CHAR_RE.test(char)) continue
    if (WHITESPACE_CONTROLS.has(char) || isVariationSelector(char)) continue
    if (char === ZWJ && isPictographic(previousBase(chars, i)) && isPictographic(chars[i + 1])) continue
    if (isTag(char)) {
      legitTags ??= legitTagIndices(chars)
      if (legitTags.has(i)) continue
    }
    found.add(i)
  }
  return found
}

/** Invisible chars in `text` that only a tool would put there, in order. */
export function findEvasionChars(text: string): string[] {
  if (!HAS_HIDDEN_RE.test(text)) return []
  const chars = Array.from(text)
  return [...evasionIndices(chars)].map(i => chars[i] as string)
}

/** `text` without the chars {@link findEvasionChars} reports, i.e. what a viewer actually sees. */
export function stripEvasionChars(text: string): string {
  if (!HAS_HIDDEN_RE.test(text)) return text
  const chars = Array.from(text)
  const evasion = evasionIndices(chars)
  return evasion.size === 0 ? text : chars.filter((_, i) => !evasion.has(i)).join('')
}

/** `U+00AD`-style label with a Chinese name when known. */
export function describeEvasionChar(char: string): string {
  const code = `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`
  if (isTag(char)) return `${code} 标签字符`
  const name = EVASION_CHAR_NAMES[char]
  return name ? `${code} ${name}` : code
}

/** Marks tool-inserted chars as `⟨U+00AD⟩` and escapes line breaks, for console and report output. */
export function escapeInvisible(text: string): string {
  if (!HAS_HIDDEN_RE.test(text)) return text
  const chars = Array.from(text)
  const evasion = evasionIndices(chars)
  return chars
    .map((char, i) => {
      if (WHITESPACE_CONTROLS.has(char)) return JSON.stringify(char).slice(1, -1)
      return evasion.has(i) ? `⟨U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}⟩` : char
    })
    .join('')
}

/** User-perceived character count. */
export function graphemeLength(text: string): number {
  let count = 0
  for (const _ of graphemeSegmenter.segment(text)) count++
  return count
}

/** Collapses runs of 3+ identical chars to 2 so `23333` and `233333` share a bucket. */
function collapseRuns(chars: string[]): string[] {
  const out: string[] = []
  for (const char of chars) {
    const n = out.length
    if (n >= 2 && out[n - 1] === char && out[n - 2] === char) continue
    out.push(char)
  }
  return out
}

/**
 * Smallest repeating unit when the text holds at least two full copies of it, tolerating a cut-off tail:
 * `老公天下第一老公天下第一老公` → `老公天下第一`. Uses the KMP failure function.
 */
export function reduceToPeriod(chars: string[]): string[] {
  const n = chars.length
  if (n < 2) return chars
  const fail = new Array<number>(n).fill(0)
  for (let i = 1, k = 0; i < n; i++) {
    while (k > 0 && chars[i] !== chars[k]) k = fail[k - 1] as number
    if (chars[i] === chars[k]) k++
    fail[i] = k
  }
  const period = n - (fail[n - 1] as number)
  return period < n && n >= period * 2 ? chars.slice(0, period) : chars
}

/** Strict-majority char for pure-decoration input (`？？？/` → `?`), else the input unchanged. */
function dominantChar(chars: string[]): string[] {
  if (chars.length < 2) return chars
  const counts = new Map<string, number>()
  let best = ''
  let bestCount = 0
  for (const char of chars) {
    const count = (counts.get(char) ?? 0) + 1
    counts.set(char, count)
    if (count > bestCount) {
      best = char
      bestCount = count
    }
  }
  return bestCount * 2 > chars.length ? [best] : chars
}

/**
 * Bucket key for duplicate matching: NFKC, lowercase, hidden chars and decoration removed, character runs
 * collapsed and repeated phrases reduced to one copy. Empty only for blank input.
 */
export function canonicalize(text: string): string {
  const visible = text.normalize('NFKC').toLowerCase().replace(HIDDEN_RE, '')
  const stripped = Array.from(visible.replace(DECORATION_RE, ''))
  const base = stripped.length > 0 ? stripped : dominantChar(Array.from(visible.replace(/\s/gu, '')))
  return reduceToPeriod(collapseRuns(base)).join('')
}

/**
 * How many copies of `key` the message carries (`爆了爆了爆了` → 3). Burst tools vary this per send to
 * dodge dedup, so a spread of multiplicities at machine speed is a tool fingerprint.
 */
export function multiplicity(text: string, key: string): number {
  if (!key) return 1
  const stripped = Array.from(text.normalize('NFKC').toLowerCase().replace(HIDDEN_RE, '').replace(DECORATION_RE, ''))
  const keyLength = Array.from(key).length
  return Math.max(1, Math.round(stripped.length / keyLength))
}
