import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Check, Grid3x3, Loader2, Minus, MousePointer2, Plus, Search, SquareDashed, Trash2, X, ZoomIn, ZoomOut } from 'lucide-react'
import { cellAt, covers, moveBox, resizeBox, sameCells, spanCells, type Cells, type Corner } from '../scan/boxEdit'
import { keepCellSize } from '../scan/cellSize'
import type { Detection, Grid } from '../scan/core'
import { recordFromSpot, useLearnedStore, type LearnedKind } from '../scan/learned'
import { identifyBox, type IdentifyMatch } from '../scan/scanner'
import { confidence, marginOf } from '../scan/stashValues'
import { useDetails } from './detailsContext'
import { endTuning, prepareTuning, useStashScan } from './stashScan'

type EditDet = Detection & { removed?: boolean; edited?: boolean; fixed?: boolean }

/** Most zoom on top of "whole snip on the screen". */
const MAX_ZOOM = 6
type Cell = { col: number; row: number }
type Drag = { kind: 'move'; spot: number; start: Cell; orig: Cells } | { kind: 'resize'; spot: number; corner: Corner; orig: Cells } | { kind: 'new'; start: Cell; startPx: { x: number; y: number } }

const cellsOf = (d: Cells): Cells => ({ col: d.col, row: d.row, w: d.w, h: d.h })
/** A box as the scan keeps it (without the editor's own marks). */
const plain = (d: EditDet): Detection => ({ itemId: d.itemId, col: d.col, row: d.row, w: d.w, h: d.h, rotated: d.rotated, error: d.error, alternatives: d.alternatives, learned: d.learned, nameMatch: d.nameMatch, clipped: d.clipped, byName: d.byName })
const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se']

/**
 * Manual tuning (the Item scan's button): the snip full screen with its boxes. Move or resize a
 * box, draw new ones, delete wrong ones, and pick the right item for a box. Boxes snap to the stash
 * grid. Every box you fix is remembered (the same memory as the app's scanner), so the next scan
 * of that item at that size gets it right by itself; the cell size is kept for the next snips.
 */
export default function TuneLayer() {
  const ctx = useDetails()
  const scan = useStashScan((s) => s.scan)
  const id = scan?.id ?? 0
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [grid, setGrid] = useState<Grid | null>(null)
  const [dets, setDets] = useState<EditDet[]>([])
  // The boxes as they were when tuning started (what a fix replaces: "not this item").
  const startDets = useRef<EditDet[]>([])
  const [tool, setTool] = useState<'move' | 'draw'>('move')
  const [selected, setSelected] = useState<number | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [draft, setDraft] = useState<Cells | null>(null)
  const [matches, setMatches] = useState<IdentifyMatch[] | null>(null)
  const [query, setQuery] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [showGrid, setShowGrid] = useState(true)
  const [taught, setTaught] = useState(0)
  const [fit, setFit] = useState(1)
  // Zoom on top of the fitted size (1 = the whole snip on the screen); the stage scrolls when bigger.
  const [zoom, setZoom] = useState(1)
  const keepPoint = useRef<{ fx: number; fy: number; px: number; py: number } | null>(null)
  const svg = useRef<SVGSVGElement>(null)
  const stage = useRef<HTMLDivElement>(null)

  /** Zooms in or out, keeping the spot under the mouse (or the middle) where it is. */
  const zoomTo = (z: number, at?: { clientX: number; clientY: number }) => {
    const el = stage.current
    const next = Math.round(Math.min(MAX_ZOOM, Math.max(1, z)) * 100) / 100
    if (!el || next === zoom) return
    const r = el.getBoundingClientRect()
    const px = at ? at.clientX - r.left : el.clientWidth / 2
    const py = at ? at.clientY - r.top : el.clientHeight / 2
    keepPoint.current = { fx: (el.scrollLeft + px) / el.scrollWidth, fy: (el.scrollTop + py) / el.scrollHeight, px, py }
    setZoom(next)
  }
  useLayoutEffect(() => {
    const el = stage.current
    const p = keepPoint.current
    if (!el || !p) return
    keepPoint.current = null
    el.scrollLeft = p.fx * el.scrollWidth - p.px
    el.scrollTop = p.fy * el.scrollHeight - p.py
  }, [zoom])
  // Ctrl + mouse wheel zooms at the mouse (a plain wheel scrolls).
  useEffect(() => {
    const el = stage.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      zoomTo(zoom * (e.deltaY < 0 ? 1.25 : 0.8), e)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  const ready = (r: { grid: Grid; detections: Detection[] } | null) => {
    if (!r) return setPhase('error')
    setGrid(r.grid)
    const ds = r.detections.map((d) => ({ ...d }))
    startDets.current = ds
    setDets(ds)
    setSelected(null)
    setMatches(null)
    setPhase('ready')
  }

  /** Another slot size: the snip is scanned again with it (your box edits start over). */
  const resize = (pitch: number) => {
    setPhase('loading')
    void prepareTuning(id, pitch)
      .catch(() => null)
      .then(ready)
  }

  // The scanner scans the snip once more so it can name boxes you move or draw.
  useEffect(() => {
    let alive = true
    void prepareTuning(id)
      .catch(() => null)
      .then((r) => alive && ready(r))
    return () => {
      alive = false
    }
  }, [id])

  // The snip as big as the screen allows (small snips up to 4×).
  useEffect(() => {
    const el = stage.current
    if (!el || !scan) return
    const ro = new ResizeObserver(() => setFit(Math.max(0.1, Math.min(4, (el.clientWidth - 24) / scan.width, (el.clientHeight - 24) / scan.height))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [scan])

  /** Remembers a box: this look at this size is the item (and, when fixed, not what was guessed there). */
  const teach = async (geom: Cells, itemId: string, wrong: EditDet | null, kind: LearnedKind = 'correct') => {
    if (!scan || !grid) return
    const store = useLearnedStore.getState()
    await store.load()
    const det: Detection = { itemId, ...geom, rotated: false, error: 0, alternatives: [] }
    const rec = await recordFromSpot(scan.image, grid, det, geom.w, geom.h, itemId, kind).catch(() => null)
    if (rec) await store.add(rec)
    if (wrong?.itemId && wrong.itemId !== itemId) {
      const not = await recordFromSpot(scan.image, grid, wrong, wrong.w, wrong.h, wrong.itemId, 'not').catch(() => null)
      if (not) await store.add(not)
    }
    if (rec) setTaught((n) => n + 1)
  }

  const short = (itemId: string) => ctx.items?.[itemId]?.shortName ?? (itemId ? 'item' : '?')

  /** Puts one box under an item; `byHand` = you picked it (remembered right away). */
  const assign = (spot: number, geom: Cells, itemId: string, ms: IdentifyMatch[], byHand: boolean) => {
    const m0 = ms.find((m) => m.itemId === itemId)
    const others = ms.filter((m) => m.itemId !== itemId)
    setDets((ds) =>
      ds.map((d, i) =>
        i === spot
          ? // A box named again after a move or resize is the scanner's guess again, not your pick.
            { ...d, ...geom, itemId, error: m0?.error ?? 0, rotated: m0?.rotated ?? false, nameMatch: m0?.nameMatch || undefined, learned: m0?.learned || undefined, alternatives: others.slice(0, 6).map((m) => ({ itemId: m.itemId, error: m.error })), fixed: byHand }
          : d,
      ),
    )
    setNote(null)
    if (byHand) {
      void teach(geom, itemId, startDets.current[spot] ?? null)
      setNote(`Remembered: ${short(itemId)} at this size and look. Next time it is found by itself.`)
    }
  }

  const loadMatches = (geom: Cells) => {
    setMatches(null)
    void identifyBox(geom)
      .then(setMatches)
      .catch(() => setMatches([]))
  }

  /** A box moved, resized or drawn: boxes it covers go, then it is named again. */
  const commit = async (spot: number | null, geom: Cells) => {
    const idx = spot ?? dets.length
    const prev = spot !== null ? dets[spot] : null
    const swallowed = dets.map((d, i) => (i !== idx && !d.removed && covers(geom, d) ? i : -1)).filter((i) => i >= 0)
    setDets((ds) => {
      const next = ds.map((d, i) => (swallowed.includes(i) ? { ...d, removed: true } : d))
      if (spot === null) next.push({ itemId: '', ...geom, rotated: false, error: 99, alternatives: [], edited: true })
      else next[spot] = { ...next[spot], ...geom, edited: true }
      return next
    })
    setSelected(idx)
    setQuery('')
    setMatches(null)
    const ms = await identifyBox(geom).catch(() => [] as IdentifyMatch[])
    setMatches(ms)
    // Keep the item when the box only moved and it still fits there; otherwise the best match.
    const keep = prev?.itemId && ms.slice(0, 3).some((m) => m.itemId === prev.itemId) ? prev.itemId : ms[0]?.itemId
    if (keep) assign(idx, geom, keep, ms, false)
    else {
      setDets((ds) => ds.map((d, i) => (i === idx ? { ...d, itemId: '' } : d)))
      setNote(`No item is ${geom.w}×${geom.h} slots. Resize the box, or search for the item.`)
    }
  }

  const remove = (spot: number) => {
    setDets((ds) => ds.map((d, i) => (i === spot ? { ...d, removed: true } : d)))
    setSelected(null)
    setMatches(null)
  }

  const toImage = (e: ReactPointerEvent) => {
    const r = svg.current?.getBoundingClientRect()
    if (!r || !scan) return { x: 0, y: 0 }
    return { x: ((e.clientX - r.left) / r.width) * scan.width, y: ((e.clientY - r.top) / r.height) * scan.height }
  }

  const onDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!grid || phase !== 'ready' || e.button !== 0) return
    const p = toImage(e)
    const cell = cellAt(grid, p.x, p.y)
    const target = e.target as Element
    const handle = target.closest('[data-handle]') as SVGElement | null
    const box = target.closest('[data-spot]') as SVGElement | null
    if (tool === 'draw') {
      setSelected(null)
      setDrag({ kind: 'new', start: cell, startPx: p })
      setDraft(spanCells(cell, cell))
    } else if (handle && selected !== null && dets[selected]) {
      const orig = cellsOf(dets[selected])
      setDrag({ kind: 'resize', spot: selected, corner: handle.dataset.handle as Corner, orig })
      setDraft(orig)
    } else if (box) {
      const spot = Number(box.dataset.spot)
      const orig = cellsOf(dets[spot])
      if (spot !== selected) {
        setSelected(spot)
        setQuery('')
        setNote(null)
        loadMatches(orig)
      }
      setDrag({ kind: 'move', spot, start: cell, orig })
      setDraft(orig)
    } else {
      setSelected(null)
      setDrag({ kind: 'new', start: cell, startPx: p })
      setDraft(spanCells(cell, cell))
    }
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // the pointer is already gone
    }
  }
  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag || !grid) return
    const p = toImage(e)
    const cell = cellAt(grid, p.x, p.y)
    if (drag.kind === 'move') setDraft(moveBox(drag.orig, drag.start, cell, grid))
    else if (drag.kind === 'resize') setDraft(resizeBox(drag.orig, drag.corner, cell))
    else setDraft(spanCells(drag.start, cell))
  }
  const onUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag
    const geom = draft
    setDrag(null)
    setDraft(null)
    if (!d || !geom) return
    if (d.kind === 'new') {
      // A plain click on an empty spot only deselects; a drag (even inside one slot) draws a box.
      const p = toImage(e)
      if (Math.hypot(p.x - d.startPx.x, p.y - d.startPx.y) < 6) return
      void commit(null, geom)
    } else if (!sameCells(geom, d.orig)) void commit(d.spot, geom)
  }

  const finish = async () => {
    if (!scan || !grid) return endTuning()
    // Boxes you shaped but did not name by hand are remembered more weakly (the item is the scanner's guess you kept).
    for (const d of dets) if (!d.removed && d.itemId && d.edited && !d.fixed) await teach(cellsOf(d), d.itemId, null, 'confirmed')
    const kept = dets.filter((d) => !d.removed && d.itemId)
    const fixed = kept.map((d, i) => (d.edited || d.fixed ? i : -1)).filter((i) => i >= 0)
    useStashScan.getState().patch(scan.id, { grid, detections: kept.map(plain), fixed, status: 'done' })
    keepCellSize(grid.pitch)
    endTuning()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.closest?.('input, textarea')
      if (!typing && selected !== null && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault()
        remove(selected)
      } else if (e.key === 'Escape') {
        if (selected !== null) setSelected(null)
        else endTuning()
      } else if (!typing && (e.key === '+' || e.key === '=')) zoomTo(zoom * 1.25)
      else if (!typing && e.key === '-') zoomTo(zoom * 0.8)
      else if (!typing && e.key === '0') zoomTo(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!ctx.items || q.length < 2) return []
    return Object.values(ctx.items)
      .filter((i) => i.name.toLowerCase().includes(q) || i.shortName.toLowerCase().includes(q))
      .slice(0, 8)
  }, [ctx.items, query])

  if (!scan) return null
  const sel = selected !== null ? dets[selected] : null
  const selGeom = sel && !sel.removed ? (drag && drag.kind !== 'new' && drag.spot === selected && draft ? draft : cellsOf(sel)) : null
  const live = dets.filter((d) => !d.removed).length
  const at = (c: Cells) => (grid ? { x: grid.ox + c.col * grid.pitch, y: grid.oy + c.row * grid.pitch, w: c.w * grid.pitch, h: c.h * grid.pitch } : { x: 0, y: 0, w: 0, h: 0 })
  const stroke = Math.max(1.5, (grid?.pitch ?? 60) / 30)
  const colour = (d: EditDet) => {
    if (!d.itemId) return { fill: 'rgba(255,255,255,0.08)', line: 'rgba(255,255,255,0.7)' }
    if (d.fixed || d.edited) return { fill: 'rgba(56,189,248,0.22)', line: '#38bdf8' }
    const c = confidence(d.error, marginOf(d), Boolean(d.nameMatch))
    return c === 'sure' ? { fill: 'rgba(34,197,94,0.18)', line: '#22c55e' } : c === 'likely' ? { fill: 'rgba(251,191,36,0.2)', line: '#fbbf24' } : { fill: 'rgba(239,68,68,0.22)', line: '#ef4444' }
  }

  return (
    <div data-solid className="absolute inset-0 z-[5000] flex flex-col bg-black/92 text-[13px] text-white" role="dialog" aria-label="Manual tuning">
      <header className="flex flex-wrap items-center gap-2 border-b border-white/10 px-4 py-2">
        <span className="font-semibold">Manual tuning</span>
        <span className="text-xs text-white/50">{phase === 'ready' ? `${live} boxes · drag to move, corners to resize` : ''}</span>
        <span className="ml-2 flex items-center gap-0.5 rounded border border-white/15 p-0.5 text-xs">
          <button type="button" onClick={() => setTool('move')} aria-pressed={tool === 'move'} className={`flex items-center gap-1 rounded px-2 py-0.5 ${tool === 'move' ? 'bg-white/20 text-white' : 'text-white/60 hover:text-white'}`}>
            <MousePointer2 className="h-3.5 w-3.5" /> Move / resize
          </button>
          <button
            type="button"
            onClick={() => {
              setTool('draw')
              setSelected(null)
            }}
            aria-pressed={tool === 'draw'}
            className={`flex items-center gap-1 rounded px-2 py-0.5 ${tool === 'draw' ? 'bg-white/20 text-white' : 'text-white/60 hover:text-white'}`}
          >
            <SquareDashed className="h-3.5 w-3.5" /> Draw new box
          </button>
        </span>
        <span className="flex items-center gap-1 text-xs text-white/60" title="Zoom in to place boxes exactly (Ctrl + mouse wheel, or + and -). The picture scrolls when it is bigger than the screen.">
          <button type="button" onClick={() => zoomTo(zoom * 0.8)} disabled={zoom <= 1} aria-label="Zoom out" className="rounded border border-white/15 p-0.5 hover:text-white disabled:opacity-40">
            <ZoomOut className="h-3.5 w-3.5" />
          </button>
          <span className="w-11 text-center tabular-nums text-white">{Math.round(zoom * 100)}%</span>
          <button type="button" onClick={() => zoomTo(zoom * 1.25)} disabled={zoom >= MAX_ZOOM} aria-label="Zoom in" className="rounded border border-white/15 p-0.5 hover:text-white disabled:opacity-40">
            <ZoomIn className="h-3.5 w-3.5" />
          </button>
          {zoom > 1 && (
            <button type="button" onClick={() => zoomTo(1)} className="rounded border border-white/15 px-1.5 py-0.5 hover:text-white">
              Fit
            </button>
          )}
        </span>
        <button type="button" onClick={() => setShowGrid((v) => !v)} aria-pressed={showGrid} className={`flex items-center gap-1 rounded border px-2 py-0.5 text-xs ${showGrid ? 'border-white/40 text-white' : 'border-white/15 text-white/60'}`}>
          <Grid3x3 className="h-3.5 w-3.5" /> Grid
        </button>
        {grid && (
          <span className="flex items-center gap-1 text-xs text-white/60" title="When the grid lines do not sit on the slot borders: change the slot size (the snip is scanned again)">
            Slot size
            <button type="button" disabled={phase !== 'ready'} onClick={() => resize(grid.pitch - 1)} aria-label="Smaller slots" className="rounded border border-white/15 p-0.5 hover:text-white disabled:opacity-40">
              <Minus className="h-3 w-3" />
            </button>
            <span className="w-14 text-center tabular-nums text-white">{grid.pitch.toFixed(1)} px</span>
            <button type="button" disabled={phase !== 'ready'} onClick={() => resize(grid.pitch + 1)} aria-label="Bigger slots" className="rounded border border-white/15 p-0.5 hover:text-white disabled:opacity-40">
              <Plus className="h-3 w-3" />
            </button>
          </span>
        )}
        {phase === 'loading' && (
          <span className="flex items-center gap-1.5 text-xs text-white/70">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Getting the boxes ready…
          </span>
        )}
        {phase === 'error' && <span className="text-xs text-red-300">The scanner could not start. Close and try again.</span>}
        <span className="ml-auto flex items-center gap-2">
          {taught > 0 && <span className="text-xs text-sky-300">{taught} fix{taught === 1 ? '' : 'es'} remembered</span>}
          <button type="button" onClick={() => endTuning()} className="flex items-center gap-1 rounded border border-white/20 px-2.5 py-1 text-xs text-white/75 hover:text-white">
            <X className="h-3.5 w-3.5" /> Cancel
          </button>
          <button type="button" disabled={phase !== 'ready'} onClick={() => void finish()} className="flex items-center gap-1 rounded border border-emerald-400/60 bg-emerald-500/20 px-2.5 py-1 text-xs font-medium text-emerald-100 hover:bg-emerald-500/30 disabled:opacity-40">
            <Check className="h-3.5 w-3.5" /> Done
          </button>
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        <div ref={stage} className="relative min-w-0 flex-1 overflow-auto [scrollbar-width:thin]">
          <div className="flex min-h-full w-max min-w-full items-center justify-center p-3">
          <div className="relative shrink-0" style={{ width: scan.width * fit * zoom, height: scan.height * fit * zoom }}>
            <img src={scan.url} alt="Your snip" draggable={false} className="absolute inset-0 h-full w-full select-none" style={{ imageRendering: fit * zoom > 1.5 ? 'pixelated' : 'auto' }} />
            {grid && (
              <svg
                ref={svg}
                viewBox={`0 0 ${scan.width} ${scan.height}`}
                className={`absolute inset-0 h-full w-full touch-none ${tool === 'draw' ? 'cursor-crosshair' : 'cursor-default'}`}
                onPointerDown={onDown}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerCancel={() => {
                  setDrag(null)
                  setDraft(null)
                }}
              >
                {showGrid && (
                  <g stroke="rgba(255,255,255,0.28)" strokeWidth={1} vectorEffect="non-scaling-stroke">
                    {Array.from({ length: grid.cols + 1 }, (_, c) => (
                      <line key={`c${c}`} x1={grid.ox + c * grid.pitch} y1={grid.oy} x2={grid.ox + c * grid.pitch} y2={grid.oy + grid.rows * grid.pitch} vectorEffect="non-scaling-stroke" />
                    ))}
                    {Array.from({ length: grid.rows + 1 }, (_, r) => (
                      <line key={`r${r}`} x1={grid.ox} y1={grid.oy + r * grid.pitch} x2={grid.ox + grid.cols * grid.pitch} y2={grid.oy + r * grid.pitch} vectorEffect="non-scaling-stroke" />
                    ))}
                  </g>
                )}
                {dets.map((d, i) => {
                  if (d.removed) return null
                  const g = drag && drag.kind !== 'new' && drag.spot === i && draft ? draft : cellsOf(d)
                  const r = at(g)
                  const c = colour(d)
                  const isSel = i === selected
                  return (
                    <g key={i} data-spot={i} className="cursor-move">
                      <rect x={r.x + 1} y={r.y + 1} width={r.w - 2} height={r.h - 2} fill={c.fill} stroke={isSel ? '#fde68a' : c.line} strokeWidth={isSel ? stroke * 2 : stroke} strokeDasharray={d.itemId ? undefined : `${stroke * 3} ${stroke * 2}`} />
                      <text x={r.x + 4} y={r.y + r.h - Math.max(4, grid.pitch * 0.07)} fontSize={Math.max(9, grid.pitch * 0.17)} fill="#fff" stroke="#000" strokeWidth={Math.max(2, grid.pitch * 0.04)} paintOrder="stroke" className="pointer-events-none select-none">
                        {d.itemId ? short(d.itemId) : '?'}
                      </text>
                    </g>
                  )
                })}
                {selGeom &&
                  CORNERS.map((k) => {
                    const r = at(selGeom)
                    const hx = k === 'nw' || k === 'sw' ? r.x : r.x + r.w
                    const hy = k === 'nw' || k === 'ne' ? r.y : r.y + r.h
                    const s = Math.max(8, grid.pitch * 0.16)
                    return <rect key={k} data-handle={k} x={hx - s / 2} y={hy - s / 2} width={s} height={s} fill="#fde68a" stroke="#000" strokeWidth={1} className={k === 'nw' || k === 'se' ? 'cursor-nwse-resize' : 'cursor-nesw-resize'} />
                  })}
                {draft && drag?.kind === 'new' && (() => {
                  const r = at(draft)
                  return <rect x={r.x + 1} y={r.y + 1} width={r.w - 2} height={r.h - 2} fill="rgba(56,189,248,0.18)" stroke="#38bdf8" strokeWidth={stroke} strokeDasharray={`${stroke * 3} ${stroke * 2}`} />
                })()}
              </svg>
            )}
          </div>
          </div>
        </div>

        <aside className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-l border-white/10 p-3 text-xs [scrollbar-width:thin]">
          {sel && !sel.removed && selGeom ? (
            <>
              <div>
                <div className="text-[10px] uppercase tracking-wide text-white/45">This box · {selGeom.w}×{selGeom.h} slots</div>
                <div className="mt-1 flex items-center gap-2">
                  {sel.itemId && ctx.items?.[sel.itemId]?.iconLink ? <img src={ctx.items[sel.itemId].iconLink!} alt="" className="h-9 w-9 rounded-sm bg-white/5 object-contain" /> : <span className="h-9 w-9 rounded-sm bg-white/5" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{sel.itemId ? ctx.items?.[sel.itemId]?.name ?? sel.itemId : 'No item yet'}</span>
                    {sel.fixed && <span className="text-[11px] text-sky-300">Fixed by you (remembered)</span>}
                  </span>
                </div>
              </div>
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wide text-white/45">Best matches for this box</div>
                {matches === null ? (
                  <p className="flex items-center gap-1.5 text-white/55">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Looking…
                  </p>
                ) : matches.length === 0 ? (
                  <p className="text-white/55">No item of this size looks like it. Search below.</p>
                ) : (
                  <ul className="space-y-0.5">
                    {matches.slice(0, 8).map((m) => (
                      <li key={m.itemId}>
                        <button type="button" onClick={() => assign(selected!, selGeom, m.itemId, matches, true)} className={`flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-white/10 ${m.itemId === sel.itemId ? 'bg-white/10' : ''}`}>
                          {ctx.items?.[m.itemId]?.iconLink ? <img src={ctx.items[m.itemId].iconLink!} alt="" className="h-6 w-6 object-contain" /> : <span className="h-6 w-6" />}
                          <span className="min-w-0 flex-1 truncate">{ctx.items?.[m.itemId]?.name ?? m.itemId}</span>
                          <span className="tabular-nums text-white/40">{m.error.toFixed(0)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <label className="flex items-center gap-1.5 rounded border border-white/15 bg-white/5 px-2 py-1">
                  <Search className="h-3.5 w-3.5 text-white/45" />
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Another item…" className="min-w-0 flex-1 bg-transparent text-white placeholder:text-white/40 focus:outline-none" />
                </label>
                {results.length > 0 && (
                  <ul className="mt-1 space-y-0.5">
                    {results.map((it) => (
                      <li key={it.id}>
                        <button type="button" onClick={() => assign(selected!, selGeom, it.id, matches ?? [], true)} className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-white/10">
                          {it.iconLink ? <img src={it.iconLink} alt="" className="h-6 w-6 object-contain" /> : <span className="h-6 w-6" />}
                          <span className="min-w-0 flex-1 truncate">{it.name}</span>
                          <span className="text-white/40">
                            {it.width}×{it.height}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <button type="button" onClick={() => remove(selected!)} className="flex items-center gap-1.5 self-start rounded border border-red-400/40 px-2 py-1 text-red-200 hover:bg-red-500/15">
                <Trash2 className="h-3.5 w-3.5" /> Remove this box
              </button>
            </>
          ) : (
            <div className="space-y-2 text-white/70">
              <p className="text-sm text-white">Fix the boxes once, and the scanner remembers.</p>
              <p>Click a box to pick the right item. Drag a box to move it, drag its corners to resize it (it snaps to the slots). Use “Draw new box” for an item that was missed, and Delete for a wrong box.</p>
              <p>
                <span className="text-emerald-300">Green</span> = sure, <span className="text-amber-300">amber</span> = likely, <span className="text-red-300">red</span> = check, <span className="text-sky-300">blue</span> = fixed by you.
              </p>
              <p className="text-white/50">If the grid lines do not sit on the slot borders, change the slot size first. Done keeps that size for your next snips.</p>
            </div>
          )}
          {note && <p className="rounded border border-sky-400/30 bg-sky-500/10 px-2 py-1.5 text-sky-200">{note}</p>}
        </aside>
      </div>
    </div>
  )
}
