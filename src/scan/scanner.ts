/**
 * Page-side wrapper around the scan worker: loads the fingerprint files once
 * (from the web server, or through the desktop bridge because Chromium cannot
 * fetch() file:// URLs) and turns an image into detections.
 */
import type { Detection, FingerprintHeader, Grid, LearnedFingerprint, OcrWord } from './core'
import type { IdentifyMatch, WorkerRequest, WorkerResponse } from './scan.worker'
import ScanWorker from './scan.worker?worker'

export interface ScanResult {
  grid: Grid
  detections: Detection[]
  ms: number
}

let worker: Worker | null = null
let ready: Promise<number> | null = null
let nextId = 1
const pending = new Map<number, { resolve: (r: ScanResult) => void; reject: (e: Error) => void; onProgress?: (p: number) => void }>()
const identifying = new Map<number, { resolve: (m: IdentifyMatch[]) => void; reject: (e: Error) => void }>()

async function loadFile(name: string): Promise<ArrayBuffer> {
  if (window.desktop?.readAppResource) {
    // Installed app: the scanner data is a content pack downloaded on first use.
    await window.desktop.ensurePack('scan')
    return window.desktop.readAppResource(`scan/${name}`)
  }
  const res = await fetch(`${import.meta.env.BASE_URL}scan/${name}`, { cache: "no-cache" })
  if (!res.ok) throw new Error(`Scanner data missing (${name}, HTTP ${res.status}). Run "npm run scan:fingerprints".`)
  return res.arrayBuffer()
}

function ensureWorker(): Promise<number> {
  if (ready) return ready
  worker = new ScanWorker()
  ready = new Promise<number>((resolve, reject) => {
    const w = worker as Worker
    w.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const m = e.data
      if (m.type === 'ready') resolve(m.items)
      else if (m.type === 'progress') pending.get(m.id)?.onProgress?.(m.done / Math.max(1, m.total))
      else if (m.type === 'result') {
        pending.get(m.id)?.resolve({ grid: m.grid, detections: m.detections, ms: m.ms })
        pending.delete(m.id)
      } else if (m.type === 'identified') {
        identifying.get(m.id)?.resolve(m.matches)
        identifying.delete(m.id)
      } else if (m.type === 'error') {
        pending.get(m.id)?.reject(new Error(m.message))
        pending.delete(m.id)
        identifying.get(m.id)?.reject(new Error(m.message))
        identifying.delete(m.id)
      }
    }
    // A crash (e.g. out of memory on a huge screenshot) fails everything waiting and starts a
    // fresh worker next time, instead of leaving the dialog on "scanning" forever.
    const fail = (message: string) => {
      const err = new Error(message)
      reject(err)
      for (const p of pending.values()) p.reject(err)
      for (const p of identifying.values()) p.reject(err)
      pending.clear()
      identifying.clear()
      w.terminate()
      if (worker === w) {
        worker = null
        ready = null
      }
    }
    w.onerror = (e) => fail(e.message || 'The scanner stopped unexpectedly. Try again, or scan a smaller part of the screenshot.')
    w.onmessageerror = () => fail('The scanner could not read its data. Try again.')
    Promise.all([loadFile('fingerprints.json'), loadFile('fingerprints.bin')])
      .then(([headerBuf, pixels]) => {
        const header = JSON.parse(new TextDecoder().decode(headerBuf)) as FingerprintHeader
        const msg: WorkerRequest = { type: 'init', header, pixels }
        w.postMessage(msg, [pixels])
      })
      .catch((err: unknown) => {
        fail(err instanceof Error ? err.message : String(err))
      })
  })
  return ready
}

/** Loads the scanner data in the background (call when the scan screen opens). */
export function warmUpScanner(): Promise<number> {
  return ensureWorker()
}

export async function scanImage(
  image: Blob,
  crop: { x: number; y: number; w: number; h: number } | null,
  onProgress?: (fraction: number) => void,
  learned: LearnedFingerprint[] = [],
  /** Cell size already known (e.g. from the full screenshot when scanning a selection). */
  pitch?: number,
  /** Item names read from the screenshot (see ocr.ts). */
  words?: OcrWord[],
  /** Cell size of the last good scan, tried first (see cellSize.ts). */
  preferredPitch?: number,
): Promise<ScanResult> {
  await ensureWorker()
  const bitmap = await createImageBitmap(image)
  const id = nextId++
  return new Promise<ScanResult>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress })
    const msg: WorkerRequest = { type: 'scan', id, bitmap, crop, learned, pitch, preferredPitch, words }
    worker?.postMessage(msg, [bitmap])
  })
}

export type { IdentifyMatch }

/** Best items for a box (grid cells of the last scan), e.g. after the user moved or drew it. */
export async function identifyBox(box: { col: number; row: number; w: number; h: number }): Promise<IdentifyMatch[]> {
  await ensureWorker()
  const id = nextId++
  return new Promise<IdentifyMatch[]>((resolve, reject) => {
    identifying.set(id, { resolve, reject })
    const msg: WorkerRequest = { type: 'identify', id, box }
    worker?.postMessage(msg)
  })
}
