import { useMemo, useRef, useState } from 'react'
import { CheckCheck, ChevronDown, ChevronRight, GripHorizontal, Loader2, SlidersHorizontal } from 'lucide-react'
import type { Item } from '../api/types'
import { sellValue } from '../lib/economy'
import { formatRoubles } from '../lib/format'
import { DEFAULT_KEEP, KEEP_KINDS, keepLabel, keptKind, type KeepKind } from '../scan/keepKinds'
import { groupDetections, needLookup, sourceLabel, sortSell, stashValues, type Confidence, type KeepLine, type SellSort } from '../scan/stashValues'
import { useDetails } from './detailsContext'
import { useFrame } from './frameContext'
import { LIMITS, useOverlayPrefs } from './overlayPrefs'
import { useDrag } from './shell'
import { confirmScan, useStashScan, type StashScan } from './stashScan'

const KEEP_FILL = 'rgba(34,197,94,0.32)'
const REVIEW_FILL = 'rgba(245,158,11,0.28)'

/** The last snip, what was found in it, and how it splits into keep and sell. */
function useScanAnalysis() {
  const ctx = useDetails()
  const scan = useStashScan((s) => s.scan)
  // What to keep back (Values panel checkboxes): the needs that count, and kinds kept whole.
  const keep = useOverlayPrefs((p) => p.keep)
  const stars = useOverlayPrefs((p) => p.stars)
  const kinds = useMemo(() => new Set<KeepKind>(keep), [keep])
  const starred = useMemo(() => new Set(stars.filter((r) => r.kind === 'item').map((r) => r.id)), [stars])
  const needFor = useMemo(() => needLookup(ctx.needs.values(), ctx.collected, kinds), [ctx.needs, ctx.collected, kinds])
  const found = useMemo(() => (scan?.status === 'done' ? groupDetections(scan.detections) : []), [scan])
  const values = useMemo(() => (ctx.items ? stashValues(found, needFor, ctx.items, (item, count) => sellValue(item, count, ctx.feeContext), (it) => keptKind(it, kinds, starred)) : null), [found, needFor, ctx.items, ctx.feeContext, kinds, starred])
  // How many of each item to keep (the rest is spare).
  const keepById = useMemo(() => {
    const m = new Map<string, number>()
    for (const k of values?.keep ?? []) m.set(k.itemId, (m.get(k.itemId) ?? 0) + k.count)
    return m
  }, [values])
  return { ctx, scan, found, values, keepById }
}

function ScanStatus({ scan }: { scan: StashScan | null }) {
  if (!scan) return <p className="text-xs text-white/60">Click the camera next to the glass, then drag a box around stash or container slots.</p>
  if (scan.status === 'error') return <p className="text-xs text-red-300">The scan failed: {scan.error}</p>
  if (scan.status === 'done') return null
  const text = scan.status === 'matching' ? `Matching items… ${Math.round(scan.progress * 100)}%` : 'Reading item names…'
  return (
    <p className="flex items-center gap-1.5 text-xs text-white/70">
      <Loader2 className="h-3.5 w-3.5 animate-spin" /> {text}
    </p>
  )
}

const CONF: Record<Confidence, { label: string; cls: string }> = {
  sure: { label: '', cls: '' },
  likely: { label: 'likely', cls: 'border-amber-300/50 text-amber-200' },
  check: { label: 'check', cls: 'border-red-400/60 text-red-300' },
}

function ConfChip({ c }: { c: Confidence }) {
  if (c === 'sure') return null
  return (
    <span className={`rounded border px-1 text-[10px] ${CONF[c].cls}`} title={c === 'check' ? 'Not sure this is the right item: check it in game' : 'Probably right'}>
      {CONF[c].label}
    </span>
  )
}

/** "for Gunsmith (Mechanic) +2 more · 3 still needed", or the ticked kind it falls under. */
function keepReason(k: KeepLine, short = false): string {
  const need = k.need ? `for ${sourceLabel(k.need.sources[0])}${k.need.sources.length > 1 ? ` +${k.need.sources.length - 1} more` : ''}` : ''
  if (!k.kind) return short ? need : `${need} · ${k.need && Number.isFinite(k.need.remaining) ? k.need.remaining + ' still needed' : 'quantity unverified'}`
  return need ? `${need} · all ${keepLabel(k.kind).toLowerCase()} kept` : `kept: ${keepLabel(k.kind).toLowerCase()}`
}

/** The checkboxes of what the sell list keeps back (quests, hideout, keys…). Changes apply at once. */
function KeepChoices() {
  const keep = useOverlayPrefs((p) => p.keep)
  const open = useOverlayPrefs((p) => p.keepOpen)
  const set = useOverlayPrefs((p) => p.set)
  const toggle = (k: KeepKind) => set({ keep: keep.includes(k) ? keep.filter((x) => x !== k) : [...keep, k] })
  const isDefault = keep.length === DEFAULT_KEEP.length && DEFAULT_KEEP.every((k) => keep.includes(k))
  return (
    <div className="rounded border border-white/15">
      <button type="button" onClick={() => set({ keepOpen: !open })} className="flex w-full items-center gap-1 px-2 py-1 text-left text-[11px] text-white/70 hover:text-white" aria-expanded={open}>
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span className="flex-1 uppercase tracking-wide">Tracked keep hints</span>
        <span className="text-white/45">{keep.length} ticked</span>
      </button>
      {open && (
        <div className="border-t border-white/10 px-2 py-1.5">
          <ul className="grid grid-cols-2 gap-x-2 gap-y-0.5">
            {KEEP_KINDS.map((k) => (
              <li key={k.id}>
                <label className="flex cursor-pointer items-center gap-1.5 py-0.5 text-[11px] text-white/80 hover:text-white" title={k.note}>
                  <input type="checkbox" checked={keep.includes(k.id)} onChange={() => toggle(k.id)} className="h-3 w-3 accent-amber-300" />
                  <span className="truncate">{k.label}</span>
                </label>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[10px] text-white/45">
            Quests, Collector and hideout highlight estimated needs. Other selections highlight every match.{' '}
            {!isDefault && (
              <button type="button" onClick={() => set({ keep: DEFAULT_KEEP })} className="underline hover:text-white">
                Back to quests + hideout
              </button>
            )}
          </p>
        </div>
      )}
    </div>
  )
}

/** The snip picture, as tall as you drag its bottom edge (remembered). */
function useSnipHeight() {
  const { zoom } = useFrame()
  const saved = useOverlayPrefs((p) => p.snipH)
  const set = useOverlayPrefs((p) => p.set)
  const [live, setLive] = useState<number | null>(null)
  const start = useRef(saved)
  const last = useRef<number | null>(null)
  const [lo, hi] = LIMITS.snipH
  const grip = useDrag({
    onStart: () => {
      start.current = saved
    },
    onMove: (_dx, dy) => {
      last.current = Math.min(hi, Math.max(lo, Math.round(start.current + dy / zoom)))
      setLive(last.current)
    },
    onEnd: () => {
      if (last.current !== null) set({ snipH: last.current })
      last.current = null
      setLive(null)
    },
  })
  return { height: live ?? saved, grip }
}

function Icon({ item }: { item: Item | undefined }) {
  return item?.iconLink ? <img src={item.iconLink} alt="" className="h-7 w-7 shrink-0 rounded-sm bg-white/5 object-contain" loading="lazy" /> : <span className="h-7 w-7 shrink-0 rounded-sm bg-white/5" />
}

/**
 * "Item scan" panel: the snip with a box per item found (green = keep, you still need it;
 * red = spare), and each item with what it is needed for.
 */
export function ScanItemsView() {
  const { ctx, scan, found, values, keepById } = useScanAnalysis()
  const snip = useSnipHeight()
  const [hover, setHover] = useState<string | null>(null)
  const [confirmNote, setConfirmNote] = useState<string | null>(null)
  // Items whose boxes came from your corrections (saved earlier or fixed in tuning).
  const remembered = useMemo(() => {
    const m = new Map<string, 'fixed' | 'learned'>()
    scan?.detections.forEach((d, i) => {
      if (!d.itemId) return
      if (scan.fixed.includes(i)) m.set(d.itemId, 'fixed')
      else if (d.learned && !m.has(d.itemId)) m.set(d.itemId, 'learned')
    })
    return m
  }, [scan])
  const unsure = found.filter((f) => f.confidence !== 'sure').length
  const name = (id: string) => ctx.items?.[id]?.name ?? 'Unknown item'
  const keepOf = (id: string) => values?.keep.find((k) => k.itemId === id)
  const rows = useMemo(
    () => [...found].sort((a, b) => Number(keepById.has(b.itemId)) - Number(keepById.has(a.itemId)) || (ctx.items?.[a.itemId]?.name ?? '').localeCompare(ctx.items?.[b.itemId]?.name ?? '')),
    [found, keepById, ctx.items],
  )
  // Keep the first spots of an item up to what you need; the rest are spare.
  const spotKeep = new Map<number, boolean>()
  for (const f of found) f.spots.forEach((s, i) => spotKeep.set(s, i < (keepById.get(f.itemId) ?? 0)))
  const grid = scan?.grid
  const total = found.reduce((s, f) => s + f.count, 0)

  return (
    <div className="space-y-2 text-xs">
      <ScanStatus scan={scan} />
      {scan && (
        // Pinned: the list scrolls underneath, the picture stays (hover a row to see its boxes).
        <div className="sticky -top-2.5 z-10 -mx-2.5 -mt-2.5 flex justify-center border-b border-white/10 bg-black px-2.5 pb-3 pt-2.5">
          <div className="relative inline-block overflow-hidden rounded border border-white/10">
          <img src={scan.url} alt="Your snip" className="block w-auto max-w-full" style={{ maxHeight: snip.height }} />
          {scan.status === 'done' && (
            <button
              type="button"
              onClick={() => useStashScan.getState().setTuning(true)}
              title="Full screen: move, resize, draw or delete boxes and pick the right items. Every fix is remembered for the next scans."
              className="absolute right-1 top-1 z-10 flex items-center gap-1 rounded border border-white/25 bg-black/80 px-1.5 py-0.5 text-[11px] text-white/85 shadow hover:border-white/60 hover:text-white"
            >
              <SlidersHorizontal className="h-3 w-3" /> Manual tuning
            </button>
          )}
          {grid && (
            <svg viewBox={`0 0 ${scan.width} ${scan.height}`} className="absolute inset-0 h-full w-full" preserveAspectRatio="none">
              {scan.detections.map((d, i) =>
                d.itemId ? (
                  <rect
                    key={i}
                    x={grid.ox + d.col * grid.pitch + 1}
                    y={grid.oy + d.row * grid.pitch + 1}
                    width={d.w * grid.pitch - 2}
                    height={d.h * grid.pitch - 2}
                    fill={spotKeep.get(i) ? KEEP_FILL : REVIEW_FILL}
                    stroke={hover === d.itemId ? '#fde68a' : 'rgba(255,255,255,0.35)'}
                    strokeWidth={hover === d.itemId ? Math.max(3, grid.pitch / 14) : 1}
                  >
                    <title>{`${name(d.itemId)} · ${spotKeep.get(i) ? 'tracked keep hint' : 'review'}`}</title>
                  </rect>
                ) : null,
              )}
            </svg>
          )}
          </div>
          <span {...snip.grip} title="Drag to make the picture bigger or smaller (widen the panel too for more)" aria-label="Resize the picture" className="absolute inset-x-0 bottom-0 flex h-2.5 cursor-ns-resize touch-none justify-center text-white/30 hover:text-white">
            <GripHorizontal className="h-3 w-3 -translate-y-0.5" />
          </span>
        </div>
      )}
      {scan?.status === 'done' && (
        <>
          <p className="text-white/55">
            {total === 0 ? 'No items found. Try a box that covers whole slots, or Manual tuning.' : `${total} item${total === 1 ? '' : 's'}, ${found.length} kind${found.length === 1 ? '' : 's'}.`}{' '}
            <span className="text-emerald-300/80">Green</span> = tracked keep hint, <span className="text-amber-300/80">amber</span> = review.
          </p>
          {unsure > 0 && !scan.confirmed && (
            <button
              type="button"
              onClick={() => void confirmScan(scan.id).then((n) => setConfirmNote(n ? `Remembered ${n} find${n === 1 ? '' : 's'}: next time they count as sure.` : 'Nothing new to remember.'))}
              title="Everything in this snip is named right: the scanner remembers these looks (wrong ones? use Manual tuning instead)"
              className="flex items-center gap-1 rounded border border-white/20 px-1.5 py-0.5 text-[11px] text-white/75 hover:border-white/50 hover:text-white"
            >
              <CheckCheck className="h-3 w-3" /> All correct ({unsure} unsure)
            </button>
          )}
          {confirmNote && <p className="text-[11px] text-sky-300">{confirmNote}</p>}
          <ul className="space-y-1">
            {rows.map((f) => {
              const keep = keepById.get(f.itemId) ?? 0
              const why = keepOf(f.itemId)
              return (
                <li key={f.itemId}>
                  <button
                    type="button"
                    onClick={() => ctx.open({ kind: 'item', id: f.itemId })}
                    onMouseEnter={() => setHover(f.itemId)}
                    onMouseLeave={() => setHover(null)}
                    className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-white/10"
                  >
                    <Icon item={ctx.items?.[f.itemId]} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1">
                        <span className="truncate">{name(f.itemId)}</span>
                        <span className="text-white/50">×{f.count}</span>
                        <ConfChip c={f.confidence} />
                        {remembered.get(f.itemId) && (
                          <span className="rounded border border-sky-300/50 px-1 text-[10px] text-sky-200" title={remembered.get(f.itemId) === 'fixed' ? 'Fixed by you in Manual tuning' : 'Matched one of your saved corrections'}>
                            {remembered.get(f.itemId) === 'fixed' ? 'fixed' : 'learned'}
                          </span>
                        )}
                      </span>
                      {keep > 0 && why ? (
                        <span className="block truncate text-[11px] text-emerald-300/90" title={why.need?.sources.map(sourceLabel).join('\n')}>
                          Keep {keep < f.count ? `${keep} ` : ''}
                          {keepReason(why, true)}
                        </span>
                      ) : (
                        <span className="block text-[11px] text-white/45">Review before selling</span>
                      )}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </div>
  )
}

const SORTS: { id: SellSort; label: string }[] = [
  { id: 'total', label: 'Stack' },
  { id: 'each', label: 'Each' },
  { id: 'slot', label: 'Per slot' },
]

/**
 * "Values" panel: everything spare from the snip, priciest first (best of flea after the fee and
 * traders), and at the bottom "Do not sell": what you still need, with what for.
 */
export function ScanValuesView() {
  const { ctx, scan, values } = useScanAnalysis()
  const [sort, setSort] = useState<SellSort>('total')
  const items = ctx.items
  const sell = useMemo(() => (values ? sortSell(values.sell, sort, (id) => items?.[id]?.name ?? id) : []), [values, sort, items])
  if (!scan || scan.status !== 'done') return <ScanStatus scan={scan} />
  if (!values || !items) return <p className="text-xs text-white/60">Loading prices…</p>
  const priced = sell.filter((l) => l.total > 0)
  const unpriced = sell.filter((l) => l.total <= 0)
  const via = (l: (typeof sell)[number]) => (l.via === 'flea' ? 'Flea' : l.via === 'trader' ? ctx.traderName(items[l.itemId]?.sellToTrader[0]?.traderId ?? '') : '')

  return (
    <div className="space-y-2 text-xs">
      <KeepChoices />
      <p className="text-[11px] text-white/55">Review before selling. Prices assume one unit per detected stack. The scan cannot verify quantity, condition, found-in-raid status or safe surplus.</p>
      <div className="flex items-center gap-2">
        <span className="flex-1 text-white/70">
          {sell.length === 0 ? 'No detections left to price.' : <>Catalog reference: <span className="font-semibold text-white">{formatRoubles(values.total)}</span></>}
        </span>
        {sell.length > 1 && (
          <span className="flex rounded border border-white/15 p-0.5">
            {SORTS.map((s) => (
              <button key={s.id} type="button" onClick={() => setSort(s.id)} className={`rounded px-1.5 py-0.5 text-[10px] ${sort === s.id ? 'bg-white/20 text-white' : 'text-white/55 hover:text-white'}`}>
                {s.label}
              </button>
            ))}
          </span>
        )}
      </div>
      {priced.length > 0 && (
        <ul className="space-y-1">
          {priced.map((l) => {
            const item = items[l.itemId]
            return (
              <li key={l.itemId}>
                <button type="button" onClick={() => ctx.open({ kind: 'item', id: l.itemId })} className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-white/10">
                  <Icon item={item} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1">
                      <span className="truncate">{item?.shortName ?? l.itemId}</span>
                      {l.count > 1 && <span className="text-white/50">×{l.count}</span>}
                      <ConfChip c={l.confidence} />
                    </span>
                    <span className="block text-[11px] text-white/50">
                      {l.count > 1 ? `${formatRoubles(l.each)} each · ` : ''}
                      {formatRoubles(l.perSlot)}/slot{via(l) ? ` · ${via(l)}` : ''}
                      {item?.weapon ? ' · bare gun, parts not counted' : ''}
                    </span>
                  </span>
                  <span className="shrink-0 font-semibold tabular-nums text-white">{formatRoubles(sort === 'each' ? l.each : sort === 'slot' ? l.perSlot : l.total)}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {unpriced.length > 0 && (
        <p className="text-[11px] text-white/45">No price known: {unpriced.map((l) => `${items[l.itemId]?.shortName ?? l.itemId}${l.count > 1 ? ` ×${l.count}` : ''}`).join(', ')}</p>
      )}
      <div className="rounded border border-amber-300/30 bg-amber-300/5 p-2">
        <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-amber-200">Tracked keep hints</h4>
        {values.keep.length === 0 ? (
          <p className="text-white/55">No matches for the selected keep hints.</p>
        ) : (
          <ul className="space-y-1">
            {values.keep.map((k) => (
              <li key={k.itemId}>
                <button type="button" onClick={() => ctx.open({ kind: 'item', id: k.itemId })} className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-white/10" title={k.need?.sources.map(sourceLabel).join('\n')}>
                  <Icon item={items[k.itemId]} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1">
                      <span className="truncate">{items[k.itemId]?.shortName ?? k.itemId}</span>
                      <span className="text-white/50">×{k.count}</span>
                      {k.fir && <span className="rounded border border-sky-300/50 px-1 text-[10px] text-sky-200" title="Needed found in raid: check the tick on the item">FIR</span>}
                      <ConfChip c={k.confidence} />
                    </span>
                    <span className="block truncate text-[11px] text-white/55">{keepReason(k)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
