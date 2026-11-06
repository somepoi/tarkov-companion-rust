import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, ArrowUp, ArrowUpDown, RefreshCw, RotateCcw, Search } from 'lucide-react'
import { useGameData, useItems, usePriceHistory } from '../api/hooks'
import type { Item, PricePoint } from '../api/types'
import { ErrorPanel, LoadingPanel } from '../components/DataState'
import { TradersPanel } from '../components/TradersPanel'
import { useNeeds } from '../hooks/useNeeds'
import { FEE_NOTE, catalogFleaSale, type MarketFeeContext } from '../lib/economy'
import { useFleaFees } from '../hooks/useFleaFees'
import { matchesSearch, rankMatch, searchWords } from '../lib/fleaSearch'
import { useLinkParam } from '../lib/linkParam'
import { formatNumber, formatRoubles, formatTimeAgo } from '../lib/format'
import { remainingFor, type ItemNeed } from '../lib/needs'
import { trackedItemAdvice, type TrackedNeedCoverage } from '../lib/recommendationSafety'
import { bestTraderOffer, type TraderAccessFacts } from '../lib/traderAccess'
import { useTraderAccessFacts } from '../hooks/useTraderAccessFacts'
import { useFleaStore, type FleaSortKey } from '../store/flea'

const TEN_MINUTES = 10 * 60 * 1000
const ROW_HEIGHT = 44
const EXPANDED_HEIGHT = 190

const selectClass =
  'rounded border border-line bg-surface-2 px-2 py-1.5 text-sm text-ink focus:border-accent focus:outline-none'

const TYPE_LABEL: Record<string, string> = {
  gun: 'Weapons', mods: 'Weapon mods', ammo: 'Ammo', ammoBox: 'Ammo boxes', armor: 'Armor', armorPlate: 'Armor plates', rig: 'Rigs',
  backpack: 'Backpacks', helmet: 'Helmets', headphones: 'Headsets', glasses: 'Glasses', meds: 'Meds', injectors: 'Injectors',
  provisions: 'Food & drink', barter: 'Barter items', keys: 'Keys', container: 'Containers', grenade: 'Grenades', wearable: 'Wearables',
}
const HIDDEN_TYPES = new Set(['noFlea', 'preset', 'markedOnly', 'specialSlot', 'pistolGrip', 'suppressor', 'poster'])

interface Row {
  item: Item
  banned: boolean
  flea: number | null
  perSlot: number | null
  traderSell: number
  traderSellId: string | null
  /** Trader quote, only when the current character can actually buy it. */
  traderBuy: number | null
  traderBuyId: string | null
  /** Why the catalog quote is not a purchasable price, when it is not. */
  traderBuyBlocked: string | null
  /** Whether the catalog publishes a usable per-restock purchase limit. */
  traderBuyLimitKnown: boolean
  /** Profit from buying at a trader and selling on the flea, after the fee. */
  flip: number | null
}

/** 24h / 7d change computed from lazily loaded history, shared with the sort. */
interface Changes {
  c24: number | null
  c7: number | null
  points: { t: number; p: number }[]
}

function buildRow(item: Item, feeContext: MarketFeeContext | null, facts: TraderAccessFacts): Row {
  const banned = item.types.includes('noFlea')
  const flea = banned ? null : item.avg24hPrice
  const traderSell = item.sellToTrader[0]?.priceRUB ?? 0
  const best = Math.max(flea ?? 0, traderSell)
  const slots = item.width * item.height || 1
  // A catalog quote is not a purchase the character can make. Only an offer with
  // recorded loyalty and an unlocked quest may price a flip, and the purchase
  // limit caps how many units that price can cover.
  // Consider every offer: the cheapest quote often needs a higher loyalty level.
  const access = bestTraderOffer(item.buyFromTrader, facts)
  const traderBuy = access.kind === 'available' ? access.priceRUB : null
  const estimate = catalogFleaSale(item, 1, feeContext)
  const difference = estimate && traderBuy != null && Number.isSafeInteger(traderBuy) && traderBuy > 0 ? estimate.net - traderBuy : null
  const flip = difference !== null && Number.isSafeInteger(difference) ? difference : null
  return {
    item,
    banned,
    flea,
    perSlot: best > 0 ? Math.round(best / slots) : null,
    traderSell,
    traderSellId: item.sellToTrader[0]?.traderId ?? null,
    traderBuy,
    traderBuyId: access.kind === 'available' ? access.offer.traderId : null,
    traderBuyBlocked:
      access.kind === 'unknown' && item.buyFromTrader.length > 0 ? access.reason : null,
    traderBuyLimitKnown: access.kind === 'available' && access.limitKnown,
    flip,
  }
}

function computeChanges(history: PricePoint[]): Changes {
  const pts = history.map((p) => ({ t: p.timestamp, p: p.price })).sort((a, b) => a.t - b.t)
  if (pts.length === 0) return { c24: null, c7: null, points: [] }
  const now = pts[pts.length - 1]
  const at = (ms: number) => {
    const target = now.t - ms
    let best = pts[0]
    for (const p of pts) if (p.t <= target) best = p
    return best
  }
  const pct = (from: number, to: number) => (from > 0 ? ((to - from) / from) * 100 : null)
  return { c24: pct(at(86_400_000).p, now.p), c7: pct(at(7 * 86_400_000).p, now.p), points: pts.filter((p) => p.t >= now.t - 7 * 86_400_000) }
}

const Pct = ({ v }: { v: number | null | undefined }) =>
  v == null ? <span className="text-ink-dim">—</span> : <span className={v > 0 ? 'text-success' : v < 0 ? 'text-danger' : ''}>{`${v > 0 ? '+' : ''}${v.toFixed(1)}%`}</span>

function Sparkline({ points }: { points: { t: number; p: number }[] }) {
  if (points.length < 2) return <span className="text-xs text-ink-dim">Not enough history for a chart.</span>
  const w = 240
  const h = 48
  const min = Math.min(...points.map((p) => p.p))
  const max = Math.max(...points.map((p) => p.p))
  const t0 = points[0].t
  const t1 = points[points.length - 1].t
  const d = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${(t1 === t0 ? 0 : ((p.t - t0) / (t1 - t0)) * w).toFixed(1)},${(max === min ? h / 2 : h - ((p.p - min) / (max - min)) * h).toFixed(1)}`)
    .join(' ')
  return (
    <svg width={w} height={h} className="overflow-visible" aria-label="7-day price chart">
      <path d={d} fill="none" stroke="var(--color-accent)" strokeWidth={1.5} />
    </svg>
  )
}

function Head({ label, k, sort, onSort, className = '' }: { label: string; k: FleaSortKey; sort: { key: FleaSortKey; dir: 'asc' | 'desc' }; onSort: (k: FleaSortKey) => void; className?: string }) {
  const active = sort.key === k
  const Icon = !active ? ArrowUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown
  return (
    <button type="button" onClick={() => onSort(k)} className={`inline-flex items-center gap-1 hover:text-ink ${active ? 'text-accent' : ''} ${className}`}>
      {label} <Icon className="h-3 w-3" />
    </button>
  )
}

const GRID = 'grid grid-cols-[minmax(220px,2fr)_100px_90px_90px_70px_70px_90px_150px_100px] items-center gap-2 px-3'

interface RowProps {
  row: Row
  open: boolean
  needed: ItemNeed | undefined
  collected: number
  coverage: TrackedNeedCoverage
  traderName: (id: string | null) => string
  changes: Changes | undefined
  onChanges: (id: string, c: Changes) => void
  onToggle: (id: string) => void
}

/** One collator for the whole list (localeCompare builds one per call: thousands per sort). */
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

/** One row; loads its price history when it has been on screen for a moment (or is expanded). */
const FleaRow = memo(function FleaRow({ row, open, needed, collected, coverage, traderName, changes, onChanges, onToggle }: RowProps) {
  // Load history once the row has been on screen for a moment, or immediately when expanded.
  const [lingered, setLingered] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setLingered(true), 600)
    return () => clearTimeout(t)
  }, [])
  const wanted = open || lingered
  const history = usePriceHistory(wanted && !changes ? row.item.id : null)
  useEffect(() => {
    if (history.data && !changes) onChanges(row.item.id, computeChanges(history.data))
  }, [history.data, changes, onChanges, row.item.id])

  const fir = needed?.fir ? needed.fir > 0 : false
  const remaining = needed ? remainingFor(needed, collected) : 0
  const advice = trackedItemAdvice(needed, coverage)
  return (
    <div>
      <div role="button" tabIndex={0} onClick={() => onToggle(row.item.id)} onKeyDown={(e) => e.key === 'Enter' && onToggle(row.item.id)} className={`${GRID} h-11 cursor-pointer border-b border-line text-sm hover:bg-surface-3 ${open ? 'bg-surface-3' : ''}`}>
        <div className="flex min-w-0 items-center gap-2">
          {row.item.iconLink && <img src={row.item.iconLink} alt="" className="h-8 w-8 shrink-0 object-contain" loading="lazy" />}
          <span className="min-w-0 truncate">{row.item.name}</span>
          {needed && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title={`Needed: ${remaining} remaining`} />}
          {fir && <span className="shrink-0 rounded border border-info/60 px-1 text-[9px] font-semibold uppercase text-info" title="A quest needs this found in raid">FIR</span>}
          {row.banned && <span className="shrink-0 rounded border border-line px-1 text-[9px] uppercase text-ink-dim" title="Cannot be sold on the flea market">no flea</span>}
        </div>
        <div className="text-right tabular-nums">{row.flea != null ? formatRoubles(row.flea) : <span className="text-ink-dim">—</span>}</div>
        <div className="text-right text-xs tabular-nums text-ink-muted">{row.banned ? '—' : formatRoubles(row.item.low24hPrice)}</div>
        <div className="text-right text-xs tabular-nums text-ink-muted">{row.banned ? '—' : formatRoubles(row.item.high24hPrice)}</div>
        <div className="text-right text-xs tabular-nums">{changes ? <Pct v={changes.c24} /> : <span className="text-ink-dim">{wanted && !row.banned ? '…' : '—'}</span>}</div>
        <div className="text-right text-xs tabular-nums">{changes ? <Pct v={changes.c7} /> : <span className="text-ink-dim">{wanted && !row.banned ? '…' : '—'}</span>}</div>
        <div className="text-right text-xs tabular-nums">{row.perSlot != null ? formatRoubles(row.perSlot) : '—'}</div>
        <div className="truncate text-right text-xs tabular-nums">{row.traderSell ? `${traderName(row.traderSellId)} ${formatRoubles(row.traderSell)}` : '—'}</div>
        <div className={`text-right text-xs tabular-nums ${row.flip != null && row.flip > 0 ? 'text-success' : 'text-ink-dim'}`} title={row.traderBuy != null ? `Buy at ${traderName(row.traderBuyId)} for ${formatRoubles(row.traderBuy)}` : row.traderBuyBlocked ? `No trader flip: ${row.traderBuyBlocked}` : ''}>{row.flip != null ? formatRoubles(row.flip) : '—'}</div>
      </div>
      {open && (
        <div className="grid gap-4 border-b border-line bg-surface px-4 py-3 text-xs md:grid-cols-3" style={{ minHeight: EXPANDED_HEIGHT - 44 }}>
          <div>
            <h4 className="mb-1 font-semibold uppercase tracking-wide text-ink-muted">7-day price</h4>
            {history.isPending && !changes ? <span className="text-ink-dim">Loading history…</span> : history.isError && !changes ? <span className="text-danger">History unavailable.</span> : <Sparkline points={changes?.points ?? []} />}
            {changes?.points.length ? <div className="mt-1 text-ink-dim">Last point {formatRoubles(changes.points[changes.points.length - 1].p)} · {formatTimeAgo(changes.points[changes.points.length - 1].t)}</div> : null}
          </div>
          <div>
            <h4 className="mb-1 font-semibold uppercase tracking-wide text-ink-muted">Trader sell prices</h4>
            {row.item.sellToTrader.length === 0 ? <span className="text-ink-dim">No trader buys this.</span> : (
              <>
                <ul className="space-y-0.5">
                  {row.item.sellToTrader.map((s) => (
                    <li key={s.traderId} className="flex justify-between gap-2"><span>{traderName(s.traderId)}</span><span className="tabular-nums">{formatRoubles(s.priceRUB)}</span></li>
                  ))}
                </ul>
                <p className="mt-1 text-ink-dim">
                  Catalog reference prices. What a trader actually pays for a specific item also depends on its condition and your standing, which this list does not check.
                </p>
              </>
            )}
            {row.traderBuy != null && <div className="mt-1 text-ink-dim">Buy from {traderName(row.traderBuyId)}: {formatRoubles(row.traderBuy)}</div>}
            {row.traderBuy != null && !row.traderBuyLimitKnown && (
              <div className="mt-1 text-ink-muted">
                Per-restock purchase limit is not published, so this price is only a per-unit reference.
              </div>
            )}
            {row.traderBuyBlocked != null && (
              <div className="mt-1 text-ink-muted">
                Trader buy price not usable: {row.traderBuyBlocked}.
              </div>
            )}
          </div>
          <div>
            <h4 className="mb-1 font-semibold uppercase tracking-wide text-ink-muted">Tracked requirements</h4>
            <div className={`mb-1 inline-flex rounded border px-1.5 py-0.5 font-semibold ${advice.kind === 'KEEP' ? 'border-accent/60 bg-accent/15 text-accent' : 'border-line bg-surface-3 text-ink-muted'}`}>{advice.label}</div>
            <p className="mb-1 text-ink-muted">{advice.detail}</p>
            {needed && (
              <>
                <ul className="space-y-0.5">
                  {needed.sources.slice(0, 6).map((s, i) => (
                    <li key={i} className="flex gap-2"><span className="w-12 shrink-0 uppercase text-ink-dim">{s.kind}</span><span className="min-w-0 flex-1 truncate">{s.name}</span><span className="tabular-nums text-ink-muted">×{s.count ?? '?'}{'fir' in s ? s.fir === true ? ' FIR' : s.fir === null ? ' FIR unknown' : '' : ''}</span></li>
                  ))}
                  {needed.sources.length > 6 && <li className="text-ink-dim">…and {needed.sources.length - 6} more</li>}
                </ul>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
})

export function FleaMarketPage() {
  const items = useItems(true, TEN_MINUTES)
  const feeContext = useFleaFees(items.data)
  const gameData = useGameData()
  const { needs, coverage, inventory } = useNeeds()
  // Session facts about the current character; the catalog alone cannot prove
  // that a quoted trader offer can actually be bought.
  const traderFacts = useTraderAccessFacts()
  const filters = useFleaStore((s) => s.filters)
  const setFilters = useFleaStore((s) => s.setFilters)
  const resetFilters = useFleaStore((s) => s.resetFilters)
  // "?q=…" (the search bar's "Open in the app") fills in the search.
  useLinkParam('q', (q) => setFilters({ search: q }))
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // Like the game: typing lists every item whose name has all the words; picking one shows just it.
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(null)
  const [suggestOpen, setSuggestOpen] = useState(false)
  const [activeSuggestion, setActiveSuggestion] = useState(0)
  const [, setChangeVersion] = useState(0)
  const changesRef = useRef(new Map<string, Changes>())
  const bumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onChanges = useMemo(
    () => (id: string, c: Changes) => {
      changesRef.current.set(id, c)
      // Re-sort at most a few times a second while histories stream in.
      if (!bumpTimer.current) bumpTimer.current = setTimeout(() => { bumpTimer.current = null; setChangeVersion((v) => v + 1) }, 300)
    },
    [],
  )
  // Re-draws the "prices updated … ago" label; the list itself does not depend on it.
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000)
    return () => clearInterval(id)
  }, [])

  const rows = useMemo(() => (items.data ? Object.values(items.data.items).map((item) => buildRow(item, feeContext, traderFacts)) : []), [items.data, feeContext, traderFacts])
  // Lower-cased names once per data load, not on every keystroke.
  const searchText = useMemo(() => new Map(rows.map((r) => [r.item.id, `${r.item.name}\n${r.item.shortName}`.toLowerCase()])), [rows])
  // Typing stays instant; the 4,000-row filter catches up right after.
  const listFilters = useDeferredValue(filters)
  const types = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of rows) for (const t of r.item.types) if (!HIDDEN_TYPES.has(t)) counts.set(t, (counts.get(t) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [rows])

  const filtered = useMemo(() => {
    const filters = listFilters
    const words = searchWords(filters.search)
    const only = picked && picked.name === filters.search ? picked.id : null
    const min = Number(filters.minPrice) || 0
    const max = Number(filters.maxPrice) || Infinity
    const minSlot = Number(filters.minPerSlot) || 0
    const ch = changesRef.current
    const list = rows.filter((r) => {
      if (filters.type !== 'all' && !r.item.types.includes(filters.type)) return false
      if (filters.fleaBan === 'banned' && !r.banned) return false
      if (filters.fleaBan === 'allowed' && r.banned) return false
      if (only ? r.item.id !== only : words.length > 0 && !matchesSearch(searchText.get(r.item.id) ?? '', words)) return false
      const price = r.flea ?? r.traderSell
      if (price < min || price > max) return false
      if (minSlot > 0 && (r.perSlot ?? 0) < minSlot) return false
      if (filters.neededOnly && !needs.has(r.item.id)) return false
      if (filters.risingOnly) {
        const c24 = ch.get(r.item.id)?.c24 ?? r.item.changeLast48hPercent
        if (!(c24 != null && c24 >= filters.risingPct)) return false
      }
      if (filters.flipOnly && !(r.flip != null && r.flip > 0)) return false
      return true
    })
    const dir = filters.sort.dir === 'asc' ? 1 : -1
    const val = (r: Row): number | null => {
      switch (filters.sort.key) {
        case 'flea': return r.flea
        case 'low': return r.banned ? null : r.item.low24hPrice
        case 'high': return r.banned ? null : r.item.high24hPrice
        case 'change24': return ch.get(r.item.id)?.c24 ?? null
        case 'change7d': return ch.get(r.item.id)?.c7 ?? null
        case 'perSlot': return r.perSlot
        case 'traderSell': return r.traderSell
        case 'flip': return r.flip
        default: return null
      }
    }
    list.sort((a, b) => {
      if (filters.sort.key === 'name') return collator.compare(a.item.name, b.item.name) * dir
      const va = val(a)
      const vb = val(b)
      if (va == null && vb == null) return collator.compare(a.item.name, b.item.name)
      if (va == null) return 1
      if (vb == null) return -1
      return (va - vb) * dir || collator.compare(a.item.name, b.item.name)
    })
    return list
    // changeVersion (via setChangeVersion) re-runs this when histories arrive
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, listFilters, needs, searchText, picked, changesRef.current.size])

  const suggestions = useMemo(() => {
    const words = searchWords(listFilters.search)
    if (words.join('').length < 2) return []
    return rows
      .filter((r) => matchesSearch(searchText.get(r.item.id) ?? '', words))
      .sort((a, b) => rankMatch(a.item.name, a.item.shortName, words) - rankMatch(b.item.name, b.item.shortName, words) || a.item.name.length - b.item.name.length || collator.compare(a.item.name, b.item.name))
      .slice(0, 12)
  }, [rows, searchText, listFilters.search])
  const pick = (r: Row) => {
    setFilters({ search: r.item.name })
    setPicked({ id: r.item.id, name: r.item.name })
    setExpandedId(r.item.id)
    setSuggestOpen(false)
    scrollRef.current?.scrollTo({ top: 0 })
  }
  const showingPicked = picked !== null && picked.name === filters.search

  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (filtered[i]?.item.id === expandedId ? ROW_HEIGHT + EXPANDED_HEIGHT : ROW_HEIGHT),
    getItemKey: (i) => filtered[i]?.item.id ?? i,
    overscan: 6,
  })
  useEffect(() => {
    virtualizer.measure()
  }, [expandedId, virtualizer])

  // Stable functions so memoised rows only re-draw when their own data changes.
  const traderNames = useMemo(() => new Map((gameData.data?.traders ?? []).map((t) => [t.id, t.name])), [gameData.data])
  const traderName = useCallback((id: string | null) => (id ? (traderNames.get(id) ?? 'Trader') : '—'), [traderNames])
  const toggleRow = useCallback((id: string) => setExpandedId((cur) => (cur === id ? null : id)), [])
  const onSort = (key: FleaSortKey) =>
    setFilters({ sort: filters.sort.key === key ? { key, dir: filters.sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'name' ? 'asc' : 'desc' } })

  if (items.isPending) return <div className="p-6"><LoadingPanel label="flea market prices" /></div>
  if (items.isError && !items.data) return <div className="p-6"><ErrorPanel error={items.error} onRetry={() => void items.refetch()} /></div>

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 px-4 py-4 md:px-8 md:py-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Flea Market</h1>
          <p className="text-sm text-ink-muted">
            {formatNumber(rows.length)} items{items.dataUpdatedAt ? ` · prices updated ${formatTimeAgo(items.dataUpdatedAt)}` : ''} · refreshes every 10 min while this tab is visible
          </p>
          <p className="text-[11px] text-ink-dim">{FEE_NOTE}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-ink-dim">{formatNumber(filtered.length)} shown</span>
          <button type="button" onClick={() => void items.refetch()} disabled={items.isFetching} className="btn !py-1 !text-xs"><RefreshCw className={`h-3.5 w-3.5 ${items.isFetching ? 'animate-spin' : ''}`} /> Refresh prices</button>
        </div>
      </div>

      <TradersPanel />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-dim" />
          <input
            type="search"
            value={filters.search}
            onChange={(e) => {
              setFilters({ search: e.target.value })
              setPicked(null)
              setSuggestOpen(true)
              setActiveSuggestion(0)
            }}
            onFocus={() => setSuggestOpen(true)}
            onBlur={() => setSuggestOpen(false)}
            onKeyDown={(e) => {
              if (!suggestOpen || !suggestions.length) return
              if (e.key === 'ArrowDown') setActiveSuggestion((i) => Math.min(suggestions.length - 1, i + 1))
              else if (e.key === 'ArrowUp') setActiveSuggestion((i) => Math.max(0, i - 1))
              else if (e.key === 'Enter') pick(suggestions[Math.min(activeSuggestion, suggestions.length - 1)])
              else if (e.key === 'Escape') setSuggestOpen(false)
              else return
              e.preventDefault()
            }}
            placeholder="Search: any words of the name…"
            aria-label="Search items"
            aria-autocomplete="list"
            className={`${selectClass} w-72 pl-8`}
          />
          {suggestOpen && !showingPicked && suggestions.length > 0 && (
            <ul role="listbox" aria-label="Matching items" className="absolute left-0 top-full z-40 mt-1 max-h-96 w-96 max-w-[90vw] overflow-y-auto rounded border border-line bg-surface-2 py-1 shadow-xl">
              {suggestions.map((r, i) => (
                <li key={r.item.id} role="option" aria-selected={i === activeSuggestion}>
                  {/* onMouseDown: picked before the input's blur closes the list. */}
                  <button type="button" onMouseDown={(e) => { e.preventDefault(); pick(r) }} onMouseEnter={() => setActiveSuggestion(i)} className={`flex w-full items-center gap-2 px-2 py-1 text-left text-sm ${i === activeSuggestion ? 'bg-surface-3' : ''}`}>
                    {r.item.iconLink ? <img src={r.item.iconLink} alt="" className="h-7 w-7 shrink-0 object-contain" loading="lazy" /> : <span className="h-7 w-7 shrink-0" />}
                    <span className="min-w-0 flex-1 truncate">{r.item.name}</span>
                    <span className="shrink-0 text-xs tabular-nums text-ink-dim">{r.flea != null ? formatRoubles(r.flea) : r.banned ? 'banned' : '—'}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {showingPicked && (
          <button type="button" onClick={() => setPicked(null)} className="btn !py-1 !text-xs" title="Show every item matching the words again">Show all matches</button>
        )}
        <select value={filters.type} onChange={(e) => setFilters({ type: e.target.value })} aria-label="Category" className={selectClass}>
          <option value="all">All categories</option>
          {types.map(([t, n]) => (
            <option key={t} value={t}>{TYPE_LABEL[t] ?? t} ({n})</option>
          ))}
        </select>
        <select value={filters.fleaBan} onChange={(e) => setFilters({ fleaBan: e.target.value as typeof filters.fleaBan })} aria-label="Flea ban filter" className={selectClass}>
          <option value="all">Flea + banned</option>
          <option value="allowed">Flea-tradeable only</option>
          <option value="banned">Banned from flea</option>
        </select>
        <input type="number" value={filters.minPrice} onChange={(e) => setFilters({ minPrice: e.target.value })} placeholder="Min ₽" aria-label="Minimum price" className={`${selectClass} w-24`} />
        <input type="number" value={filters.maxPrice} onChange={(e) => setFilters({ maxPrice: e.target.value })} placeholder="Max ₽" aria-label="Maximum price" className={`${selectClass} w-24`} />
        <input type="number" value={filters.minPerSlot} onChange={(e) => setFilters({ minPerSlot: e.target.value })} placeholder="Min ₽/slot" aria-label="Minimum price per slot" className={`${selectClass} w-28`} />
        <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={filters.neededOnly} onChange={(e) => setFilters({ neededOnly: e.target.checked })} /> Needed by me</label>
        <label className="flex items-center gap-1.5 text-sm" title="24h change at or above the threshold (falls back to the 48h figure until history loads)">
          <input type="checkbox" checked={filters.risingOnly} onChange={(e) => setFilters({ risingOnly: e.target.checked })} /> Rising ≥
          <input type="number" value={filters.risingPct} onChange={(e) => setFilters({ risingPct: Number(e.target.value) || 0 })} aria-label="Rising threshold percent" className={`${selectClass} w-16 !py-0.5`} />%
        </label>
        <label className="flex items-center gap-1.5 text-sm" title="Cheaper at a trader than it sells for on the flea after the fee"><input type="checkbox" checked={filters.flipOnly} onChange={(e) => setFilters({ flipOnly: e.target.checked })} /> Trader flip</label>
        <button type="button" onClick={resetFilters} className="btn !py-1 !text-xs" title="Reset filters"><RotateCcw className="h-3.5 w-3.5" /> Reset</button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-line bg-surface-2">
        <div className={`${GRID} h-9 border-b border-line bg-surface-3 text-xs uppercase tracking-wide text-ink-muted`}>
          <Head sort={filters.sort} onSort={onSort} label="Item" k="name" />
          <Head sort={filters.sort} onSort={onSort} label="Flea avg" k="flea" className="justify-end" />
          <Head sort={filters.sort} onSort={onSort} label="Low 24h" k="low" className="justify-end" />
          <Head sort={filters.sort} onSort={onSort} label="High 24h" k="high" className="justify-end" />
          <Head sort={filters.sort} onSort={onSort} label="24h" k="change24" className="justify-end" />
          <Head sort={filters.sort} onSort={onSort} label="7d" k="change7d" className="justify-end" />
          <Head sort={filters.sort} onSort={onSort} label="₽ / slot" k="perSlot" className="justify-end" />
          <Head sort={filters.sort} onSort={onSort} label="Trader sell" k="traderSell" className="justify-end" />
          <Head sort={filters.sort} onSort={onSort} label="Flip" k="flip" className="justify-end" />
        </div>
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((v) => {
              const r = filtered[v.index]
              if (!r) return null
              return (
                <div key={v.key} data-index={v.index} ref={virtualizer.measureElement} style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${v.start}px)` }}>
                  <FleaRow
                    row={r}
                    open={r.item.id === expandedId}
                    needed={needs.get(r.item.id)}
                    collected={inventory.collected[r.item.id] ?? 0}
                    coverage={coverage}
                    traderName={traderName}
                    changes={changesRef.current.get(r.item.id)}
                    onChanges={onChanges}
                    onToggle={toggleRow}
                  />
                </div>
              )
            })}
          </div>
        </div>
        {filtered.length === 0 && <p className="px-4 py-10 text-center text-sm text-ink-muted">No items match these filters.</p>}
      </div>
    </div>
  )
}
