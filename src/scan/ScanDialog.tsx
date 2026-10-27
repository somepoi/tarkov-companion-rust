import { useEffect, useMemo, useRef, useState } from 'react'
import { Camera, Check, Crop, Palette, FolderOpen, ImageUp, Loader2, Minus, Move, Plus, ScanSearch, Search, Trash2, X, Undo2 } from 'lucide-react'
import { useNeeds } from '../hooks/useNeeds'
import { remainingFor, type NeedSource } from '../lib/needs'
import { trackedItemAdvice } from '../lib/recommendationSafety'
import { formatDateTime } from '../lib/format'
import { isDesktop } from '../desktop/useDesktop'
import { useInventoryStore, useModeInventory } from '../store/inventory'
import { useProgressStore } from '../store/progress'
import type { Detection } from './core'
import { identifyBox, scanImage, warmUpScanner, type IdentifyMatch, type ScanResult } from './scanner'
import { cellAt, covers, moveBox, overlaps, resizeBox, sameCells, spanCells, type Cells, type Corner } from './boxEdit'
import { rememberCellSize, rememberedCellSize } from './cellSize'
import { learnedFingerprints, recordFromCorrection, recordFromSpot, useLearnedStore } from './learned'
import { LearnedPanel } from './LearnedPanel'
import { readWords, warmUpOcr } from './ocr'
import { imageFromClipboard, useScanStore } from './scanStore'
import { undoLastApply } from './undoApply'
import { prefs } from '../store/prefs'

interface Row {
  key: string
  itemId: string
  count: number
  selected: boolean
  /** Spots on the screenshot (indexes into result.detections). */
  spots: number[]
  /** Worst (highest) match error among the spots; one good match cannot hide a weak one. */
  error: number
  /** Other likely items, best first. */
  alternatives: string[]
  /** Smallest gap between the match and the runner-up (small = could easily be the other item). */
  margin: number
  /** Matched one of your saved corrections. */
  learned: boolean
  /** You picked this item yourself ("Wrong item?"). */
  manual?: boolean
  /** The printed name on screen matches (every spot of this row). */
  nameMatch: boolean
  /** A gun found by its printed name only: the box size is a guess. */
  byName?: boolean
}

type Box = { x: number; y: number; w: number; h: number }
/** A detection as the box editor sees it: boxes can be removed or moved/drawn by hand. */
type EditDet = Detection & { removed?: boolean; edited?: boolean }
type Drag =
  | { kind: 'move'; spot: number; start: { col: number; row: number }; orig: Cells }
  | { kind: 'resize'; spot: number; corner: Corner; orig: Cells }
  | { kind: 'new'; start: { col: number; row: number }; startPx: { x: number; y: number } }
const cellsOf = (d: Cells): Cells => ({ col: d.col, row: d.row, w: d.w, h: d.h })
const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se']

/** Takes spots out of their rows; rows left with no spots and no count disappear. */
function detachSpots(rs: Row[], spots: number[]): Row[] {
  return rs
    .map((r) => {
      const keep = r.spots.filter((x) => !spots.includes(x))
      return keep.length === r.spots.length ? r : { ...r, spots: keep, count: Math.max(0, r.count - (r.spots.length - keep.length)) }
    })
    .filter((r) => r.spots.length > 0 || r.count > 0)
}

/** Sure only when the match is close AND clearly better than the next item (BEAR vs USEC tags etc.). */
const confidence = (error: number, margin = Infinity, nameMatch = false) =>
  nameMatch ? (error < 20 ? 'sure' : 'likely') : error < 12 && margin >= 1.5 ? 'sure' : error < 18 ? 'likely' : 'check'
const marginOf = (d: Detection) => (d.alternatives.length ? d.alternatives[0].error - d.error : Infinity)
const REVIEW_FILL = 'rgba(251,191,36,0.20)'

function sourceLabel(s: NeedSource): string {
  if (s.kind === 'quest') return `${s.name} (${s.traderName})`
  if (s.kind === 'hideout') return /level/i.test(s.name) ? s.name : `${s.name} level ${s.level}`
  return `craft: ${s.name}`
}
const CONF_STYLE = {
  sure: { label: 'Sure', cls: 'border-success/50 text-success', stroke: '#4ade80' },
  likely: { label: 'Likely', cls: 'border-accent/60 text-accent', stroke: '#fbbf24' },
  check: { label: 'Check', cls: 'border-danger/60 text-danger', stroke: '#f87171' },
} as const

function buildRows(result: ScanResult): Row[] {
  const byItem = new Map<string, Row>()
  result.detections.forEach((d: Detection, i) => {
    const row = byItem.get(d.itemId)
    if (row) {
      row.count += 1
      row.spots.push(i)
      row.error = Math.max(row.error, d.error)
      row.margin = Math.min(row.margin, marginOf(d))
      row.learned = row.learned || Boolean(d.learned)
      row.nameMatch = row.nameMatch && Boolean(d.nameMatch)
      row.byName = row.byName || Boolean(d.byName)
      for (const a of d.alternatives) if (!row.alternatives.includes(a.itemId)) row.alternatives.push(a.itemId)
    } else {
      byItem.set(d.itemId, { key: d.itemId, itemId: d.itemId, count: 1, selected: true, spots: [i], error: d.error, alternatives: d.alternatives.map((a) => a.itemId), margin: marginOf(d), learned: Boolean(d.learned), nameMatch: Boolean(d.nameMatch), byName: d.byName })
    }
  })
  return [...byItem.values()]
}

/**
 * Stash scanner: take or paste a screenshot of a stash/container, see what was
 * recognised, fix counts or items, then add them to Item Collection.
 */
export function ScanDialog() {
  const open = useScanStore((s) => s.open)
  const image = useScanStore((s) => s.image)
  const nonce = useScanStore((s) => s.nonce)
  const openWith = useScanStore((s) => s.openWith)
  const close = useScanStore((s) => s.close)
  const { needs, coverage, items: itemsQuery } = useNeeds()
  const [tint, setTint] = useState(() => prefs().scanTint)
  const items = itemsQuery.data?.items
  const inventory = useModeInventory()
  const gameMode = useProgressStore((s) => s.gameMode)
  const setCollected = useInventoryStore((s) => s.setCollected)

  const [url, setUrl] = useState<string | null>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [crop, setCrop] = useState<Box | null>(null)
  const [cropping, setCropping] = useState(false)
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null)
  const [status, setStatus] = useState<'idle' | 'scanning' | 'done' | 'error'>('idle')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ScanResult | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [hover, setHover] = useState<string | null>(null)
  const [mode, setMode] = useState<'add' | 'set'>(() => (prefs().scanApplyMode === 'replace' ? 'set' : 'add'))
  const [applied, setApplied] = useState<string | null>(null)
  // One Apply per screenshot (re-scans and selections of it included), so counts are never added twice;
  // a ref as well as state so a fast double-click cannot get through before the re-render.
  const appliedRef = useRef(false)
  const scanLifecycle = useRef({ active: true, generation: 0 })
  useEffect(() => {
    const lifecycle = scanLifecycle.current
    lifecycle.active = true
    return () => { lifecycle.active = false; lifecycle.generation++ }
  }, [])
  const [shots, setShots] = useState<{ name: string; modified: number }[]>([])
  const [changing, setChanging] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [learnNote, setLearnNote] = useState<string | null>(null)
  const [phase, setPhase] = useState('Scanning…')
  const [namesRead, setNamesRead] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  // Box editor: detections as they stand after the user's edits (indexes = row spots).
  const [dets, setDets] = useState<EditDet[]>([])
  const [editMode, setEditMode] = useState(false)
  /** Move/resize existing boxes, or draw new ones (also over existing boxes, which a full stash needs). */
  const [editTool, setEditTool] = useState<'move' | 'draw'>('move')
  const [selected, setSelected] = useState<number | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [draft, setDraft] = useState<Cells | null>(null)
  const [boxMatches, setBoxMatches] = useState<IdentifyMatch[] | null>(null)
  const [boxSearch, setBoxSearch] = useState('')
  const [boxNote, setBoxNote] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  // Item id (including accepted alternatives) -> the need it counts toward.
  const needFor = useMemo(() => {
    const m = new Map<string, { needId: string; remaining: number; total: number; sources: NeedSource[] }>()
    for (const n of needs.values()) {
      const entry = { needId: n.itemId, remaining: remainingFor(n, inventory.collected[n.itemId] ?? 0), total: n.total, sources: n.sources }
      m.set(n.itemId, entry)
      for (const alt of n.alternatives) if (!m.has(alt)) m.set(alt, entry)
    }
    return m
  }, [needs, inventory.collected])

  useEffect(() => {
    if (!open) return
    void warmUpScanner().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
    warmUpOcr()
    if (isDesktop()) void window.desktop?.listGameScreenshots().then(setShots)
    const onPaste = (e: ClipboardEvent) => {
      const img = imageFromClipboard(e)
      if (img) openWith(img)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [open, openWith])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.closest?.('input, textarea')
      if (editMode && !typing && selected !== null && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault()
        deleteBox(selected)
        return
      }
      if (e.key !== 'Escape') return
      if (editMode) {
        if (selected !== null) setSelected(null)
        else setEditMode(false)
        return
      }
      if (!changing) close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // New image: show it and scan the whole picture.
  useEffect(() => {
    if (!open || !image) return
    const u = URL.createObjectURL(image)
    setUrl(u)
    setCrop(null)
    setApplied(null)
    setUndoNote(null)
    appliedRef.current = false
    setLearnNote(null)
    const probe = new Image()
    probe.onload = () => setSize({ w: probe.naturalWidth, h: probe.naturalHeight })
    probe.src = u
    void runScan(image, null)
    return () => URL.revokeObjectURL(u)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, open])

  // Default selection: items that count toward something you still need.
  useEffect(() => {
    // Uncertain matches stay unticked so a wrong guess cannot slip into Item Collection.
    // Settings → Scanner: tick needed items unless uncertain (default), only sure ones, or none.
    const ticking = prefs().scanTicking
    setRows((rs) =>
      rs.map((r) => {
        const conf = confidence(r.error, r.margin, r.nameMatch)
        const needed = (needFor.get(r.itemId)?.remaining ?? 0) > 0
        return { ...r, selected: ticking === 'none' ? false : ticking === 'sure' ? needed && conf === 'sure' : needed && conf !== 'check' }
      }),
    )
    // Only when a new result arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result])

  async function runScan(img: Blob, box: Box | null) {
    const lifecycle = scanLifecycle.current
    const generation = ++lifecycle.generation
    const current = () => lifecycle.active && generation === lifecycle.generation
    setStatus('scanning')
    setProgress(0)
    setError(null)
    try {
      await useLearnedStore.getState().load()
      if (!current()) return
      // Read the printed item names first (a few seconds); scanning without them still works.
      setPhase('Reading item names…')
      const words = await readWords(img, box).catch(() => undefined)
      if (!current()) return
      setPhase('Matching items…')
      // A selection inside an already-scanned screenshot keeps its known cell size.
      const knownPitch = box && result ? result.grid.pitch : undefined
      const r = await scanImage(img, box, (progress) => { if (current()) setProgress(progress) }, learnedFingerprints(useLearnedStore.getState().records), knownPitch, words, rememberedCellSize())
      if (!current()) return
      const sure = r.detections.filter((d) => confidence(d.error, marginOf(d), Boolean(d.nameMatch)) === 'sure').length
      rememberCellSize(r.grid.pitch, sure, r.detections.length)
      setNamesRead(words ? words.length : null)
      setResult(r)
      setDets(r.detections)
      setEditMode(false)
      setSelected(null)
      setBoxMatches(null)
      setBoxNote(null)
      setRows(buildRows(r))
      setStatus('done')
    } catch (e) {
      if (!current()) return
      setError(e instanceof Error ? e.message : String(e))
      setStatus('error')
    }
  }

  const loadBytes = (bytes: Uint8Array, type = 'image/png') => openWith(new Blob([bytes as BlobPart], { type }))

  const toImage = (e: React.PointerEvent) => {
    const svg = svgRef.current
    if (!svg || !size) return { x: 0, y: 0 }
    const r = svg.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * size.w, y: ((e.clientY - r.top) / r.height) * size.h }
  }

  const updateRow = (key: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  /** Saves the corrected spots of the screenshot as references for this item (up to three per fix). */
  const rememberCorrection = async (spots: number[], itemId: string) => {
    const item = items?.[itemId]
    if (!result || !image || !item) return
    let saved = 0
    for (const spot of spots.slice(0, 3)) {
      const det = dets[spot]
      if (!det || det.removed) continue
      const rec = await recordFromCorrection(image, result.grid, det, { width: item.width, height: item.height }, itemId).catch(() => null)
      if (rec) {
        await useLearnedStore.getState().add(rec)
        saved++
      }
      // The failed attempt teaches too: this exact look is NOT what the scanner guessed.
      if (det.itemId !== itemId) {
        const not = await recordFromSpot(image, result.grid, det, det.w, det.h, det.itemId, 'not').catch(() => null)
        if (not) await useLearnedStore.getState().add(not)
      }
    }
    setLearnNote(saved ? `Remembered: ${item.shortName} will be recognised from this picture next time (Your corrections).` : null)
  }

  const replaceItem = (key: string, itemId: string) => {
    const corrected = rows.find((r) => r.key === key)
    if (corrected && corrected.itemId !== itemId) void rememberCorrection(corrected.spots, itemId)
    setRows((rs) => {
      const row = rs.find((r) => r.key === key)
      if (!row) return rs
      const existing = rs.find((r) => r.itemId === itemId && r.key !== key)
      if (existing) return rs.filter((r) => r.key !== key).map((r) => (r === existing ? { ...r, count: r.count + row.count, spots: [...r.spots, ...row.spots] } : r))
      return rs.map((r) => (r.key === key ? { ...r, itemId, manual: true, error: 0, margin: Infinity, selected: (needFor.get(itemId)?.remaining ?? 0) > 0 } : r))
    })
    setChanging(null)
    setSearch('')
  }

  /** Uncertain matches you kept (not changed, still ticked) are confirmed: remember them as successes. */
  const rememberConfirmations = async () => {
    if (!result || !image) return
    for (const r of rows) {
      if (!r.selected || r.manual || confidence(r.error, r.margin, r.nameMatch) === 'sure') continue
      for (const spot of r.spots.slice(0, 2)) {
        const det = dets[spot]
        if (!det || det.removed || det.edited || det.itemId !== r.itemId) continue
        const rec = await recordFromSpot(image, result.grid, det, det.w, det.h, r.itemId, 'confirmed').catch(() => null)
        if (rec) {
          await useLearnedStore.getState().add(rec)
          // Undo also forgets these.
          useScanStore.getState().addLearnedId(rec.id)
        }
      }
    }
  }

  const apply = () => {
    if (appliedRef.current) return
    if (rows.some((r) => r.selected && (!Number.isSafeInteger(r.count) || r.count < 0))) {
      setError('Check the amounts: Item Collection accepts whole items only. Stack quantities must be verified manually.')
      return
    }
    appliedRef.current = true
    let n = 0
    const totals = new Map<string, number>()
    for (const r of rows) {
      if (!r.selected || r.count <= 0) continue
      const target = needFor.get(r.itemId)?.needId ?? r.itemId
      totals.set(target, (totals.get(target) ?? 0) + r.count)
    }
    // Remember the counts before changing them, so the apply can be undone.
    const previous: Record<string, number> = {}
    for (const id of totals.keys()) previous[id] = inventory.collected[id] ?? 0
    for (const [id, count] of totals) {
      const current = inventory.collected[id] ?? 0
      setCollected(gameMode, id, mode === 'add' ? current + count : count)
      n += count
    }
    const summary = `${mode === 'add' ? 'Added' : 'Set'} ${n} item${n === 1 ? '' : 's'} across ${totals.size} kind${totals.size === 1 ? '' : 's'} in Item Collection.`
    useScanStore.getState().setLastApply({ mode: gameMode, previous, learnedIds: [], summary })
    void rememberConfirmations()
    setApplied(summary)
  }

  const lastApply = useScanStore((s) => s.lastApply)
  const [undoNote, setUndoNote] = useState<string | null>(null)
  const undoApply = async () => {
    if (!(await undoLastApply())) return
    // The same screenshot may be applied again (e.g. after fixing a wrong item).
    appliedRef.current = false
    setApplied(null)
    setUndoNote('Undone: Item Collection is back to how it was before the apply.')
  }

  /** Puts one box (spot) under an item: updates the box and moves it between rows. */
  const assignBox = (spot: number, geom: Cells, itemId: string, matches: IdentifyMatch[], learn: boolean) => {
    const m0 = matches.find((m) => m.itemId === itemId)
    const others = matches.filter((m) => m.itemId !== itemId)
    setDets((ds) => ds.map((d, i) => (i === spot ? { ...d, ...geom, itemId, error: m0?.error ?? 0, rotated: m0?.rotated ?? false, nameMatch: m0?.nameMatch || undefined, alternatives: others.map((m) => ({ itemId: m.itemId, error: m.error })) } : d)))
    setRows((rs) => {
      const next = detachSpots(rs, [spot])
      const existing = next.find((r) => r.itemId === itemId)
      if (existing) return next.map((r) => (r === existing ? { ...r, spots: [...r.spots, spot], count: r.count + 1 } : r))
      return [...next, { key: `${itemId}@${spot}`, itemId, count: 1, selected: (needFor.get(itemId)?.remaining ?? 0) > 0, spots: [spot], error: m0?.error ?? 0, alternatives: others.map((m) => m.itemId), margin: m0 && others[0] ? others[0].error - m0.error : Infinity, learned: false, manual: true, nameMatch: Boolean(m0?.nameMatch) }]
    })
    setBoxNote(null)
    if (learn && image && result) {
      // A hand-placed box with a hand-picked item is the best teacher there is.
      const det: Detection = { itemId, ...geom, rotated: false, error: 0, alternatives: [] }
      void recordFromSpot(image, result.grid, det, geom.w, geom.h, itemId, 'correct')
        .then((rec) => rec && useLearnedStore.getState().add(rec))
        .then(() => setLearnNote(`Remembered: ${items?.[itemId]?.shortName ?? 'this item'} at this size and look (Your corrections).`))
        .catch(() => undefined)
    }
  }

  const loadMatches = (geom: Cells) => {
    setBoxMatches(null)
    void identifyBox(geom).then(setBoxMatches).catch(() => setBoxMatches([]))
  }

  /** Applies a moved, resized or newly drawn box: boxes it fully covers go, then it is identified again. */
  const commitEdit = async (spot: number | null, geom: Cells) => {
    if (!result) return
    const idx = spot ?? dets.length
    const prev = spot !== null ? dets[spot] : null
    const swallowed = dets.map((d, i) => (i !== idx && !d.removed && covers(geom, d) ? i : -1)).filter((i) => i >= 0)
    setDets((ds) => {
      const next = ds.map((d, i) => (swallowed.includes(i) ? { ...d, removed: true } : d))
      if (spot === null) next.push({ itemId: '', ...geom, rotated: false, error: 99, alternatives: [], edited: true })
      else next[spot] = { ...next[spot], ...geom, edited: true }
      return next
    })
    if (swallowed.length) setRows((rs) => detachSpots(rs, swallowed))
    setSelected(idx)
    setBoxSearch('')
    setBoxMatches(null)
    const matches = await identifyBox(geom).catch(() => [] as IdentifyMatch[])
    setBoxMatches(matches)
    // Keep the item when the box only moved and it still fits there; otherwise take the best match.
    const keep = prev?.itemId && matches.slice(0, 3).some((m) => m.itemId === prev.itemId) ? prev.itemId : matches[0]?.itemId
    if (keep) assignBox(idx, geom, keep, matches, false)
    else {
      setRows((rs) => detachSpots(rs, [idx]))
      setDets((ds) => ds.map((d, i) => (i === idx ? { ...d, itemId: '' } : d)))
      setBoxNote(`No item is ${geom.w}×${geom.h} cells. Resize the box, or search for the item.`)
    }
  }

  const deleteBox = (spot: number) => {
    setDets((ds) => ds.map((d, i) => (i === spot ? { ...d, removed: true } : d)))
    setRows((rs) => detachSpots(rs, [spot]))
    setSelected(null)
    setBoxMatches(null)
  }

  const onEditPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!result) return
    const p = toImage(e)
    const cell = cellAt(result.grid, p.x, p.y)
    const target = e.target as Element
    const handle = target.closest('[data-handle]') as SVGElement | null
    const box = target.closest('[data-spot]') as SVGElement | null
    if (editTool === 'draw') {
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
        setBoxSearch('')
        setBoxNote(null)
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
      // pointer already released (e.g. a very quick tap)
    }
  }

  const onEditPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drag || !result) return
    const p = toImage(e)
    const cell = cellAt(result.grid, p.x, p.y)
    if (drag.kind === 'move') setDraft(moveBox(drag.orig, drag.start, cell, result.grid))
    else if (drag.kind === 'resize') setDraft(resizeBox(drag.orig, drag.corner, cell))
    else setDraft(spanCells(drag.start, cell))
  }

  const onEditPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag
    const geom = draft
    setDrag(null)
    setDraft(null)
    if (!d || !geom) return
    if (d.kind === 'new') {
      // A plain click on an empty spot only deselects; a drag (even inside one cell) draws a box.
      const p = toImage(e)
      if (Math.hypot(p.x - d.startPx.x, p.y - d.startPx.y) < 6) return
      void commitEdit(null, geom)
    } else if (!sameCells(geom, d.orig)) {
      void commitEdit(d.spot, geom)
    }
  }

  const boxResults = useMemo(() => {
    const q = boxSearch.trim().toLowerCase()
    if (!items || q.length < 2) return []
    return Object.values(items)
      .filter((i) => i.name.toLowerCase().includes(q) || i.shortName.toLowerCase().includes(q))
      .slice(0, 8)
  }, [items, boxSearch])

  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!items || q.length < 2) return []
    return Object.values(items)
      .filter((i) => i.name.toLowerCase().includes(q) || i.shortName.toLowerCase().includes(q))
      .slice(0, 8)
  }, [items, search])

  if (!open) return null
  const selectedCount = rows.filter((r) => r.selected).reduce((n, r) => n + r.count, 0)
  const name = (id: string) => items?.[id]?.name ?? '…'
  const hoveredSpots = new Set(rows.find((r) => r.key === hover)?.spots ?? [])

  return (
    <div className="fixed inset-0 z-[75] flex bg-black/80 p-1 sm:p-3" onDragOver={(e) => e.preventDefault()} onDrop={(e) => {
      e.preventDefault()
      const f = Array.from(e.dataTransfer.files).find((x) => x.type.startsWith('image/'))
      if (f) openWith(f)
    }}>
      <div role="dialog" aria-modal="true" aria-labelledby="scan-title" className="flex min-h-0 w-full flex-col rounded-lg border border-line bg-surface-2 shadow-xl">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
          <ScanSearch className="h-5 w-5 text-accent" />
          <h2 id="scan-title" className="text-base font-semibold">Scan stash screenshot</h2>
          <span className="text-xs text-ink-muted">Paste (Ctrl+V), drop an image, or pick one.{isDesktop() ? ' In game, press the scan hotkey (Settings) to capture straight from the game.' : ''}</span>
          <button type="button" onClick={close} aria-label="Close" className="ml-auto rounded p-1 text-ink-dim hover:bg-surface-3 hover:text-ink"><X className="h-5 w-5" /></button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row md:overflow-hidden">
          {/* Screenshot */}
          <div className="flex min-w-0 flex-col border-b border-line md:min-h-0 md:flex-1 md:border-b-0 md:border-r">
            <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-1.5 text-xs">
              <button type="button" onClick={() => fileInput.current?.click()} className="btn !py-1"><ImageUp className="h-4 w-4" /> Open image</button>
              <input ref={fileInput} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) openWith(f); e.target.value = '' }} />
              {isDesktop() && (
                <button type="button" onClick={() => void window.desktop?.captureScreen().then((b) => loadBytes(b))} className="btn !py-1" title="Captures the screen under the mouse. To capture the game, use the scan hotkey while playing.">
                  <Camera className="h-4 w-4" /> Capture screen
                </button>
              )}
              {url && (
                <button type="button" onClick={() => { setCropping((v) => !v); setDragStart(null) }} className={`btn !py-1 ${cropping ? 'border-accent text-accent' : ''}`} title="Drag a box around one stash or container, then scan only that part">
                  <Crop className="h-4 w-4" /> {cropping ? 'Drag a box…' : 'Select area'}
                </button>
              )}
              {crop && image && (
                <>
                  <button type="button" onClick={() => void runScan(image, crop)} className="btn !py-1 border-accent text-accent"><ScanSearch className="h-4 w-4" /> Scan selection</button>
                  <button type="button" onClick={() => { setCrop(null); if (image) void runScan(image, null) }} className="btn !py-1">Whole image</button>
                </>
              )}
              {status === 'scanning' && <span className="flex items-center gap-1.5 text-ink-muted"><Loader2 className="h-4 w-4 animate-spin" /> {phase} {phase === 'Matching items…' ? `${Math.round(progress * 100)}%` : ''}</span>}
              {result && (
                <button type="button" onClick={() => setTint((v) => !v)} className={`btn !py-1 ${tint ? 'border-accent text-accent' : ''}`} title="Highlight detected regions to review; no sale recommendation is made">
                  <Palette className="h-4 w-4" /> Review tint
                </button>
              )}
              {result && status === 'done' && (
                <button type="button" onClick={() => { setEditMode((v) => !v); setCropping(false); setSelected(null); setBoxNote(null) }} className={`btn !py-1 ${editMode ? 'border-accent bg-accent/15 text-accent' : ''}`} title="Move, resize, add or delete boxes; they snap to the stash grid">
                  <Move className="h-4 w-4" /> {editMode ? 'Done editing' : 'Edit boxes'}
                </button>
              )}
              {status === 'done' && result && <span className="text-ink-dim">{dets.filter((d) => !d.removed).length} items · cell {result.grid.pitch.toFixed(0)} px{namesRead === null ? ' · names not read' : ''}</span>}
            </div>
            {editMode && (
              <div className="flex flex-wrap items-center gap-2 border-b border-line bg-accent/5 px-3 py-1.5 text-xs">
                <span className="flex items-center gap-0.5 rounded border border-line bg-surface-2 p-0.5">
                  <button type="button" onClick={() => setEditTool('move')} aria-pressed={editTool === 'move'} className={`rounded px-2 py-0.5 ${editTool === 'move' ? 'bg-accent text-surface' : 'text-ink-muted hover:text-ink'}`}>Move / resize</button>
                  <button type="button" onClick={() => { setEditTool('draw'); setSelected(null) }} aria-pressed={editTool === 'draw'} className={`rounded px-2 py-0.5 ${editTool === 'draw' ? 'bg-accent text-surface' : 'text-ink-muted hover:text-ink'}`}>Draw new box</button>
                </span>
                {selected === null || !dets[selected] || dets[selected].removed ? (
                  <span className="text-ink-muted">{editTool === 'draw' ? 'Drag across the slots the item really covers. Boxes inside the new one are replaced.' : 'Click a box to pick it, drag it to move, drag a yellow corner to resize.'} Boxes snap to the grid; <b>Delete</b> removes the picked box.</span>
                ) : (
                  (() => {
                    const d = dets[selected]
                    const it = d.itemId ? items?.[d.itemId] : undefined
                    const geom = cellsOf(d)
                    const overlapping = dets.filter((o, i) => i !== selected && !o.removed && overlaps(geom, o)).length
                    return (
                      <>
                        <span className="font-medium text-ink">Box {d.w}×{d.h}:</span>
                        {it ? (
                          <span className="flex items-center gap-1 rounded border border-accent/60 bg-surface px-1.5 py-0.5 text-ink">{it.iconLink && <img src={it.iconLink} alt="" className="h-5 w-5 object-contain" />}{it.shortName}</span>
                        ) : (
                          <span className="text-danger">no item</span>
                        )}
                        <span className="text-ink-dim">or</span>
                        {boxMatches === null ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-ink-dim" />
                        ) : (
                          boxMatches.filter((m) => m.itemId !== d.itemId).slice(0, 5).map((m) => (
                            <button key={m.itemId} type="button" onClick={() => assignBox(selected, geom, m.itemId, boxMatches, true)} className="flex items-center gap-1 rounded border border-line bg-surface px-1.5 py-0.5 hover:border-accent" title={items?.[m.itemId]?.name}>
                              {items?.[m.itemId]?.iconLink && <img src={items[m.itemId].iconLink ?? ''} alt="" className="h-5 w-5 object-contain" />}
                              {items?.[m.itemId]?.shortName ?? m.itemId.slice(-6)}
                            </button>
                          ))
                        )}
                        <span className="relative">
                          <Search className="pointer-events-none absolute left-1.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-dim" />
                          <input type="search" value={boxSearch} onChange={(e) => setBoxSearch(e.target.value)} placeholder="Other item…" className="w-36 rounded border border-line bg-surface py-0.5 pl-6 pr-1" />
                          {boxResults.length > 0 && (
                            <ul className="absolute left-0 top-full z-10 mt-1 w-64 rounded border border-line bg-surface-2 p-1 shadow-lg">
                              {boxResults.map((i) => (
                                <li key={i.id}><button type="button" onClick={() => { assignBox(selected, geom, i.id, boxMatches ?? [], true); setBoxSearch('') }} className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-surface-3">{i.iconLink && <img src={i.iconLink} alt="" className="h-5 w-5 object-contain" />}<span className="truncate">{i.name}</span></button></li>
                              ))}
                            </ul>
                          )}
                        </span>
                        {overlapping > 0 && <span className="text-danger">Overlaps {overlapping} other box{overlapping === 1 ? '' : 'es'}: move or delete {overlapping === 1 ? 'it' : 'them'}.</span>}
                        <button type="button" onClick={() => deleteBox(selected)} className="ml-auto inline-flex items-center gap-1 text-ink-dim hover:text-danger"><Trash2 className="h-3.5 w-3.5" /> Delete box</button>
                      </>
                    )
                  })()
                )}
                {boxNote && <span className="w-full text-info">{boxNote}</span>}
              </div>
            )}
            <div className="p-2 md:min-h-0 md:flex-1 md:overflow-auto">
              {!url ? (
                <div className="flex h-full min-h-64 flex-col items-center justify-center gap-3 rounded border-2 border-dashed border-line text-center text-sm text-ink-muted">
                  <ImageUp className="h-10 w-10 text-ink-dim" />
                  <p>Paste a screenshot with <b>Ctrl+V</b> or drop an image here.</p>
                  <p className="max-w-md text-xs text-ink-dim">Works best with one stash, box or container open, items not hovered. Windows: Win+Shift+S copies a selection to the clipboard.</p>
                  {shots.length > 0 && (
                    <div className="mt-2 w-full max-w-md text-left">
                      <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-muted"><FolderOpen className="h-3.5 w-3.5" /> Recent game screenshots</div>
                      <ul className="space-y-0.5 text-xs">
                        {shots.slice(0, 6).map((s) => (
                          <li key={s.name}><button type="button" onClick={() => void window.desktop?.readGameScreenshot(s.name).then((b) => loadBytes(b))} className="w-full truncate rounded px-2 py-1 text-left hover:bg-surface-3">{s.name} <span className="text-ink-dim">· {formatDateTime(s.modified)}</span></button></li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ) : (
                <div className="relative inline-block max-w-full">
                  <img src={url} alt="Screenshot to scan" className="block max-h-[60vh] max-w-full select-none md:max-h-[calc(100vh-11rem)]" draggable={false} />
                  {size && (
                    <svg
                      ref={svgRef}
                      viewBox={`0 0 ${size.w} ${size.h}`}
                      className={`absolute inset-0 h-full w-full touch-none ${cropping || editMode ? 'cursor-crosshair' : ''}`}
                      onPointerDown={(e) => { if (editMode && !cropping) { onEditPointerDown(e); return } if (!cropping) return; const p = toImage(e); setDragStart(p); setCrop({ x: p.x, y: p.y, w: 0, h: 0 }); (e.target as Element).setPointerCapture?.(e.pointerId) }}
                      onPointerMove={(e) => { if (editMode && !cropping) { onEditPointerMove(e); return } if (!cropping || !dragStart) return; const p = toImage(e); setCrop({ x: Math.min(p.x, dragStart.x), y: Math.min(p.y, dragStart.y), w: Math.abs(p.x - dragStart.x), h: Math.abs(p.y - dragStart.y) }) }}
                      onPointerUp={(e) => { if (editMode && !cropping) { onEditPointerUp(e); return } if (!cropping) return; setDragStart(null); setCropping(false); setCrop((c) => (c && c.w > 20 && c.h > 20 ? { x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.w), h: Math.round(c.h) } : null)) }}
                    >
                      {editMode && result && (
                        <g stroke="rgba(255,255,255,0.35)" strokeWidth={1} pointerEvents="none">
                          {Array.from({ length: result.grid.cols + 1 }, (_, c) => (
                            <line key={`c${c}`} x1={result.grid.ox + c * result.grid.pitch} x2={result.grid.ox + c * result.grid.pitch} y1={result.grid.oy} y2={result.grid.oy + result.grid.rows * result.grid.pitch} />
                          ))}
                          {Array.from({ length: result.grid.rows + 1 }, (_, r) => (
                            <line key={`r${r}`} y1={result.grid.oy + r * result.grid.pitch} y2={result.grid.oy + r * result.grid.pitch} x1={result.grid.ox} x2={result.grid.ox + result.grid.cols * result.grid.pitch} />
                          ))}
                        </g>
                      )}
                      {result && dets.map((d, i) => {
                        if (d.removed || (drag && drag.kind !== 'new' && drag.spot === i)) return null
                        const conf = CONF_STYLE[confidence(d.error, marginOf(d), Boolean(d.nameMatch))]
                        const x = result.grid.ox + d.col * result.grid.pitch
                        const y = result.grid.oy + d.row * result.grid.pitch
                        const row = rows.find((r) => r.spots.includes(i))
                        const off = row && !row.selected
                        return (
                          <rect key={i} data-spot={i} x={x + 2} y={y + 2} width={d.w * result.grid.pitch - 4} height={d.h * result.grid.pitch - 4} className={editMode ? 'cursor-move' : undefined} fill={hoveredSpots.has(i) ? 'rgba(255,255,255,0.18)' : tint ? REVIEW_FILL : editMode ? 'rgba(0,0,0,0.01)' : 'none'} stroke={selected === i && editMode ? '#fbbf24' : !d.itemId ? '#f87171' : off ? '#888' : conf.stroke} strokeWidth={selected === i && editMode ? 6 : hoveredSpots.has(i) ? 5 : tint ? 2 : 3} strokeDasharray={off ? '6 4' : undefined} onMouseEnter={() => row && setHover(row.key)} onMouseLeave={() => setHover(null)}>
                            <title>{d.itemId ? `${name(row?.itemId ?? d.itemId)} · review identity, quantity and FIR` : 'Unknown item — review'}</title>
                          </rect>
                        )
                      })}
                      {editMode && result && selected !== null && dets[selected] && !dets[selected].removed && !drag && (() => {
                        const d = dets[selected]
                        const g = result.grid
                        const hs = Math.max(10, g.pitch * 0.2)
                        return CORNERS.map((c) => {
                          const cx = g.ox + (c.endsWith('w') ? d.col : d.col + d.w) * g.pitch
                          const cy = g.oy + (c.startsWith('n') ? d.row : d.row + d.h) * g.pitch
                          return <rect key={c} data-handle={c} x={cx - hs / 2} y={cy - hs / 2} width={hs} height={hs} fill="#fbbf24" stroke="#0c0c0b" strokeWidth={2} className={c === 'nw' || c === 'se' ? 'cursor-nwse-resize' : 'cursor-nesw-resize'} />
                        })
                      })()}
                      {editMode && result && draft && (
                        <rect x={result.grid.ox + draft.col * result.grid.pitch + 2} y={result.grid.oy + draft.row * result.grid.pitch + 2} width={draft.w * result.grid.pitch - 4} height={draft.h * result.grid.pitch - 4} fill="rgba(251,191,36,0.15)" stroke="#fbbf24" strokeWidth={4} strokeDasharray="10 6" pointerEvents="none" />
                      )}
                      {crop && <rect x={crop.x} y={crop.y} width={crop.w} height={crop.h} fill="rgba(251,191,36,0.08)" stroke="#fbbf24" strokeWidth={3} strokeDasharray="10 6" />}
                    </svg>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Results */}
          <div className="flex w-full flex-col md:min-h-0 md:w-[400px] md:shrink-0">
            {error && <p className="m-3 rounded border border-danger/50 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}
            <p className="border-b border-line px-3 py-2 text-xs text-ink-muted">Counts start at one per detected box. Verify stack amounts manually. FIR is unknown; this scan updates a checklist and cannot establish saleable surplus.</p>
            <div className="md:min-h-0 md:flex-1 md:overflow-y-auto">
              {rows.length === 0 && status !== 'scanning' && <p className="p-4 text-sm text-ink-muted">{status === 'done' ? 'No items recognised. Try "Select area" around a single stash grid.' : 'Detected items appear here.'}</p>}
              <ul className="divide-y divide-line">
                {[...rows].sort((a, b) => Number(b.selected) - Number(a.selected) || a.error - b.error).map((r) => {
                  const item = items?.[r.itemId]
                  const need = needFor.get(r.itemId)
                  const conf = CONF_STYLE[confidence(r.error, r.margin, r.nameMatch)]
                  const advice = trackedItemAdvice(needs.get(need?.needId ?? r.itemId), coverage,
                    !r.manual && (r.byName || confidence(r.error, r.margin, r.nameMatch) !== 'sure')
                      ? 'Verify uncertain item identity, stack quantity and FIR before using these counts.'
                      : 'Verify quantity and FIR in the game. Recognized boxes are not confirmed physical stock or saleable surplus.')
                  return (
                    <li key={r.key} className={`px-3 py-2 ${hover === r.key ? 'bg-surface-3' : ''}`} onMouseEnter={() => setHover(r.key)} onMouseLeave={() => setHover(null)}>
                      <div className="flex items-center gap-2">
                        <input type="checkbox" checked={r.selected} onChange={(e) => updateRow(r.key, { selected: e.target.checked })} aria-label={`Apply ${item?.name ?? ''}`} className="h-4 w-4 shrink-0" />
                        {item?.iconLink ? <img src={item.iconLink} alt="" className="h-9 w-9 shrink-0 rounded border border-line object-contain" /> : <span className="h-9 w-9 shrink-0 rounded border border-line" />}
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium" title={item?.name}>{item?.name ?? (itemsQuery.isPending ? 'Loading item names…' : r.itemId)}</div>
                          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                            <span className={`rounded border px-1 ${conf.cls}`}>{r.manual ? 'Chosen' : conf.label}</span>
                            {r.learned && <span className="rounded border border-info/50 px-1 text-info" title="Matched one of your saved corrections">Learned</span>}
                            {r.byName && <span className="rounded border border-info/50 px-1 text-info" title="A modded gun: no picture looks like it, but its name was read. The box size is a guess; fix it with Edit boxes if it covers other items.">Found by name</span>}
                            {need ? (
                              <span className="text-ink-muted">{need.remaining > 0 ? `${need.remaining} more in checklist` : 'No additional tracked need'}</span>
                            ) : (
                              <span className="text-ink-muted">No additional tracked need</span>
                            )}
                            <span className="text-accent">verify amount · FIR unknown</span>
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px]">
                            <span className="rounded border border-line bg-surface-3 px-1 font-semibold text-ink-muted" title={advice.detail}>{advice.label}</span>
                            {need && need.sources[0] && <span className="truncate text-ink-muted" title={need.sources.map(sourceLabel).join('\n')}>tracked: {sourceLabel(need.sources[0])}{need.sources.length > 1 ? ` +${need.sources.length - 1} more` : ''}</span>}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center">
                          <button type="button" onClick={() => updateRow(r.key, { count: Math.max(0, r.count - 1) })} aria-label="One less" className="rounded p-1 text-ink-dim hover:bg-surface-3 hover:text-ink"><Minus className="h-3.5 w-3.5" /></button>
                          <input type="number" min={0} step={1} value={r.count} onChange={(e) => updateRow(r.key, { count: Math.max(0, e.target.valueAsNumber || 0) })} aria-label="Amount (verify stack quantities manually)" className="w-14 rounded border border-line bg-surface px-1 py-0.5 text-center text-sm" />
                          <button type="button" onClick={() => updateRow(r.key, { count: r.count + 1 })} aria-label="One more" className="rounded p-1 text-ink-dim hover:bg-surface-3 hover:text-ink"><Plus className="h-3.5 w-3.5" /></button>
                        </div>
                      </div>
                      <div className="mt-1 flex gap-3 pl-6 text-[11px]">
                        <button type="button" onClick={() => { setChanging(changing === r.key ? null : r.key); setSearch('') }} className="text-accent underline">Wrong item?</button>
                        <button type="button" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} className="inline-flex items-center gap-0.5 text-ink-dim underline hover:text-danger"><Trash2 className="h-3 w-3" /> Remove</button>
                      </div>
                      {changing === r.key && (
                        <div className="mt-1.5 rounded border border-line bg-surface p-2 text-xs">
                          {r.alternatives.length > 0 && (
                            <>
                              <div className="mb-1 text-ink-muted">Closest other matches</div>
                              <ul className="mb-2 flex flex-wrap gap-1">
                                {r.alternatives.slice(0, 6).map((id) => (
                                  <li key={id}><button type="button" onClick={() => replaceItem(r.key, id)} className="flex items-center gap-1 rounded border border-line px-1.5 py-0.5 hover:border-accent">{items?.[id]?.iconLink && <img src={items[id].iconLink ?? ''} alt="" className="h-5 w-5 object-contain" />}{items?.[id]?.shortName ?? id.slice(-6)}</button></li>
                                ))}
                              </ul>
                            </>
                          )}
                          <label className="relative block">
                            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-dim" />
                            <input autoFocus type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search the right item…" className="w-full rounded border border-line bg-surface-2 py-1 pl-7 pr-2" />
                          </label>
                          <ul className="mt-1 space-y-0.5">
                            {searchResults.map((i) => (
                              <li key={i.id}><button type="button" onClick={() => replaceItem(r.key, i.id)} className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-surface-3">{i.iconLink && <img src={i.iconLink} alt="" className="h-5 w-5 object-contain" />}<span className="truncate">{i.name}</span></button></li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
            {learnNote && <p className="border-t border-line px-3 py-1.5 text-xs text-info">{learnNote}</p>}
            <LearnedPanel items={items} canRescan={Boolean(image) && status !== 'scanning'} onRescan={() => { if (image) void runScan(image, crop) }} />
            <div className="space-y-2 border-t border-line px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-1.5"><input type="radio" checked={mode === 'add'} onChange={() => setMode('add')} /> Add to what I have</label>
                <label className="flex items-center gap-1.5" title="Sets selected item counts only; other counts stay unchanged. This is not a container replacement."><input type="radio" checked={mode === 'set'} onChange={() => setMode('set')} /> Set selected counts</label>
              </div>
              {applied ? (
                <p className="flex flex-wrap items-center gap-1.5 text-success">
                  <Check className="h-4 w-4" /> {applied}
                  {lastApply && (
                    <button type="button" onClick={() => void undoApply()} className="btn !py-0.5 text-xs" title="Puts the counts back to how they were before this apply">
                      <Undo2 className="h-3.5 w-3.5" /> Undo
                    </button>
                  )}
                </p>
              ) : !applied && lastApply ? (
                <p className="flex flex-wrap items-center gap-1.5 text-ink-muted">
                  Last apply: {lastApply.summary}
                  <button type="button" onClick={() => void undoApply()} className="btn !py-0.5 text-xs">
                    <Undo2 className="h-3.5 w-3.5" /> Undo it
                  </button>
                </p>
              ) : undoNote ? (
                <p className="text-ink-muted">{undoNote}</p>
              ) : (
                <p className="text-ink-dim">Ticked items count toward Item Collection (alternatives a quest accepts count too). Scanning the same stash twice with "Add" counts items twice.</p>
              )}
              <div className="flex justify-end gap-2">
                <button type="button" onClick={close} className="btn">Close</button>
                <button type="button" onClick={apply} disabled={selectedCount === 0 || Boolean(applied)} className="btn border-accent bg-accent text-surface hover:bg-accent disabled:opacity-40">
                  {applied ? <><Check className="h-4 w-4" /> Applied</> : `Apply ${selectedCount} item${selectedCount === 1 ? '' : 's'} to Item Collection`}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
