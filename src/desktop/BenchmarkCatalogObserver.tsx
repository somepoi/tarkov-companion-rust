import { useEffect } from 'react'
import { useIsRestoring, useQueryClient } from '@tanstack/react-query'
import { useProgressStore } from '../store/progress'
import { BENCHMARK_CATALOG_ROOTS, type BenchmarkCatalogReady } from '../shared/benchmark'
import type { GameData, ItemsBundle } from '../api/types'

/** Mounted only by the main isolated benchmark host. Never fetches or polls. */
export function BenchmarkCatalogObserver() {
  const client = useQueryClient()
  const restoring = useIsRestoring()
  const mode = useProgressStore((state) => state.gameMode)
  useEffect(() => {
    const report = window.desktop?.reportCatalogReady
    if (restoring || !window.desktop?.benchmarkMode || !report) return
    const cache = client.getQueryCache()
    let alive = true, busy = false, pending = false, finished = false
    let stop = () => {}
    const evaluate = async () => {
      if (!alive || finished) return
      if (busy) { pending = true; return }
      const queries = BENCHMARK_CATALOG_ROOTS.map((root) => cache.find({ queryKey: [root, mode], exact: true }))
      if (queries.some((q) => !q || !q.isActive() || q.state.status !== 'success' || q.state.fetchStatus !== 'idle' || !q.state.data)) return
      const snapshots = queries.map((q) => ({ data: q!.state.data, at: q!.state.dataUpdatedAt }))
      busy = true
      try {
        const entries: BenchmarkCatalogReady['queries'] = []
        for (const [index, { data, at }] of snapshots.entries()) {
          if (!alive) return
          const root = BENCHMARK_CATALOG_ROOTS[index]
          const count = root === 'items' ? Object.keys((data as ItemsBundle).items).length
            : root === 'gameData' ? (data as GameData).tasks.length : (data as unknown[]).length
          const representation = JSON.stringify(Array.isArray(data) ? data : { ...data as object, fetchedAt: undefined })
          if (representation.length > 16 * 1024 * 1024) throw new Error('Catalog fingerprint exceeds the measurement budget')
          const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(representation))
          entries.push({ root, count, dataUpdatedAt: at, sha256: Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('') })
        }
        if (!alive || useProgressStore.getState().gameMode !== mode
          || queries.some((q, i) => cache.find({ queryKey: [BENCHMARK_CATALOG_ROOTS[i], mode], exact: true }) !== q
            || !q!.isActive() || q!.state.data !== snapshots[i].data || q!.state.dataUpdatedAt !== snapshots[i].at
            || q!.state.status !== 'success' || q!.state.fetchStatus !== 'idle')) return
        const summary: BenchmarkCatalogReady = { mode, queries: entries }
        await report(summary)
        if (alive) { finished = true; stop() }
      } catch (error) {
        if (alive) console.warn('Benchmark catalog milestone unavailable', error)
      } finally {
        busy = false
        if (pending && alive && !finished) { pending = false; void evaluate() }
      }
    }
    stop = cache.subscribe((event) => {
      if (event.query.queryKey[1] === mode && BENCHMARK_CATALOG_ROOTS.some((root) => root === event.query.queryKey[0])) void evaluate()
    })
    void evaluate()
    return () => { alive = false; stop() }
  }, [client, restoring, mode])
  return null
}
