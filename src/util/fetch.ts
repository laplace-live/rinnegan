/**
 * The `fetch` shape network clients accept, so tests can inject a plain function. Bun's `typeof fetch` also demands
 * `fetch.preconnect`, which fakes don't have; the global `fetch` still fits.
 */
export type FetchLike = (input: string, init: RequestInit) => Response | Promise<Response>
