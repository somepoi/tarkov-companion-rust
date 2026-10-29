/// <reference lib="webworker" />
/**
 * Runs the stash scan off the UI thread. The page sends the fingerprint files
 * once ("init"), then screenshots ("scan") as ImageBitmaps plus an optional crop.
 */
import { buildCandidates, chooseGrid, detectGrid, identifyRegion, refineGrid, indexFromParts, scanGrid, withLearned, type Rgba, type Detection, type FingerprintHeader, type FingerprintIndex, type Grid, type LearnedFingerprint, type OcrWord } from './core'
import { checkedCrop, checkedGrid, checkedRepeatedGrid } from './registration'

export type WorkerRequest =
  | { type: 'init'; header: FingerprintHeader; pixels: ArrayBuffer }
  | { type: 'scan'; id: number; bitmap: ImageBitmap; crop: { x: number; y: number; w: number; h: number } | null; pitch?: number; preferredPitch?: number; learned?: LearnedFingerprint[]; words?: OcrWord[]; grid?: Grid; expectedGrid?: Grid }
  /** Best items for one box of the last scan (grid cells), for the box editor. */
  | { type: 'identify'; id: number; box: { col: number; row: number; w: number; h: number } }

export type WorkerResponse =
  | { type: 'ready'; items: number }
  | { type: 'progress'; id: number; done: number; total: number }
  | { type: 'result'; id: number; grid: Grid; detections: Detection[]; ms: number }
  | { type: 'identified'; id: number; matches: IdentifyMatch[] }
  | { type: 'error'; id: number; message: string }

let index: FingerprintIndex | null = null
let candidates: ReturnType<typeof buildCandidates> | null = null
/** The last scan (cropped image, grid in its coordinates, words, candidates with corrections) for 'identify'. */
let last: { img: Rgba; grid: Grid; words: OcrWord[]; candidates: ReturnType<typeof buildCandidates> } | null = null

export type IdentifyMatch = ReturnType<typeof identifyRegion>[number]

const post = (msg: WorkerResponse) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg)

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data
  if (msg.type === 'init') {
    index = indexFromParts(msg.header, new Uint8Array(msg.pixels))
    candidates = buildCandidates(index)
    post({ type: 'ready', items: index.ids.length })
    return
  }
  if (msg.type === 'scan') {
    try {
      if (!index || !candidates) throw new Error('Scanner data not loaded yet')
      const t0 = performance.now()
      const crop = checkedCrop(msg.crop, msg.bitmap)
      const registered = msg.grid ? checkedGrid(msg.grid, crop) : undefined
      if (registered && msg.expectedGrid) throw new Error('Repeated recognition requires independent grid discovery.')
      const canvas = new OffscreenCanvas(crop.w, crop.h)
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) throw new Error('No 2D canvas in this browser')
      ctx.drawImage(msg.bitmap, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h)
      msg.bitmap.close()
      const pixels = ctx.getImageData(0, 0, crop.w, crop.h)
      const img = { width: pixels.width, height: pixels.height, data: pixels.data }
      // Known cell size (a selection): only the line positions are searched. Otherwise the
      // matcher judges a few proposed grids and keeps the one real items fit best.
      // Words in crop coordinates (OCR ran on the full screenshot).
      const words = (msg.words ?? []).map((w) => ({ ...w, x0: w.x0 - crop.x, x1: w.x1 - crop.x, y0: w.y0 - crop.y, y1: w.y1 - crop.y }))
      const grid = registered
        ? { ...registered, ox: registered.ox - crop.x, oy: registered.oy - crop.y }
        : msg.pitch ? refineGrid(img, detectGrid(img, msg.pitch), candidates) : chooseGrid(img, candidates, words, msg.preferredPitch)
      if (msg.expectedGrid) checkedRepeatedGrid(
        { ...grid, ox: grid.ox + crop.x, oy: grid.oy + crop.y }, msg.expectedGrid, crop)
      const withMine = withLearned(candidates, msg.learned ?? [])
      const detections = scanGrid(img, grid, withMine, index, { words }, (done, total) => post({ type: 'progress', id: msg.id, done, total }))
      last = { img, grid, words, candidates: withMine }
      // Report positions in full-screenshot coordinates.
      const shifted: Grid = { ...grid, ox: grid.ox + crop.x, oy: grid.oy + crop.y }
      post({ type: 'result', id: msg.id, grid: shifted, detections, ms: Math.round(performance.now() - t0) })
    } catch (err) {
      post({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) })
    } finally {
      msg.bitmap.close()
    }
  }
  if (msg.type === 'identify') {
    if (!last) {
      post({ type: 'error', id: msg.id, message: 'Scan a screenshot first' })
      return
    }
    post({ type: 'identified', id: msg.id, matches: identifyRegion(last.img, last.grid, last.candidates, msg.box, last.words) })
  }
}
