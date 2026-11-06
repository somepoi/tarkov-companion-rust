import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Check, Crosshair, Minus, Search, X } from 'lucide-react'
import { useGameData, useItems } from '../api/hooks'
import type { Trader } from '../api/types'
import { ErrorPanel, LoadingPanel } from '../components/DataState'
import { useTraderAccessFacts } from '../hooks/useTraderAccessFacts'
import {
  armorVerdict,
  caliberLabel,
  formatModifier,
  groupCalibers,
  shotDamage,
  sortAmmo,
  type AmmoItem,
  type AmmoSortKey,
  type ArmorVerdict,
} from '../lib/ammo'
import { acquireCost, fleaPurchaseAccess, type FleaRulesContext } from '../lib/economy'
import { useFleaRules } from '../hooks/useFleaRules'
import { bestTraderOffer, type TraderAccessFacts } from '../lib/traderAccess'
import { formatRoubles } from '../lib/format'
import { useLinkParam } from '../lib/linkParam'
import { useProgressStore } from '../store/progress'

const selectClass =
  'rounded border border-line bg-surface-2 px-2 py-1.5 text-sm text-ink focus:border-accent focus:outline-none'

interface AmmoRow {
  item: AmmoItem
  price: number | null
  /** Plain-English source of the cheapest price. */
  source: string | null
  /** Why a catalog trader offer could not price this round, if it could not. */
  traderNote: string | null
  /** True only when the flea rules and level actually allow buying this round. */
  fleaBuyable: boolean
  /** Why the flea average is not a price you can pay, when it is not. */
  fleaNote: string | null
}

const VERDICT_STYLE: Record<ArmorVerdict, { cls: string; label: string; Icon: typeof Check }> = {
  good: { cls: 'text-success', label: 'goes through', Icon: Check },
  partial: { cls: 'text-accent', label: 'sometimes goes through', Icon: Minus },
  poor: { cls: 'text-danger', label: 'mostly stopped', Icon: X },
}

function buildRow(item: AmmoItem, tradersById: Record<string, Trader>, facts: TraderAccessFacts, fleaContext: FleaRulesContext | null): AmmoRow {
  // A catalog average is not a price this character can pay: the flea market
  // gates purchases on the market minimum and the item's own level.
  const flea = fleaPurchaseAccess(item, fleaContext)
  const fleaBuyable = flea.available && item.avg24hPrice != null
  const price = acquireCost(item, facts, fleaContext)
  // Every offer is judged: the cheapest quote may be out of loyalty reach.
  const access = bestTraderOffer(item.buyFromTrader, facts)
  const trader = access.kind === 'available' ? access.offer : undefined
  let source: string | null = null
  if (price != null) {
    if (fleaBuyable && item.avg24hPrice === price && (!trader || item.avg24hPrice < trader.priceRUB)) source = 'Flea market'
    else if (trader) {
      const name = tradersById[trader.traderId]?.name ?? 'Trader'
      source = trader.minTraderLevel ? `${name} LL${trader.minTraderLevel}` : name
    }
  }
  const traderNote = item.buyFromTrader.length > 0 && access.kind === 'unknown'
    ? `Catalog trader offers start at ${formatRoubles(item.buyFromTrader[0].priceRUB)} but are not a price you can pay: ${access.reason}.`
    : null
  const fleaNote = item.avg24hPrice != null && !fleaBuyable
    ? `Catalog flea average ${formatRoubles(item.avg24hPrice)} is not a price you can pay: ${flea.available ? 'unknown reason' : flea.reason}.`
    : null
  return { item, price, source, traderNote, fleaBuyable, fleaNote }
}

export function AmmoPage() {
  const items = useItems()
  const gameData = useGameData()
  const gameMode = useProgressStore((s) => s.gameMode)
  const traderFacts = useTraderAccessFacts()
  const fleaContext = useFleaRules(items.data)

  const [caliber, setCaliber] = useState('all')
  const [search, setSearch] = useState('')
  useLinkParam('q', (q) => {
    setCaliber('all')
    setSearch(q)
  })
  const [hideTracers, setHideTracers] = useState(false)
  const [fleaOnly, setFleaOnly] = useState(false)
  const [armorClass, setArmorClass] = useState(4)
  const [sortKey, setSortKey] = useState<AmmoSortKey>('penetration')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const rows = useMemo<AmmoRow[]>(() => {
    if (!items.data) return []
    const tradersById: Record<string, Trader> = {}
    for (const t of gameData.data?.traders ?? []) tradersById[t.id] = t
    return Object.values(items.data.items)
      .filter((it): it is AmmoItem => it.ammo != null)
      .map((it) => buildRow(it, tradersById, traderFacts, fleaContext))
  }, [items.data, gameData.data, traderFacts, fleaContext])

  const caliberGroups = useMemo(() => groupCalibers(rows.map((r) => r.item.ammo.caliber)), [rows])
  const anyFlea = rows.some((r) => r.fleaBuyable)

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const list = rows.filter((r) => {
      if (caliber !== 'all' && r.item.ammo.caliber !== caliber) return false
      if (hideTracers && r.item.ammo.tracer) return false
      if (fleaOnly && anyFlea && !r.fleaBuyable) return false
      if (needle && !r.item.name.toLowerCase().includes(needle) && !caliberLabel(r.item.ammo.caliber).toLowerCase().includes(needle)) return false
      return true
    })
    return sortAmmo(list, sortKey, sortDir)
  }, [rows, caliber, search, hideTracers, fleaOnly, anyFlea, sortKey, sortDir])

  if (items.isPending) return <LoadingPanel label="ammo" />
  if (items.isError && !items.data) return <ErrorPanel error={items.error} onRetry={() => void items.refetch()} />

  const onSort = (key: AmmoSortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(key)
      setSortDir(key === 'name' || key === 'caliber' || key === 'price' ? 'asc' : 'desc')
    }
  }

  const header = (key: AmmoSortKey, label: string, title: string, align: 'left' | 'right' = 'right') => {
    const active = sortKey === key
    return (
      <th
        className={`px-2 py-2 font-medium ${align === 'right' ? 'text-right' : 'text-left'}`}
        aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        <button
          type="button"
          onClick={() => onSort(key)}
          title={title}
          className={`inline-flex items-center gap-1 uppercase tracking-wide hover:text-accent ${active ? 'text-accent' : ''}`}
        >
          {label}
          {active && (sortDir === 'asc' ? <ArrowUp className="h-3 w-3" aria-hidden /> : <ArrowDown className="h-3 w-3" aria-hidden />)}
        </button>
      </th>
    )
  }

  const chartRows = caliber === 'all' ? [] : filtered

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Ammo chart</h1>
          <p className="text-sm text-ink-muted">
            {rows.length} rounds ({gameMode === 'pve' ? 'PvE' : 'PvP'}). Pick an armour class to see which rounds get through it. Click a column to sort.
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <select value={caliber} onChange={(e) => setCaliber(e.target.value)} aria-label="Calibre" className={selectClass}>
          <option value="all">All calibres</option>
          {caliberGroups.map((g) => (
            <optgroup key={g.group} label={g.group}>
              {g.calibers.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </optgroup>
          ))}
        </select>
        <label className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-dim" />
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search ammo…" aria-label="Search ammo" className={`${selectClass} w-56 pl-8`} />
        </label>
        <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={hideTracers} onChange={(e) => setHideTracers(e.target.checked)} /> Hide tracers</label>
        {anyFlea && (
          <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={fleaOnly} onChange={(e) => setFleaOnly(e.target.checked)} /> Only on the flea market</label>
        )}
        <div className="flex items-center gap-1 text-sm" role="group" aria-label="Armour class">
          <span className="mr-1 text-ink-muted">Armour class</span>
          {[1, 2, 3, 4, 5, 6].map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setArmorClass(c)}
              aria-pressed={armorClass === c}
              className={`h-7 w-7 rounded border text-sm ${armorClass === c ? 'border-accent bg-accent/15 text-accent' : 'border-line bg-surface-2 hover:border-accent'}`}
            >
              {c}
            </button>
          ))}
        </div>
        <span className="ml-auto text-xs text-ink-dim">{filtered.length} rounds</span>
      </div>

      <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
        <span>Penetration against class {armorClass} (approximate rule of thumb: {armorClass * 10}+ goes through, {armorClass * 10 - 10}–{armorClass * 10 - 1} sometimes, lower mostly stopped; worn armour is easier to get through):</span>
        {(['good', 'partial', 'poor'] as const).map((v) => {
          const s = VERDICT_STYLE[v]
          return (
            <span key={v} className={`inline-flex items-center gap-1 ${s.cls}`}><s.Icon className="h-3 w-3" aria-hidden />{s.label}</span>
          )
        })}
      </p>
      {!anyFlea && rows.length > 0 && (
        <p className="mt-1 text-xs text-ink-dim">No ammo can be bought on the flea market right now, so prices are trader prices.</p>
      )}

      <div className="mt-4 rounded-lg border border-line bg-surface-2 p-4">
        <h2 className="text-sm font-semibold">Damage vs penetration{caliber !== 'all' ? ` — ${caliberLabel(caliber)}` : ''}</h2>
        {chartRows.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-muted">
            {caliber === 'all' ? 'Pick a calibre above to compare its rounds on a chart.' : 'No rounds match these filters.'}
          </p>
        ) : (
          <AmmoScatter rows={chartRows} armorClass={armorClass} />
        )}
      </div>

      <div className="mt-4 overflow-x-auto rounded-lg border border-line bg-surface-2">
        <table className="w-full text-sm">
          <thead className="bg-surface-3 text-xs text-ink-muted">
            <tr>
              {header('name', 'Round', 'Ammo name', 'left')}
              {header('caliber', 'Calibre', 'Calibre', 'left')}
              {header('damage', 'Damage', 'Flesh damage per shot (buckshot: pellets × damage)')}
              {header('penetration', 'Pen', 'Penetration power; colour shows the chosen armour class')}
              {header('armorDamage', 'Armour dmg', 'How much armour durability a hit removes, in percent of the damage')}
              {header('fragmentation', 'Frag', 'Chance to fragment inside the body for extra damage')}
              {header('speed', 'Speed', 'Muzzle velocity in metres per second')}
              {header('recoil', 'Recoil', 'Change to weapon recoil (minus is better)')}
              {header('accuracy', 'Accuracy', 'Change to weapon accuracy (plus is better)')}
              <th className="px-2 py-2 text-left font-medium uppercase tracking-wide">Tracer</th>
              {header('price', 'Price', 'Cheapest price for one round')}
              <th className="px-2 py-2 text-left font-medium uppercase tracking-wide">Buy from</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {filtered.map((r) => {
              const a = r.item.ammo
              const verdict = VERDICT_STYLE[armorVerdict(a.penetrationPower, armorClass)]
              return (
                <tr key={r.item.id} className="hover:bg-surface-3">
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-2">
                      {r.item.iconLink ? <img src={r.item.iconLink} alt="" className="h-7 w-7 object-contain" loading="lazy" /> : <Crosshair className="h-5 w-5 text-ink-dim" />}
                      <span>{r.item.name}</span>
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-xs text-ink-muted">{caliberLabel(a.caliber)}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">
                    {a.projectileCount > 1 ? <span title={`${a.projectileCount} pellets × ${a.damage}`}>{shotDamage(a)} <span className="text-xs text-ink-dim">({a.projectileCount}×{a.damage})</span></span> : a.damage}
                  </td>
                  <td className={`whitespace-nowrap px-2 py-1.5 text-right font-medium tabular-nums ${verdict.cls}`} title={`Class ${armorClass}: ${verdict.label} (approximate)`}>
                    <span className="inline-flex items-center gap-1"><verdict.Icon className="h-3 w-3" aria-hidden />{a.penetrationPower}</span>
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{a.armorDamage}%</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{Math.round(a.fragmentationChance * 100)}%</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{a.initialSpeed ? Math.round(a.initialSpeed) : '—'}</td>
                  <td className={`whitespace-nowrap px-2 py-1.5 text-right tabular-nums ${a.recoilModifier < 0 ? 'text-success' : a.recoilModifier > 0 ? 'text-danger' : 'text-ink-dim'}`}>{formatModifier(a.recoilModifier)}</td>
                  <td className={`whitespace-nowrap px-2 py-1.5 text-right tabular-nums ${a.accuracyModifier > 0 ? 'text-success' : a.accuracyModifier < 0 ? 'text-danger' : 'text-ink-dim'}`}>{formatModifier(a.accuracyModifier)}</td>
                  <td className="px-2 py-1.5 text-xs">{a.tracer ? `Yes${a.tracerColor ? ` (${a.tracerColor})` : ''}` : <span className="text-ink-dim">—</span>}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums text-xs">{r.price == null ? <span className="text-ink-dim">—</span> : formatRoubles(r.price)}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-xs text-ink-muted">
                    {r.source ?? <span className="text-ink-dim">{r.traderNote ? 'Trader offer not verified' : r.fleaNote ? 'Flea price not verified' : 'Loot or barter only'}</span>}
                    {r.traderNote && <div className="max-w-56 whitespace-normal text-ink-dim">{r.traderNote}</div>}
                    {r.fleaNote && <div className="max-w-56 whitespace-normal text-ink-dim">{r.fleaNote}</div>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {filtered.length === 0 && <p className="px-4 py-10 text-center text-sm text-ink-muted">No ammo matches these filters.</p>}
      </div>
      <p className="mt-2 text-xs text-ink-dim">
        Stats from tarkov.dev. Trader prices are only shown when your recorded loyalty level, quest unlock and the per-restock purchase limit allow buying that offer. Flea averages are only shown when the flea market's minimum level and this item's own level allow buying it. Anything else is labelled as a reference you cannot pay. Buckshot damage is the total of all pellets.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Scatter chart: one dot per round, penetration across, damage up.
// ---------------------------------------------------------------------------

const W = 640
const H = 280
const M = { top: 12, right: 16, bottom: 36, left: 44 }

function niceMax(v: number, step: number): number {
  return Math.max(step, Math.ceil(v / step) * step)
}

function AmmoScatter({ rows, armorClass }: { rows: AmmoRow[]; armorClass: number }) {
  const maxPen = niceMax(Math.max(...rows.map((r) => r.item.ammo.penetrationPower)) + 5, 10)
  const maxDmg = Math.max(...rows.map((r) => shotDamage(r.item.ammo)))
  const dmgStep = maxDmg > 200 ? 50 : maxDmg > 100 ? 25 : 20
  const yMax = niceMax(maxDmg * 1.08, dmgStep)
  const plotW = W - M.left - M.right
  const plotH = H - M.top - M.bottom
  const x = (v: number) => M.left + (v / maxPen) * plotW
  const y = (v: number) => M.top + plotH - (v / yMax) * plotH
  const xTicks = Array.from({ length: maxPen / 10 + 1 }, (_, i) => i * 10)
  const yTicks = Array.from({ length: Math.round(yMax / dmgStep) + 1 }, (_, i) => i * dmgStep)
  // Label dots only when there are few enough to stay readable.
  const showLabels = rows.length <= 18

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 h-auto w-full max-w-3xl" role="img" aria-label="Damage versus penetration for each round of this calibre">
      {/* grid */}
      {yTicks.map((t) => (
        <g key={`y${t}`}>
          <line x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} stroke="var(--color-line)" strokeWidth={1} />
          <text x={M.left - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--color-ink-dim)">{t}</text>
        </g>
      ))}
      {xTicks.map((t) => {
        const isClass = t === armorClass * 10
        return (
          <g key={`x${t}`}>
            <line
              x1={x(t)} x2={x(t)} y1={M.top} y2={M.top + plotH}
              stroke={isClass ? 'var(--color-ink-dim)' : 'var(--color-line)'}
              strokeWidth={1}
              strokeDasharray={isClass ? '4 3' : undefined}
            />
            <text x={x(t)} y={M.top + plotH + 14} textAnchor="middle" fontSize={11} fill="var(--color-ink-dim)">{t}</text>
          </g>
        )
      })}
      {armorClass * 10 <= maxPen && (
        <text x={x(armorClass * 10) + 4} y={M.top + 10} fontSize={10} fill="var(--color-ink-muted)">class {armorClass}</text>
      )}
      {/* axis titles */}
      <text x={M.left + plotW / 2} y={H - 4} textAnchor="middle" fontSize={11} fill="var(--color-ink-muted)">Penetration</text>
      <text transform={`translate(12 ${M.top + plotH / 2}) rotate(-90)`} textAnchor="middle" fontSize={11} fill="var(--color-ink-muted)">Damage per shot</text>
      {/* dots */}
      {rows.map((r) => {
        const a = r.item.ammo
        const cx = x(a.penetrationPower)
        const cy = y(shotDamage(a))
        return (
          <g key={r.item.id}>
            <title>{`${r.item.name}: damage ${shotDamage(a)}, penetration ${a.penetrationPower}, armour damage ${a.armorDamage}%${r.price != null ? `, ${formatRoubles(r.price)}` : ''}`}</title>
            <circle cx={cx} cy={cy} r={10} fill="transparent" />
            <circle cx={cx} cy={cy} r={5} fill="var(--color-accent)" stroke="var(--color-surface-2)" strokeWidth={2} />
            {showLabels && (
              <text x={cx > W - 90 ? cx - 8 : cx + 8} y={cy} dy="0.32em" textAnchor={cx > W - 90 ? 'end' : 'start'} fontSize={10} fill="var(--color-ink-muted)" pointerEvents="none">{r.item.shortName}</text>
            )}
          </g>
        )
      })}
    </svg>
  )
}
