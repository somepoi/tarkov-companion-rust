/**
 * Keeps the TanStack Query cache in IndexedDB so the app works offline once it
 * has loaded the data once: quests, items, traders, maps, hideout and crafts
 * are served from disk and refreshed in the background when the network is
 * back. Live flea prices and the server status are deliberately not persisted.
 */
import type { PersistQueryClientOptions, PersistedClient, Persister } from '@tanstack/react-query-persist-client'
import { del, get, set } from 'idb-keyval'
import type { QueryClient } from '@tanstack/react-query'

const ONE_DAY = 24 * 60 * 60 * 1000
/** Bump for incompatible adapted data. Additive planning metadata uses explicit
 * schema/freshness guards so upgrades retain last-known offline catalogs. */
const CACHE_SCHEMA = 15
/** Query key roots that are live data and must not be served from disk. */
const LIVE_ROOTS = new Set(['prices', 'status', 'logStats'])

const KEY = 'tarkov-companion-query-cache-v2'
const OLD_KEY = 'tarkov-companion-query-cache'
/** Quiet time before a write: game data changes in bursts (several documents per refresh). */
const WRITE_DELAY = 5000

/**
 * The cache is saved as an object (IndexedDB stores it directly; no multi-MB JSON.stringify on
 * the page), and only when some saved query actually has new data. The stock persister rewrote
 * everything after every cache event, including each flea price-history fetch.
 */
let lastSignature = ''
let pending: PersistedClient | null = null
let timer: ReturnType<typeof setTimeout> | null = null

const signature = (c: PersistedClient) =>
  c.buster + '|' + c.clientState.queries.map((q) => `${JSON.stringify(q.queryKey)}@${q.state.dataUpdatedAt}`).sort().join(',')

function flush() {
  if (timer) clearTimeout(timer)
  timer = null
  const c = pending
  pending = null
  if (c) void set(KEY, c).catch(() => undefined)
}

if (typeof window !== 'undefined') {
  // Leaving the app (or hiding it) saves right away instead of after the delay.
  window.addEventListener('pagehide', flush)
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush())
}

export const persister: Persister = {
  persistClient: async (client) => {
    const sig = signature(client)
    if (sig === lastSignature) return
    lastSignature = sig
    pending = client
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, WRITE_DELAY)
  },
  restoreClient: async () => {
    // The pre-1.12 copy was one big JSON string; drop it (it gets rebuilt on the first fetch).
    void del(OLD_KEY).catch(() => undefined)
    const c = await get<PersistedClient>(KEY).catch(() => undefined)
    if (c && typeof c === 'object' && Array.isArray(c.clientState?.queries)) {
      lastSignature = signature(c)
      return c
    }
    return undefined
  },
  removeClient: async () => {
    pending = null
    lastSignature = ''
    await del(KEY)
  },
}

/** The search bar's window: reads the app's saved data but never writes it (the app window owns it). */
export function readOnlyPersistOptions(client: QueryClient): Omit<PersistQueryClientOptions, 'queryClient'> & { queryClient: QueryClient } {
  return { ...persistOptions(client), persister: { ...persister, persistClient: async () => undefined, removeClient: async () => undefined } }
}

export function persistOptions(client: QueryClient): Omit<PersistQueryClientOptions, 'queryClient'> & { queryClient: QueryClient } {
  return {
    queryClient: client,
    persister,
    maxAge: 30 * ONE_DAY,
    // Only a changed adapted schema invalidates offline data, not every app release.
    buster: `s${CACHE_SCHEMA}`,
    dehydrateOptions: {
      shouldDehydrateQuery: (q) => q.state.status === 'success' && !LIVE_ROOTS.has(String(q.queryKey[0])),
    },
  }
}
