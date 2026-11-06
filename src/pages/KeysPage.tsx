import { useMemo, useState } from 'react'
import { ChevronRight, KeyRound, Search } from 'lucide-react'
import { KeyDetails } from '../keys/KeyDetails'
import { useGameData, useItems } from '../api/hooks'
import type { Item } from '../api/types'
import { ErrorPanel, LoadingPanel } from '../components/DataState'
import { formatRoubles } from '../lib/format'
import { fleaPurchaseAccess } from '../lib/economy'
import { useFleaRules } from '../hooks/useFleaRules'
import { useLinkParam } from '../lib/linkParam'
import { isFactionEligible } from '../lib/taskStatus'
import { useInventoryStore, useModeInventory } from '../store/inventory'
import { useProfile, useProgressStore } from '../store/progress'

const selectClass =
  'rounded border border-line bg-surface-2 px-2 py-1.5 text-sm text-ink focus:border-accent focus:outline-none'

interface KeyRow {
  item: Item
  unlocks: { mapId: string; mapName: string; doors: number; trunks: number }[]
  quests: { id: string; name: string }[]
}

export function KeysPage() {
  const gameData = useGameData()
  const items = useItems()
  const profile = useProfile()
  const gameMode = useProgressStore((s) => s.gameMode)
  const inventory = useModeInventory()
  const setKeyOwned = useInventoryStore((s) => s.setKeyOwned)
  const fleaRules = useFleaRules(items.data)

  const [search, setSearch] = useState('')
  const [map, setMap] = useState('all')
  const [owned, setOwned] = useState<'all' | 'owned' | 'missing'>('all')
  const [neededOnly, setNeededOnly] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  // Voice commands: "?q=" searches, "?key=<id>" opens that key (filters cleared so its row is there).
  useLinkParam('q', setSearch)
  useLinkParam('key', (id) => {
    setSearch('')
    setMap('all')
    setOwned('all')
    setNeededOnly(false)
    setOpenId(id)
  })

  const rows = useMemo<KeyRow[]>(() => {
    if (!gameData.data || !items.data) return []
    const data = gameData.data
    const unlocksByKey = new Map<string, KeyRow['unlocks']>()
    for (const m of data.maps) {
      const details = data.mapDetails[m.id]
      if (!details) continue
      for (const lock of details.locks) {
        let list = unlocksByKey.get(lock.keyId)
        if (!list) unlocksByKey.set(lock.keyId, (list = []))
        let entry = list.find((u) => u.mapId === m.id)
        if (!entry) list.push((entry = { mapId: m.id, mapName: m.name, doors: 0, trunks: 0 }))
        if (lock.lockType === 'trunk') entry.trunks += 1
        else entry.doors += 1
      }
    }
    const questsByKey = new Map<string, { id: string; name: string }[]>()
    for (const task of data.tasks) {
      if (profile.completedTaskIds.has(task.id) || !isFactionEligible(task, profile.faction)) continue
      const keyIds = new Set<string>()
      for (const k of task.neededKeys) for (const id of k.keyIds) keyIds.add(id)
      for (const o of task.objectives) for (const g of o.requiredKeys) for (const id of g) keyIds.add(id)
      for (const id of keyIds) {
        let list = questsByKey.get(id)
        if (!list) questsByKey.set(id, (list = []))
        list.push({ id: task.id, name: task.name })
      }
    }
    return Object.values(items.data.items)
      .filter((it) => it.types.includes('keys'))
      .map((item) => ({ item, unlocks: unlocksByKey.get(item.id) ?? [], quests: questsByKey.get(item.id) ?? [] }))
  }, [gameData.data, items.data, profile.completedTaskIds, profile.faction])

  const ownedSet = useMemo(() => new Set(inventory.ownedKeyIds), [inventory.ownedKeyIds])

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return rows
      .filter((r) => {
        if (map !== 'all' && !r.unlocks.some((u) => u.mapId === map)) return false
        if (owned === 'owned' && !ownedSet.has(r.item.id)) return false
        if (owned === 'missing' && ownedSet.has(r.item.id)) return false
        if (neededOnly && r.quests.length === 0) return false
        if (needle && !r.item.name.toLowerCase().includes(needle)) return false
        return true
      })
      .sort((a, b) => b.quests.length - a.quests.length || b.unlocks.length - a.unlocks.length || a.item.name.localeCompare(b.item.name))
  }, [rows, search, map, owned, neededOnly, ownedSet])

  if (gameData.isPending || items.isPending) return <LoadingPanel label="keys" />
  if (gameData.isError && !gameData.data) return <ErrorPanel error={gameData.error} onRetry={() => void gameData.refetch()} />
  if (items.isError && !items.data) return <ErrorPanel error={items.error} onRetry={() => void items.refetch()} />

  const ownedCount = rows.filter((r) => ownedSet.has(r.item.id)).length
  const openRow = openId ? rows.find((r) => r.item.id === openId) : undefined

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Keys</h1>
          <p className="text-sm text-ink-muted">
            {ownedCount} of {rows.length} keys owned ({gameMode === 'pve' ? 'PvE' : 'PvP'}). Owned keys show green on the map's locked-door layer. Click a key for its door on the map, pictures, what is behind it and whether it is worth it.
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <label className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-dim" />
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search keys…" aria-label="Search keys" className={`${selectClass} w-56 pl-8`} />
        </label>
        <select value={map} onChange={(e) => setMap(e.target.value)} aria-label="Map" className={selectClass}>
          <option value="all">All maps</option>
          {gameData.data?.maps.map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>
        <select value={owned} onChange={(e) => setOwned(e.target.value as typeof owned)} aria-label="Owned filter" className={selectClass}>
          <option value="all">Owned and missing</option>
          <option value="owned">Owned</option>
          <option value="missing">Missing</option>
        </select>
        <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={neededOnly} onChange={(e) => setNeededOnly(e.target.checked)} /> Needed for a quest</label>
        <span className="ml-auto text-xs text-ink-dim">{filtered.length} keys</span>
      </div>

      <div className="mt-4 overflow-hidden rounded-lg border border-line bg-surface-2">
        <table className="w-full text-sm">
          <thead className="bg-surface-3 text-xs uppercase tracking-wide text-ink-muted">
            <tr>
              <th className="w-16 px-3 py-2 text-left font-medium">Owned</th>
              <th className="px-3 py-2 text-left font-medium">Key</th>
              <th className="px-3 py-2 text-left font-medium">Unlocks</th>
              <th className="px-3 py-2 text-left font-medium">Needed by</th>
              <th className="w-28 px-3 py-2 text-right font-medium">Flea</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {filtered.map((r) => {
              const isOwned = ownedSet.has(r.item.id)
              return (
                <tr key={r.item.id} onClick={() => setOpenId(r.item.id)} className="cursor-pointer hover:bg-surface-3" title="Show where it opens and what is behind it">
                  <td className="px-3 py-1.5" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={isOwned} onChange={(e) => setKeyOwned(gameMode, r.item.id, e.target.checked)} aria-label={`Own ${r.item.name}`} className="h-4 w-4" />
                  </td>
                  <td className="px-3 py-1.5">
                    <div className="flex items-center gap-2">
                      {r.item.iconLink ? <img src={r.item.iconLink} alt="" className="h-7 w-7 object-contain" loading="lazy" /> : <KeyRound className="h-5 w-5 text-ink-dim" />}
                      <span className={isOwned ? 'text-success' : ''}>{r.item.name}</span>
                      <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-ink-dim" aria-hidden />
                    </div>
                  </td>
                  <td className="px-3 py-1.5 text-xs text-ink-muted">
                    {r.unlocks.length === 0
                      ? <span className="text-ink-dim">No locked door in the map data</span>
                      : r.unlocks.map((u) => `${u.mapName}: ${[u.doors ? `${u.doors} door${u.doors > 1 ? 's' : ''}` : '', u.trunks ? `${u.trunks} trunk${u.trunks > 1 ? 's' : ''}` : ''].filter(Boolean).join(', ')}`).join(' · ')}
                  </td>
                  <td className="px-3 py-1.5 text-xs">
                    {r.quests.length === 0 ? <span className="text-ink-dim">—</span> : r.quests.map((q) => q.name).join(', ')}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-xs">
                    {r.item.avg24hPrice == null
                      ? <span className="text-ink-dim">—</span>
                      : (() => {
                        // A catalog average is not a price this character can pay.
                        const flea = fleaPurchaseAccess(r.item, fleaRules)
                        return flea.available
                          ? formatRoubles(r.item.avg24hPrice)
                          : <span className="text-ink-dim" title={`Reference only: ${flea.reason}`}>locked</span>
                      })()}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {filtered.length === 0 && <p className="px-4 py-10 text-center text-sm text-ink-muted">No keys match these filters.</p>}
      </div>
      {openRow && gameData.data && (
        <KeyDetails
          row={openRow}
          data={gameData.data}
          owned={ownedSet.has(openRow.item.id)}
          onToggleOwned={(v) => setKeyOwned(gameMode, openRow.item.id, v)}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  )
}
