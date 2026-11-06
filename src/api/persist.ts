/**
 * Keeps the TanStack Query cache in IndexedDB so the app works offline once it
 * has loaded the data once: quests, items, traders, maps, hideout and crafts
 * are served from disk and refreshed in the background when the network is
 * back. Live flea prices and the server status are deliberately not persisted.
 *
 * Only an incompatible adapted-data schema invalidates the copy — never an app
 * version — and a copy that would be discarded is first kept as the retained
 * last-known-good snapshot instead of being deleted outright. See
 * `restoreSavedClient` for why the seam is there: the upstream persister calls
 * `removeClient()` on both a buster mismatch and `maxAge` expiry, so intercepting
 * restoration is the only place a copy can be preserved before it is destroyed.
 */
import type { PersistQueryClientOptions, PersistedClient, Persister } from '@tanstack/react-query-persist-client'
import { del, delMany, get, getMany, keys, set, setMany } from 'idb-keyval'
import type { QueryClient } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'

const ONE_DAY = 24 * 60 * 60 * 1000
/** Bump for incompatible adapted data. Additive planning metadata uses explicit
 * schema/freshness guards so upgrades retain last-known offline catalogs. */
const CACHE_SCHEMA = 15
/** Only a changed adapted schema invalidates offline data, not every app release. */
const BUSTER = `s${CACHE_SCHEMA}`
/** Query key roots that are live data and must not be served from disk. */
const LIVE_ROOTS = new Set(['prices', 'status', 'logStats'])

const KEY = 'tarkov-companion-query-cache-v2'
const OLD_KEY = 'tarkov-companion-query-cache'
/** The former single archive is still readable. New archives use one key per schema. */
const RETAINED_KEY = 'tarkov-companion-query-cache-retained'
const RETAINED_PREFIX = `${RETAINED_KEY}:`
const RETAINED_INFO_KEY = `${RETAINED_KEY}-latest`
const retainedKey = (buster: string) => RETAINED_PREFIX + buster
/** Quiet time before a write: game data changes in bursts (several documents per refresh). */
const WRITE_DELAY = 5000
const MAX_AGE = 30 * ONE_DAY

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

type RetainedInfo = { at: number; buster: string; usable: boolean }
type PersistenceStatus = { error: string | null; canRetry: boolean; retained: RetainedInfo | null }
let status: PersistenceStatus = { error: null, canRetry: false, retained: null }
const listeners = new Set<() => void>()
const subscribeStatus = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
function report(error: string | null, retained: RetainedInfo | null = status.retained) {
  const canRetry = Boolean(error && pending)
  if (status.error === error && status.canRetry === canRetry && sameRetained(status.retained, retained)) return
  status = { error, canRetry, retained }
  for (const listener of listeners) listener()
}
function sameRetained(a: RetainedInfo | null, b: RetainedInfo | null): boolean {
  return a === b || (a !== null && b !== null && a.at === b.at && a.buster === b.buster && a.usable === b.usable)
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

/** Fresh enough and for this build's adapted schema: safe to hydrate as-is. */
function isRestorable(client: Pick<PersistedClient, 'buster' | 'timestamp'>): boolean {
  return client.buster === BUSTER && client.timestamp > 0 && Date.now() - client.timestamp <= MAX_AGE
}

function infoOf(client: PersistedClient): RetainedInfo {
  return { at: client.timestamp, buster: client.buster, usable: isRestorable(client) }
}

/**
 * Decides what an offline start may use, preserving a copy it is about to stop using.
 *
 * Save incompatible or expired copies under their original schema. A rollback may leave a
 * newer schema in the archive while the live key belongs to an older build.
 *
 * A read-only persister (the search bar) takes the same decision without writing anything.
 */
async function restoreSavedClient(writable: boolean): Promise<PersistedClient | undefined> {
  const currentGeneration = generation
  const currentRevision = revision
  await writes
  if (currentGeneration !== generation) return undefined

  try {
    const [saved, archived, previous, latest] = await getMany<unknown>([
      KEY, retainedKey(BUSTER), RETAINED_KEY, RETAINED_INFO_KEY,
    ])
    if (currentGeneration !== generation) return undefined

    const retained = [archived, previous].filter(isSavedClient)
      .filter(isRestorable).sort((a, b) => b.timestamp - a.timestamp)[0]
    const live = isSavedClient(saved) ? saved : undefined
    const usableLive = live && isRestorable(live) ? live : undefined
    let info = retained ? infoOf(retained) : isSavedClient(previous) ? infoOf(previous) : null
    if (!retained && isRetainedInfo(latest) && (!info || latest.at >= info.at)) {
      info = { ...latest, usable: isRestorable({ buster: latest.buster, timestamp: latest.at }) }
    }
    let error: string | null = null
    if (live && !usableLive && writable) {
      try {
        await serialize(async () => {
          if (currentGeneration !== generation || currentRevision !== revision) return
          const key = retainedKey(live.buster)
          const existing: unknown = await get(key)
          if (currentGeneration !== generation || currentRevision !== revision) return
          if (isSavedClient(existing) && existing.timestamp >= live.timestamp) return
          const details = infoOf(live)
          // Keep the live key until a successful fetch replaces it. Another window may
          // already be writing a fresh catalog, so restoration never deletes that key.
          await setMany([[key, live], [RETAINED_INFO_KEY, details]])
          if (!retained) info = details
        })
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause)
      }
    }
    if (currentGeneration !== generation) return undefined
    const restored = [usableLive, retained].find((client) => client && isRestorable(client))
    if (restored && currentRevision === revision && !pending) lastSignature = signature(restored)
    report(error, info)
    return restored
  } catch (cause) {
    if (currentGeneration === generation) report(cause instanceof Error ? cause.message : String(cause))
    return undefined
  }
}

function isRetainedInfo(value: unknown): value is RetainedInfo {
  if (!value || typeof value !== 'object') return false
  const info = value as Partial<RetainedInfo>
  return typeof info.at === 'number' && Number.isFinite(info.at)
    && typeof info.buster === 'string' && typeof info.usable === 'boolean'
}

async function clearSavedClient(clearRetained: boolean): Promise<void> {
  const currentGeneration = ++generation
  revision++
  clearing++
  cancelTimer()
  pending = null
  lastSignature = ''
  report(null, clearRetained ? null : status.retained)
  try {
    await serialize(async () => {
      if (!clearRetained) return del(KEY)
      const archives = (await keys()).filter((key) => typeof key === 'string' && key.startsWith(RETAINED_PREFIX))
      await delMany([KEY, OLD_KEY, RETAINED_KEY, RETAINED_INFO_KEY, ...archives])
    })
  } catch (cause) {
    if (currentGeneration === generation) report(cause instanceof Error ? cause.message : String(cause))
    throw cause
  } finally {
    clearing--
  }
}

/** Only an explicit user action removes the archives as well as the live copy. */
export const clearOfflineCache = (): Promise<void> => clearSavedClient(true)

if (typeof window !== 'undefined') {
  // Leaving the app (or hiding it) saves right away instead of after the delay.
  window.addEventListener('pagehide', () => { void flush() })
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void flush() })
}

function makePersister(writable: boolean): Persister {
  return {
    persistClient: async (client) => {
      if (!writable || clearing) return
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
    restoreClient: () => restoreSavedClient(writable),
    removeClient: async () => {
      if (!writable) return
      await clearSavedClient(false)
    },
  }
}

export const persister: Persister = makePersister(true)

/** The search bar's window: reads the app's saved data but never writes it (the app window owns it). */
export function readOnlyPersistOptions(client: QueryClient): Omit<PersistQueryClientOptions, 'queryClient'> & { queryClient: QueryClient } {
  return { ...persistOptions(client), persister: makePersister(false) }
}

export function persistOptions(client: QueryClient): Omit<PersistQueryClientOptions, 'queryClient'> & { queryClient: QueryClient } {
  return {
    queryClient: client,
    persister,
    // Restoration checks age before returning a snapshot. A second expiry check could
    // remove the live copy at the threshold without first retaining it.
    maxAge: Infinity,
    // Only a changed adapted schema invalidates offline data, not every app release.
    buster: BUSTER,
    dehydrateOptions: {
      shouldDehydrateQuery: (q) => q.state.status === 'success' && !LIVE_ROOTS.has(String(q.queryKey[0])),
    },
  }
}
