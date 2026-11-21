/** A non-null object that isn't an array, e.g. a parsed JSON object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads `value[k0][k1]…` off untyped data; undefined once a hop isn't an object. */
export function readPath(value: unknown, ...keys: string[]): unknown {
  let current = value
  for (const key of keys) {
    if (!isRecord(current)) return undefined
    current = current[key]
  }
  return current
}

/** Finite number from a number or a numeric string. */
export function toNumber(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

/** Positive safe integer, e.g. a uid or room id. */
export function toId(value: unknown): number | null {
  const n = toNumber(value)
  return n !== null && Number.isSafeInteger(n) && n > 0 ? n : null
}

/** `error.message` for an `Error`, else its string form. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
