/**
 * The search bar's stash scan: a snip of a few stash or container slots, scanned in this window.
 * The scanner (item pictures, name reader) loads only when a snip arrives and is unloaded again
 * once it is done, so the bar stays light while you play. Manual tuning (the full-screen box
 * editor) keeps it loaded while it is open; every fix there is remembered like the app scanner's.
 */
import { create } from 'zustand'
import type { Detection, Grid } from '../scan/core'

export interface StashScan {
  id: number
  /** The snipped part of the screen (PNG) and a page URL for it. */
  image: Blob
  url: string
  width: number
  height: number
  status: 'waiting' | 'reading' | 'matching' | 'done' | 'error'
  /** 0..1 while matching. */
  progress: number
  error: string | null
  grid: Grid | null
  detections: Detection[]
  /** Boxes fixed by hand in Manual tuning (spots), for the "fixed" tag. */
  fixed: number[]
  /** "All correct" was pressed for this scan (the uncertain finds were remembered). */
  confirmed: boolean
}

interface StashScanState {
  scan: StashScan | null
  /** Manual tuning is open (the full-screen box editor). */
  tuning: boolean
  /** A new snip: replaces the last one (its results go away). */
  start: (image: Blob, width: number, height: number) => void
  patch: (id: number, p: Partial<StashScan>) => void
  setTuning: (on: boolean) => void
  clear: () => void
}

let nextId = 1
let recognition: AbortController | undefined
let releaseTuning: (() => void) | undefined

export const useStashScan = create<StashScanState>()((set, get) => ({
  scan: null,
  tuning: false,
  start: (image, width, height) => {
    recognition?.abort()
    releaseTuning?.()
    releaseTuning = undefined
    const old = get().scan
    if (old) URL.revokeObjectURL(old.url)
    set({
      tuning: false,
      scan: { id: nextId++, image, url: URL.createObjectURL(image), width, height, status: 'waiting', progress: 0, error: null, grid: null, detections: [], fixed: [], confirmed: false },
    })
  },
  patch: (id, p) => set((s) => (s.scan?.id === id ? { scan: { ...s.scan, ...p } } : s)),
  setTuning: (on) => set({ tuning: on }),
  clear: () => {
    recognition?.abort()
    releaseTuning?.()
    releaseTuning = undefined
    const old = get().scan
    if (old) URL.revokeObjectURL(old.url)
    set({ scan: null, tuning: false })
  },
}))

const load = () => Promise.all([import('../scan/scanner'), import('../scan/ocr'), import('../scan/learned'), import('../scan/cellSize'), import('../scan/stashValues')])

/**
 * One pass of the scanner over the snip, with your corrections and the remembered cell size; the
 * same picture and settings give the same boxes. `pitch` forces the cell size.
 */
async function scanSnip(scan: StashScan, onProgress: (p: number) => void, onMatching: () => void, signal: AbortSignal, pitch?: number) {
  const [scanner, ocr, learned, cellSize] = await load()
  // Your own corrections (from here or the app's scanner) count too: the same saved data.
  await learned.useLearnedStore.getState().load()
  // The printed item names first (they make matches much surer); scanning works without them.
  signal.throwIfAborted()
  const words = await ocr.readWords(scan.image, null, { signal }).catch(() => undefined)
  signal.throwIfAborted()
  onMatching()
  return scanner.scanImage(scan.image, null, onProgress, learned.learnedFingerprints(learned.useLearnedStore.getState().records), pitch, words, pitch ? undefined : cellSize.rememberedCellSize(), undefined, undefined, signal)
}

/** Scans the waiting snip once (the body calls this when it sees one). */
export async function runStashScan(id: number): Promise<void> {
  const st = useStashScan.getState()
  const scan = st.scan
  if (!scan || scan.id !== id || scan.status !== 'waiting') return
  const job = recognition = new AbortController()
  st.patch(id, { status: 'reading' })
  try {
    const r = await scanSnip(
      scan,
      (p) => useStashScan.getState().patch(id, { progress: p }),
      () => useStashScan.getState().patch(id, { status: 'matching' }),
      job.signal,
    )
    // A scan that clearly worked teaches the cell size for the next snips (same as the app's scanner).
    const [, , , cellSize, values] = await load()
    job.signal.throwIfAborted()
    const sure = r.detections.filter((d) => values.confidence(d.error, values.marginOf(d), Boolean(d.nameMatch)) === 'sure').length
    cellSize.rememberCellSize(r.grid.pitch, sure, r.detections.length)
    useStashScan.getState().patch(id, { status: 'done', grid: r.grid, detections: r.detections, progress: 1 })
  } catch (e) {
    if (!job.signal.aborted) st.patch(id, { status: 'error', error: e instanceof Error ? e.message : String(e) })
  } finally {
    if (recognition === job) recognition = undefined
  }
}

const sameGrid = (a: Grid, b: Grid) => Math.abs(a.pitch - b.pitch) < 0.01 && Math.abs(a.ox - b.ox) < 0.5 && Math.abs(a.oy - b.oy) < 0.5 && a.cols === b.cols && a.rows === b.rows

/**
 * Manual tuning: the snip is scanned once more so the scanner can name boxes that are moved or
 * drawn (it stays loaded until `endTuning`). With `pitch` the cell size is forced (you corrected
 * it). The boxes to start from: the current ones (earlier fixes) when the grid came out the same.
 */
export async function prepareTuning(id: number, pitch?: number): Promise<{ grid: Grid; detections: Detection[]; fresh: boolean } | null> {
  const scan = useStashScan.getState().scan
  if (!scan || scan.id !== id) return null
  recognition?.abort()
  const job = recognition = new AbortController()
  const { retainScanner } = await import('../scan/scanner')
  job.signal.throwIfAborted()
  releaseTuning ??= retainScanner()
  const r = await scanSnip(scan, () => undefined, () => undefined, job.signal, pitch)
  job.signal.throwIfAborted()
  const keep = !pitch && scan.grid && sameGrid(scan.grid, r.grid)
  return keep ? { grid: scan.grid!, detections: scan.detections, fresh: false } : { grid: r.grid, detections: r.detections, fresh: true }
}

/** Manual tuning closed: the scanner goes again (unless a new snip is being scanned). */
export function endTuning(): void {
  useStashScan.getState().setTuning(false)
  recognition?.abort()
  releaseTuning?.()
  releaseTuning = undefined
}

/**
 * "All correct": every find in the snip that was not sure is remembered as right, so the next
 * scan of these items is sure. Returns how many were saved.
 */
export async function confirmScan(id: number): Promise<number> {
  const scan = useStashScan.getState().scan
  if (!scan || scan.id !== id || !scan.grid || scan.confirmed) return 0
  const [, , learned, , values] = await load()
  let n = 0
  for (const d of scan.detections) {
    if (!d.itemId || values.confidence(d.error, values.marginOf(d), Boolean(d.nameMatch)) === 'sure') continue
    const rec = await learned.recordFromSpot(scan.image, scan.grid, d, d.w, d.h, d.itemId, 'confirmed').catch(() => null)
    if (!rec) continue
    await learned.useLearnedStore.getState().add(rec)
    n++
  }
  useStashScan.getState().patch(id, { confirmed: true })
  return n
}

/** Cuts the dragged box (picture pixels) out of the screen picture. */
export async function cropSnip(screenPng: Blob, box: { x: number; y: number; w: number; h: number }): Promise<Blob> {
  const bitmap = await createImageBitmap(screenPng, box.x, box.y, box.w, box.h)
  const canvas = new OffscreenCanvas(box.w, box.h)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
  bitmap.close()
  return canvas.convertToBlob({ type: 'image/png' })
}
