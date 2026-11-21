/**
 * Levenshtein distance over code points, giving up once it provably exceeds `max`.
 * @returns the distance, or `max + 1` when it is larger than `max`.
 */
export function boundedLevenshtein(a: readonly string[], b: readonly string[], max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  let curr = new Array<number>(b.length + 1)
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const value = Math.min((prev[j] as number) + 1, (curr[j - 1] as number) + 1, (prev[j - 1] as number) + cost)
      curr[j] = value
      if (value < rowMin) rowMin = value
    }
    if (rowMin > max) return max + 1
    ;[prev, curr] = [curr, prev]
  }
  const distance = prev[b.length] as number
  return distance > max ? max + 1 : distance
}

/** Edit budget for a fuzzy match: short keys must match exactly, longer ones tolerate a few edits. */
export function fuzzyBudget(length: number): number {
  if (length < 6) return 0
  if (length < 12) return 1
  if (length < 20) return 2
  return 3
}

/**
 * The single char `longer` adds to `base`, with where it went; null unless `longer` is `base` plus one
 * inserted char. A visible custom 随机字符 shows up this way after canonicalization.
 */
export function singleInsertion(
  base: readonly string[],
  longer: readonly string[]
): { char: string; index: number } | null {
  if (longer.length !== base.length + 1) return null
  let i = 0
  while (i < base.length && base[i] === longer[i]) i++
  for (let j = i; j < base.length; j++) {
    if (base[j] !== longer[j + 1]) return null
  }
  return { char: longer[i] as string, index: i }
}

/** Same characters with the same counts (a moved char keeps the multiset). */
export function sameChars(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const counts = new Map<string, number>()
  for (const char of a) counts.set(char, (counts.get(char) ?? 0) + 1)
  for (const char of b) {
    const left = (counts.get(char) ?? 0) - 1
    if (left < 0) return false
    counts.set(char, left)
  }
  return true
}

/**
 * The char a 随机字符 tool moves around: removing one copy of it collapses at least three distinct variants to the
 * same base text. Returns that char and how many variants share the base, or null.
 */
export function insertionJitter(variants: readonly (readonly string[])[]): { char: string; variants: number } | null {
  if (variants.length < 3) return null
  const presence = new Map<string, number>()
  for (const variant of variants) for (const char of new Set(variant)) presence.set(char, (presence.get(char) ?? 0) + 1)
  const candidates = [...presence].filter(([, count]) => count >= 3).map(([char]) => char)
  let best: { char: string; variants: number } | null = null
  for (const char of candidates) {
    const bases = new Map<string, Set<number>>()
    variants.forEach((variant, index) => {
      for (let i = 0; i < variant.length; i++) {
        if (variant[i] !== char) continue
        const base = variant.slice(0, i).join('') + variant.slice(i + 1).join('')
        let owners = bases.get(base)
        if (!owners) {
          owners = new Set()
          bases.set(base, owners)
        }
        owners.add(index)
      }
    })
    for (const owners of bases.values()) {
      if (owners.size >= 3 && (!best || owners.size > best.variants)) best = { char, variants: owners.size }
    }
  }
  return best
}
