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

/** `U+00AD`-style code point label. */
export function codePointLabel(char: string): string {
  return `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`
}

/** Marks tool-inserted chars as `⟨U+00AD⟩` and escapes line breaks, for console, report and AI-prompt output. */
export function escapeInvisible(text: string): string {
  if (!HAS_HIDDEN_RE.test(text)) return text
  const chars = Array.from(text)
  const evasion = evasionIndices(chars)
  return chars
    .map((char, i) => {
      if (WHITESPACE_CONTROLS.has(char)) return JSON.stringify(char).slice(1, -1)
      return evasion.has(i) ? `⟨${codePointLabel(char)}⟩` : char
    })
    .join('')
}

/** User-perceived characters (grapheme clusters). */
export function graphemes(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), ({ segment }) => segment)
}

/** User-perceived character count. */
export function graphemeLength(text: string): number {
  let count = 0
  for (const _ of graphemeSegmenter.segment(text)) count++
  return count
}

/**
 * At most `max` user-perceived chars, never splitting an emoji or surrogate pair; when cut, the last ones are
 * replaced by `tail`. Clip before {@link escapeInvisible} so a `⟨U+…⟩` marker is never cut in half.
 */
export function clip(text: string, max: number, tail = ''): string {
  if (text.length <= max) return text
  const chars = graphemes(text)
  if (chars.length <= max) return text
  return chars.slice(0, Math.max(0, max - graphemeLength(tail))).join('') + tail
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
 * Bucket key for duplicate matching (NFKC, lowercase, hidden chars and decoration removed, character runs collapsed,
 * repeated phrases reduced to one copy; empty only for blank input), plus how many chars survived the stripping.
 */
export function canonicalForm(text: string): { key: string; stripped: number } {
  const visible = text.normalize('NFKC').toLowerCase().replace(HIDDEN_RE, '')
  const stripped = Array.from(visible.replace(DECORATION_RE, ''))
  const base = stripped.length > 0 ? stripped : dominantChar(Array.from(visible.replace(/\s/gu, '')))
  return { key: reduceToPeriod(collapseRuns(base)).join(''), stripped: stripped.length }
}

/** The bucket key of {@link canonicalForm}. */
export function canonicalize(text: string): string {
  return canonicalForm(text).key
}

/** Copies of a `keyLength`-char key in `stripped` chars; at least 1. */
export function copiesOf(stripped: number, keyLength: number): number {
  return keyLength > 0 ? Math.max(1, Math.round(stripped / keyLength)) : 1
}

/**
 * How many copies of `key` the message carries (`爆了爆了爆了` → 3). Burst tools vary this per send to
 * dodge dedup, so a spread of multiplicities at machine speed is a tool fingerprint.
 */
export function multiplicity(text: string, key: string): number {
  return copiesOf(canonicalForm(text).stripped, Array.from(key).length)
}
