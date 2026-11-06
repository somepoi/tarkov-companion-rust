import { Fragment, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, ScanSearch, Search } from 'lucide-react'
import { imageFromClipboard, useScanStore } from '../scan/scanStore'
import { ErrorPanel, LoadingPanel } from '../components/DataState'
import { useNeeds } from '../hooks/useNeeds'
import { formatNumber } from '../lib/format'
import { countedNeed, type NeedCount } from '../lib/needs'
import { useInventoryStore } from '../store/inventory'
import { useLinkParam } from '../lib/linkParam'
import { useProgressStore } from '../store/progress'

const selectClass =
  'rounded border border-line bg-surface-2 px-2 py-1.5 text-sm text-ink focus:border-accent focus:outline-none'

type SortKey = 'name' | 'needed' | 'remaining'

const COUNT_KEY = 'tc-items-count'
function loadCount(): NeedCount {
  try {
    const saved = localStorage.getItem(COUNT_KEY)
    return saved === 'fir' || saved === 'any' ? saved : 'all'
  } catch {
    return 'all'
  }
}

/** Opens the stash scanner; Ctrl+V with a screenshot on this page opens it with the image. */
function ScanButton() {
  const openWith = useScanStore((s) => s.openWith)
  const open = useScanStore((s) => s.open)
  useEffect(() => {
    if (open) return
    const onPaste = (e: ClipboardEvent) => {
      const img = imageFromClipboard(e)
      if (img) openWith(img)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [open, openWith])
  return (
    <button type="button" onClick={() => openWith()} className="btn" title="Recognise items from a stash screenshot (or press Ctrl+V with one copied)">
      <ScanSearch className="h-4 w-4" /> Scan screenshot
    </button>
  )
}

export function ItemCollectionPage() {
  const { needs, gameData, hideout, items, inventory } = useNeeds()
  const gameMode = useProgressStore((s) => s.gameMode)
  const setCollected = useInventoryStore((s) => s.setCollected)

  const [search, setSearch] = useState('')
  useLinkParam('q', setSearch)
  const [count, setCount] = useState<NeedCount>(loadCount)
  const [trader, setTrader] = useState('all')
  const [station, setStation] = useState('all')
  const [hideDone, setHideDone] = useState(true)
  const [sort, setSort] = useState<SortKey>('remaining')
  const [expanded, setExpanded] = useState<string | null>(null)

  const counted = useMemo(() => Array.from(needs.values(), (need) => {
    const selected = countedNeed(need, count)
    const collected = inventory.collected[need.itemId] ?? 0
    // The checklist has one aggregate count per item and cannot verify FIR.
    const remaining = count === 'fir' ? selected.total : Math.max(0, selected.total - collected)
    return { need, ...selected, collected, remaining }
  }).filter((row) => row.total > 0 || row.review), [needs, count, inventory.collected])

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const name = (id: string) => items.data?.items[id]?.name ?? id
    const list = counted.filter(({ need, sources, remaining, review }) => {
      if (trader !== 'all' && !sources.some((s) => s.kind === 'quest' && s.traderId === trader)) return false
      if (station !== 'all' && !sources.some((s) => (s.kind === 'hideout' || s.kind === 'craft') && s.stationId === station)) return false
      if (hideDone && !review && remaining === 0) return false
      if (needle && !name(need.itemId).toLowerCase().includes(needle)) return false
      return true
    })
    list.sort((a, b) => {
      const byName = () => name(a.need.itemId).localeCompare(name(b.need.itemId))
      if (sort === 'name') return byName()
      if (sort === 'needed') return b.total - a.total || byName()
      return b.remaining - a.remaining || byName()
    })
    return list
  }, [counted, items.data, trader, station, hideDone, search, sort])

  const progress = useMemo(() => {
    let needed = 0
    let have = 0
    for (const row of counted) {
      needed += row.total
      have += row.total - row.remaining
    }
    return { needed, have, pct: needed ? Math.round((100 * have) / needed) : 0 }
  }, [counted])

  const tradersUsed = useMemo(() => {
    const ids = new Set<string>()
    for (const n of needs.values()) for (const s of n.sources) if (s.kind === 'quest') ids.add(s.traderId)
    return (gameData.data?.traders ?? []).filter((t) => ids.has(t.id))
  }, [needs, gameData.data])

  if (gameData.isPending) return <LoadingPanel label="quests" />
  if (gameData.isError && !gameData.data) return <ErrorPanel error={gameData.error} onRetry={() => void gameData.refetch()} />

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Item Collection</h1>
          <p className="text-sm text-ink-muted">
            Everything your remaining {gameMode === 'pve' ? 'PvE' : 'PvP'} quests and unbuilt hideout levels still need.
            {hideout.isPending ? ' Loading hideout…' : ''}
            {items.isPending ? ' Loading item names…' : ''}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <ScanButton />
          <div className="text-right text-xs text-ink-muted">
            {count === 'fir'
              ? `${formatNumber(progress.needed)} items with a known found-in-raid requirement`
              : `${formatNumber(progress.have)} / ${formatNumber(progress.needed)} items counted (${progress.pct}%)`}
          </div>
        </div>
      </div>
      {count !== 'fir' && <div className="mt-3 h-2 w-full overflow-hidden rounded bg-surface-3">
        <div className="h-full bg-accent transition-[width]" style={{ width: `${progress.pct}%` }} />
      </div>}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <label className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-dim" />
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search items…" aria-label="Search items" className={`${selectClass} w-56 pl-8`} />
        </label>
        <select value={trader} onChange={(e) => setTrader(e.target.value)} aria-label="Trader" className={selectClass}>
          <option value="all">All traders</option>
          {tradersUsed.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
        <select value={station} onChange={(e) => setStation(e.target.value)} aria-label="Hideout station" className={selectClass}>
          <option value="all">All stations</option>
          {(hideout.data ?? []).map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort" className={selectClass}>
          <option value="remaining">Most remaining first</option>
          <option value="needed">Most needed first</option>
          <option value="name">Name</option>
        </select>
        <select value={count} onChange={(e) => {
          const value = e.target.value as NeedCount
          setCount(value)
          try { localStorage.setItem(COUNT_KEY, value) } catch { /* Session-only preference. */ }
        }} aria-label="Which needs to count" className={selectClass}>
          <option value="all">Count all needs</option>
          <option value="fir">Count found-in-raid needs</option>
          <option value="any">Count needs that accept any copy</option>
        </select>
        <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} /> Hide completed</label>
        <span className="ml-auto text-xs text-ink-dim">{rows.length} items</span>
      </div>
      {count === 'fir' && <p className="mt-2 text-xs text-ink-muted">Collected counts do not track found-in-raid status. Confirm eligible stacks in Stash Manager.</p>}

      <div className="mt-4 overflow-hidden rounded-lg border border-line bg-surface-2">
        <table className="w-full text-sm">
          <thead className="bg-surface-3 text-xs uppercase tracking-wide text-ink-muted">
            <tr>
              <th className="w-10 px-2 py-2" />
              <th className="px-3 py-2 text-left font-medium">Item</th>
              <th className="w-28 px-3 py-2 text-right font-medium" title="Found in raid / not">Needed</th>
              <th className="w-28 px-3 py-2 text-right font-medium">Collected</th>
              <th className="w-24 px-3 py-2 text-right font-medium">Remaining</th>
              <th className="w-40 px-3 py-2 text-left font-medium">Used by</th>
              <th className="w-8 px-2 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map(({ need: n, total, sources, collected, remaining, review }) => {
              const item = items.data?.items[n.itemId]
              const open = expanded === n.itemId
              const quests = sources.filter((s) => s.kind === 'quest').length
              const hide = sources.filter((s) => s.kind === 'hideout').length
              const crafts = sources.filter((s) => s.kind === 'craft').length
              return (
                <Fragment key={n.itemId}>
                  <tr className={`cursor-pointer hover:bg-surface-3 ${remaining === 0 && !review ? 'text-ink-muted' : ''}`} onClick={() => setExpanded(open ? null : n.itemId)}>
                    <td className="px-2 py-1.5">{item?.iconLink && <img src={item.iconLink} alt="" className="h-8 w-8 object-contain" loading="lazy" />}</td>
                    <td className="px-3 py-1.5">
                      <div className="font-medium">{item?.name ?? (items.isPending ? 'Loading…' : n.itemId)}</div>
                      {n.alternatives.length > 0 && <div className="text-xs text-ink-dim">or {n.alternatives.length} alternative item{n.alternatives.length === 1 ? '' : 's'}</div>}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {review ? `${total} + review` : total}
                      <div className="text-[10px] text-ink-dim">{[n.fir > 0 ? `${n.fir} FIR` : '', n.nonFir > 0 ? `${n.nonFir} any` : '', n.unknownFir > 0 ? `${n.unknownFir} FIR unknown` : ''].filter(Boolean).join(' · ')}</div>
                    </td>
                    <td className="px-3 py-1.5 text-right" onClick={(e) => e.stopPropagation()}>
                      <input type="number" min={0} value={collected} onChange={(e) => setCollected(gameMode, n.itemId, e.target.valueAsNumber)} aria-label={`Collected ${item?.name ?? ''}`} className="w-20 rounded border border-line bg-surface px-2 py-1 text-right text-sm focus:border-accent focus:outline-none" />
                    </td>
                    <td className={`px-3 py-1.5 text-right tabular-nums ${remaining === 0 && !review ? 'text-success' : ''}`}>{review ? 'Review' : count === 'fir' && collected > 0 ? 'Verify FIR' : remaining}</td>
                    <td className="px-3 py-1.5 text-xs text-ink-muted">
                      {[quests ? `${quests} quest${quests > 1 ? 's' : ''}` : '', hide ? `${hide} hideout` : '', crafts ? `${crafts} craft${crafts > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ')}
                    </td>
                    <td className="px-2 py-1.5 text-ink-dim">{open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</td>
                  </tr>
                  {open && (
                    <tr>
                      <td colSpan={7} className="bg-surface px-4 py-2">
                        <ul className="space-y-0.5 text-xs">
                          {n.sources.map((s, i) => (
                            <li key={i} className={`flex gap-2 ${sources.includes(s) ? '' : 'opacity-45'}`} title={sources.includes(s) ? undefined : 'Outside this count'}>
                              <span className="w-14 shrink-0 uppercase tracking-wide text-ink-dim">{s.kind}</span>
                              <span className="flex-1">{s.name}{s.kind === 'quest' ? ` (${s.traderName})` : ''}</span>
                              <span className="tabular-nums text-ink-muted">×{s.count ?? '?'}{'fir' in s ? s.fir === true ? ' FIR' : s.fir === null ? ' · FIR unknown' : '' : ''}</span>
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
        {rows.length === 0 && <p className="px-4 py-10 text-center text-sm text-ink-muted">Nothing to collect with these filters.</p>}
      </div>
    </div>
  )
}
