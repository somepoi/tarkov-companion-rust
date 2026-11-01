export const BENCHMARK_CATALOG_ROOTS = ['gameData', 'items', 'hideout'] as const
export interface BenchmarkCatalogReady {
  mode: 'pve' | 'regular'
  queries: { root: typeof BENCHMARK_CATALOG_ROOTS[number]; count: number; dataUpdatedAt: number; sha256: string }[]
}

/** Small diagnostics only: no renderer-selected paths or arbitrary query values. */
export function validBenchmarkCatalog(value: unknown): value is BenchmarkCatalogReady {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  if (Object.keys(v).some((key) => !['mode', 'queries'].includes(key))
    || typeof v.mode !== 'string' || !['pve', 'regular'].includes(v.mode) || !Array.isArray(v.queries) || v.queries.length !== 3) return false
  const roots = new Set<string>()
  for (const q of v.queries) {
    if (!q || typeof q !== 'object' || Array.isArray(q)
      || Object.keys(q).some((key) => !['root', 'count', 'dataUpdatedAt', 'sha256'].includes(key))
      || !BENCHMARK_CATALOG_ROOTS.includes(q.root) || roots.has(q.root)
      || !Number.isSafeInteger(q.count) || q.count < 0 || q.count > 10_000_000
      || !Number.isSafeInteger(q.dataUpdatedAt) || q.dataUpdatedAt <= 0 || q.dataUpdatedAt > 8_640_000_000_000_000
      || typeof q.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(q.sha256)) return false
    roots.add(q.root)
  }
  return true
}
