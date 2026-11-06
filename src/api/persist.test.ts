import type { PersistedClient } from '@tanstack/react-query-persist-client'
import { beforeEach, expect, it, vi } from 'vitest'
import { clearOfflineCache, persister } from './persist'

const storage = vi.hoisted(() => new Map<IDBValidKey, unknown>())
vi.mock('idb-keyval', () => ({
  get: async (key: IDBValidKey) => storage.get(key),
  getMany: async (keys: IDBValidKey[]) => keys.map((key) => storage.get(key)),
  set: async (key: IDBValidKey, value: unknown) => { storage.set(key, value) },
  setMany: async (entries: [IDBValidKey, unknown][]) => {
    for (const [key, value] of entries) storage.set(key, value)
  },
  del: async (key: IDBValidKey) => { storage.delete(key) },
  delMany: async (keys: IDBValidKey[]) => {
    for (const key of keys) storage.delete(key)
  },
  keys: async () => [...storage.keys()],
}))

const liveKey = 'tarkov-companion-query-cache-v2'
const legacyArchiveKey = 'tarkov-companion-query-cache-retained'
const snapshot = (buster: string): PersistedClient => ({
  buster,
  timestamp: Date.now(),
  clientState: { queries: [], mutations: [] },
})

beforeEach(() => { storage.clear() })

it('restores a compatible retained catalog even when the live catalog belongs to another schema', async () => {
  const compatible = snapshot('s15')
  const incompatible = snapshot('s14')
  storage.set(liveKey, incompatible)
  storage.set(legacyArchiveKey, compatible)

  expect(await persister.restoreClient()).toEqual(compatible)
  expect(storage.get(legacyArchiveKey)).toEqual(compatible)
  expect(storage.get(`${legacyArchiveKey}:s14`)).toEqual(incompatible)
})

it('preserves archives on automatic removal and clears them on explicit request', async () => {
  const compatible = snapshot('s15')
  storage.set(liveKey, snapshot('s14'))
  storage.set(`${legacyArchiveKey}:s15`, compatible)
  storage.set('unrelated', true)
  expect(await persister.restoreClient()).toEqual(compatible)

  await persister.removeClient()
  expect(await persister.restoreClient()).toEqual(compatible)

  await clearOfflineCache()
  expect(await persister.restoreClient()).toBeUndefined()
  expect([...storage.keys()]).toEqual(['unrelated'])
})
