/** `url` with its password and any `pass`/`pwd`/`secret`/`token`-like query parameter masked, safe to print. */
export function maskUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url.replace(/(\/\/[^/@:]*:)[^/@]*@/, '$1***@')
  }
  let masked = false
  if (parsed.password) {
    parsed.password = '***'
    masked = true
  }
  for (const key of [...parsed.searchParams.keys()]) {
    if (!/pass|pwd|secret|token/i.test(key)) continue
    parsed.searchParams.set(key, '***')
    masked = true
  }
  return masked ? parsed.toString() : url
}
