import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import type { Item } from '../api/types'
import { useNeeds } from '../hooks/useNeeds'
import { formatRoubles } from '../lib/format'
import { remainingFor } from '../lib/needs'
import { trackedItemAdvice } from '../lib/recommendationSafety'
import { useLookupStore } from '../store/lookup'

function rankMatches(items: Item[], query: string): Item[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const words = q.split(/\s+/)
  const scored: { item: Item; score: number }[] = []
  for (const it of items) {
    const name = it.name.toLowerCase()
    const short = it.shortName.toLowerCase()
    if (!words.every((w) => name.includes(w) || short.includes(w))) continue
    let score = 0
    if (short === q || name === q) score += 100
    if (name.startsWith(q) || short.startsWith(q)) score += 40
    score -= name.length / 50
    scored.push({ item: it, score })
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 25).map((s) => s.item)
}

/**
 * Ctrl+K item lookup. The dialog (and the item list it needs, a large download) only mounts
 * while open, so the app does not load every item at start-up just for this.
 */
export function ItemLookup() {
  const open = useLookupStore((s) => s.open)
  const setOpen = useLookupStore((s) => s.setOpen)

  // Ctrl+K opens / toggles from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(!useLookupStore.getState().open)
      } else if (e.key === 'Escape' && useLookupStore.getState().open) {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setOpen])

  return open ? <ItemLookupDialog /> : null
}

function ItemLookupDialog() {
  const setOpen = useLookupStore((s) => s.setOpen)
  const { needs, coverage, gameData, items, inventory } = useNeeds()
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [])

  const all = useMemo(() => (items.data ? Object.values(items.data.items) : []), [items.data])
  const results = useMemo(() => rankMatches(all, query), [all, query])
  const selected = selectedId ? (items.data?.items[selectedId] ?? null) : (results[cursor] ?? null)

  const traderName = (id: string) => gameData.data?.traders.find((t) => t.id === id)?.name ?? 'Trader'
  const need = selected ? needs.get(selected.id) : undefined
  const collected = selected ? (inventory.collected[selected.id] ?? 0) : 0
  const remaining = need ? remainingFor(need, collected) : 0
  const advice = trackedItemAdvice(need, coverage)
  const bestTrader = selected?.sellToTrader[0]
  const bestPrice = selected ? Math.max(selected.avg24hPrice ?? 0, bestTrader?.priceRUB ?? 0) : 0
  const slots = selected ? selected.width * selected.height : 1

  return (
    <div className="fixed inset-0 z-[1200] flex items-start justify-center bg-black/60 p-4 pt-[8vh]" onClick={() => setOpen(false)} role="presentation">
      <div role="dialog" aria-modal="true" aria-label="Item lookup" onClick={(e) => e.stopPropagation()} className="flex max-h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-line bg-surface-2 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <Search className="h-4 w-4 text-ink-dim" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setSelectedId(null)
              setCursor(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSelectedId(null)
                setCursor((c) => Math.min(results.length - 1, c + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSelectedId(null)
                setCursor((c) => Math.max(0, c - 1))
              } else if (e.key === 'Enter' && results[cursor]) {
                setSelectedId(results[cursor].id)
              }
            }}
            placeholder={items.isPending ? 'Loading items…' : 'Search any item (Ctrl+K)'}
            aria-label="Search items"
            className="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-ink-dim focus:outline-none"
          />
          <kbd className="rounded border border-line px-1.5 text-[10px] text-ink-dim">Esc</kbd>
          <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="rounded p-1 text-ink-dim hover:text-ink"><X className="h-4 w-4" /></button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[280px_1fr]">
          <ul className="max-h-[60vh] overflow-y-auto border-b border-line md:border-b-0 md:border-r" role="listbox">
            {query && results.length === 0 && <li className="px-3 py-4 text-xs text-ink-dim">No items match.</li>}
            {!query && <li className="px-3 py-4 text-xs text-ink-dim">Type an item name. Use ↑ ↓ and Enter.</li>}
            {results.map((it, i) => {
              const active = selected?.id === it.id
              return (
                <li key={it.id} role="option" aria-selected={active}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedId(it.id)
                      setCursor(i)
                    }}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-3 ${active ? 'bg-accent/15 text-accent' : ''}`}
                  >
                    {it.iconLink && <img src={it.iconLink} alt="" className="h-6 w-6 object-contain" loading="lazy" />}
                    <span className="min-w-0 flex-1 truncate">{it.name}</span>
                    {needs.has(it.id) && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title="Needed" />}
                  </button>
                </li>
              )
            })}
          </ul>

          <div className="overflow-y-auto p-4 text-sm">
            {!selected ? (
              <p className="text-xs text-ink-dim">Pick an item to see prices and tracked requirements.</p>
            ) : (
              <>
                <div className="flex items-start gap-3">
                  {selected.iconLink && <img src={selected.iconLink} alt="" className="h-16 w-16 object-contain" />}
                  <div className="min-w-0">
                    <h2 className="text-base font-semibold">{selected.name}</h2>
                    <p className="text-xs text-ink-muted">{selected.shortName} · {selected.width}×{selected.height} slots{selected.types.includes('noFlea') ? ' · not on flea' : ''}</p>
                    <div className={`mt-2 inline-flex items-center rounded border px-2 py-0.5 text-xs font-semibold ${advice.kind === 'KEEP' ? 'border-accent/60 bg-accent/15 text-accent' : 'border-line bg-surface-3 text-ink-muted'}`}>
                      {advice.label}
                    </div>
                    <p className="mt-1 text-xs text-ink-muted">{advice.detail}</p>
                  </div>
                </div>

                <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
                  <dt className="text-ink-muted">Flea avg 24h</dt><dd className="tabular-nums">{formatRoubles(selected.avg24hPrice)}</dd>
                  <dt className="text-ink-muted">Flea low / high 24h</dt><dd className="tabular-nums">{formatRoubles(selected.low24hPrice)} / {formatRoubles(selected.high24hPrice)}</dd>
                  <dt className="text-ink-muted">Trader sell reference</dt><dd className="tabular-nums">{bestTrader ? `${traderName(bestTrader.traderId)} ${formatRoubles(bestTrader.priceRUB)}` : '—'}</dd>
                  <dt className="text-ink-muted">Price per slot</dt><dd className="tabular-nums">{bestPrice ? formatRoubles(Math.round(bestPrice / slots)) : '—'}</dd>
                  <dt className="text-ink-muted">48h change</dt><dd className="tabular-nums">{selected.changeLast48hPercent != null ? `${selected.changeLast48hPercent > 0 ? '+' : ''}${selected.changeLast48hPercent.toFixed(1)}%` : '—'}</dd>
                  <dt className="text-ink-muted">Base price</dt><dd className="tabular-nums">{formatRoubles(selected.basePrice)}</dd>
                </dl>
                <p className="mt-1 text-[11px] text-ink-dim">
                  These are catalog reference prices, not offers you can necessarily act on. What a trader pays for a specific item depends on its condition and your standing, and the flea fee depends on your level and standing — this panel checks neither.
                </p>

                <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-ink-muted">Tracked requirements</h3>
                {!need ? (
                  <p className="mt-1 text-xs text-ink-dim">No requirement for this item was found in the loaded quest and hideout checklist.</p>
                ) : (
                  <ul className="mt-1 space-y-0.5 text-xs">
                    {need.sources.map((s, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="w-14 shrink-0 uppercase tracking-wide text-ink-dim">{s.kind}</span>
                        <span className="flex-1">{s.name}</span>
                        <span className="tabular-nums text-ink-muted">×{s.count ?? '?'}{'fir' in s ? s.fir === true ? ' FIR' : s.fir === null ? ' FIR unknown' : '' : ''}</span>
                      </li>
                    ))}
                    <li className="pt-1 text-ink-muted">{need.quantityUnknown ? 'Known subtotal' : 'Total'} {need.total} needed · {collected} collected · {remaining} more in checklist</li>
                  </ul>
                )}
                {selected.wikiLink && (
                  <a href={selected.wikiLink} target="_blank" rel="noreferrer" className="mt-3 inline-block text-xs text-accent underline">Wiki</a>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
