import type { BanStore } from '@/store/types'

import { MemoryBanStore } from '@/store/memory'
import { PostgresBanStore } from '@/store/postgres'
import { RedisBanStore } from '@/store/redis'
import { SqliteBanStore } from '@/store/sqlite'
import { maskUrl } from '@/util/url'

export type * from '@/store/types'

export { BanLifecycle, type BanLifecycleOptions, type LifecycleEvent } from '@/store/lifecycle'
export { MemoryBanStore } from '@/store/memory'
export { PostgresBanStore, type PostgresBanStoreOptions } from '@/store/postgres'
export { RedisBanStore, type RedisBanStoreOptions } from '@/store/redis'
export {
  EXPIRY_RULE,
  evaluateRules,
  expiryRule,
  type RuleHook,
  type RuleOutcome,
  SPEND_TO_UNBAN_RULE,
  spendToUnbanRule,
} from '@/store/rules'
export { SqliteBanStore } from '@/store/sqlite'

/**
 * Opens the store `url` names and runs its `init()`.
 *
 * - `memory` / `memory:` → in-process
 * - `postgres://…` / `postgresql://…` → PostgreSQL
 * - `redis://…` / `rediss://…` / `valkey://…` → Redis or Valkey
 * - `sqlite:<path>` or a bare file path → SQLite
 */
export async function createBanStore(url: string): Promise<BanStore> {
  const store = openBanStore(url.trim())
  try {
    await store.init()
  } catch (error) {
    await store.close().catch(() => {})
    throw error
  }
  return store
}

function openBanStore(url: string): BanStore {
  if (url === '') throw new Error('ban store URL is empty')
  if (/^memory(:|$)/i.test(url)) return new MemoryBanStore()
  if (/^postgres(ql)?:\/\//i.test(url)) return new PostgresBanStore(url)
  if (/^(rediss?|valkeys?)(\+[a-z]+)*:\/\//i.test(url)) return new RedisBanStore(url)
  if (/^sqlite:/i.test(url)) {
    const path = url.slice('sqlite:'.length).replace(/^\/\//, '')
    if (path === '') throw new Error(`ban store URL has no SQLite path: ${url}`)
    return new SqliteBanStore(path)
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) throw new Error(`unsupported ban store URL: ${describeStoreUrl(url)}`)
  return new SqliteBanStore(url)
}

/** `url` with any password (userinfo or a `password`-like query parameter) masked, for console output. */
export function describeStoreUrl(url: string): string {
  return maskUrl(url)
}
