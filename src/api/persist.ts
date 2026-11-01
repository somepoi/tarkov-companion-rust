/**
 * Keeps the TanStack Query cache in IndexedDB so the app works offline once it
 * has loaded the data once: quests, items, traders, maps, hideout and crafts
 * are served from disk and refreshed in the background when the network is
 * back. Live flea prices and the server status are deliberately not persisted.
 */
import type { PersistQueryClientOptions, PersistedClient, Persister } from '@tanstack/react-query-persist-client'
import { del, get, set } from 'idb-keyval'
import type { QueryClient } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'

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
type PendingWrite = { client: PersistedClient; signature: string; generation: number }
let lastSignature = ''
let pending: PendingWrite | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let generation = 0
let revision = 0
let clearing = 0
// A removal must follow any already-running write; a delayed older write may
// never resurrect the copy the user just cleared.
let writes: Promise<void> = Promise.resolve()

type PersistenceStatus = { error: string | null; canRetry: boolean }
let status: PersistenceStatus = { error: null, canRetry: false }
const listeners = new Set<() => void>()
const subscribeStatus = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
function report(error: string | null) {
  const canRetry = Boolean(error && pending)
  if (status.error === error && status.canRetry === canRetry) return
  status = { error, canRetry }
  for (const listener of listeners) listener()
}
export function useCachePersistenceStatus(): PersistenceStatus {
  return useSyncExternalStore(subscribeStatus, () => status)
}

function serialize(operation: () => Promise<void>): Promise<void> {
  const result = writes.then(operation)
  writes = result.catch(() => undefined)
  return result
}

function cancelTimer() {
  if (timer) clearTimeout(timer)
  timer = null
}

const signature = (c: PersistedClient) =>
  c.buster + '|' + c.clientState.queries.map((q) => `${JSON.stringify(q.queryKey)}@${q.state.dataUpdatedAt}`).sort().join(',')

function flush(): Promise<void> {
  cancelTimer()
  const job = pending
  pending = null
  if (!job) return writes
  return serialize(async () => {
    if (job.generation !== generation) return
    try {
      await set(KEY, job.client)
      if (job.generation === generation) report(null)
    } catch (cause) {
      if (job.generation !== generation) return
      // Retain only the newest unsaved snapshot. Another flush may already
      // have queued a newer one, in which case it owns the eventual outcome.
      if (lastSignature === job.signature && !pending) pending = job
      report(cause instanceof Error ? cause.message : String(cause))
    }
  })
}

/** Explicit retry does not refetch or discard the last known catalog. */
export const retryCachePersistence = (): Promise<void> => flush()

function isSavedClient(value: unknown): value is PersistedClient {
  if (!value || typeof value !== 'object') return false
  const client = value as Partial<PersistedClient>
  return typeof client.buster === 'string' && client.buster.length <= 128
    && typeof client.timestamp === 'number' && Number.isFinite(client.timestamp)
    && Array.isArray(client.clientState?.queries) && Array.isArray(client.clientState?.mutations)
    && client.clientState.queries.every((query) => Array.isArray(query?.queryKey)
      && typeof query.state?.dataUpdatedAt === 'number' && Number.isFinite(query.state.dataUpdatedAt))
}

async function restoreSavedClient(): Promise<PersistedClient | undefined> {
  const currentGeneration = generation
  const currentRevision = revision
  await writes
  try {
    const client: unknown = await get(KEY)
    if (currentGeneration !== generation) return undefined
    if (isSavedClient(client)) {
      if (currentRevision === revision && !pending) lastSignature = signature(client)
      return client
    }
  } catch (cause) {
    if (currentGeneration === generation) report(cause instanceof Error ? cause.message : String(cause))
  }
  return undefined
}

if (typeof window !== 'undefined') {
  // Leaving the app (or hiding it) saves right away instead of after the delay.
  window.addEventListener('pagehide', () => { void flush() })
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void flush() })
}

export const persister: Persister = {
  persistClient: async (client) => {
    if (clearing) return
    const sig = signature(client)
    if (sig === lastSignature) return
    revision++
    lastSignature = sig
    pending = { client, signature: sig, generation }
    report(status.error)
    cancelTimer()
    timer = setTimeout(() => { void flush() }, WRITE_DELAY)
  },
  // Older string-format copies are ignored, not deleted during restoration.
  // In particular, the searchbar's read-only restoration must perform no writes.
  restoreClient: restoreSavedClient,
  removeClient: async () => {
    const currentGeneration = ++generation
    revision++
    clearing++
    cancelTimer()
    pending = null
    lastSignature = ''
    report(null)
    try {
      await serialize(async () => { await del(KEY); await del(OLD_KEY) })
    } catch (cause) {
      if (currentGeneration === generation) report(cause instanceof Error ? cause.message : String(cause))
      throw cause
    } finally {
      clearing--
    }
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
