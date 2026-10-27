/**
 * Page-side wrapper around the scan worker: loads the fingerprint files once
 * (from the web server, or through the desktop bridge because Chromium cannot
 * fetch() file:// URLs) and turns an image into detections.
 */
import type { Detection, Grid, LearnedFingerprint, OcrWord } from './core'
import type { IdentifyMatch, WorkerRequest, WorkerResponse } from './scan.worker'
import ScanWorker from './scan.worker?worker'
import { checkedCrop, checkedGrid } from './registration'
import { fingerprintHeader, scannerManifest, MAX_FINGERPRINT_BYTES, MAX_FINGERPRINT_HEADER_BYTES } from './assets'

export interface ScanResult {
  grid: Grid
  detections: Detection[]
  ms: number
  assetWarnings?: string[]
}

let worker: Worker | null = null
let ready: Promise<number> | null = null
let nextId = 1
let assetWarnings: string[] = []
const pending = new Map<number, { resolve: (r: ScanResult) => void; reject: (e: Error) => void; onProgress?: (p: number) => void }>()
const identifying = new Map<number, { resolve: (m: IdentifyMatch[]) => void; reject: (e: Error) => void }>()

async function loadFile(name: string): Promise<ArrayBuffer> {
  if (window.desktop?.readAppResource) {
    // Installed app: the scanner data is a content pack downloaded on first use.
    const bytes = await window.desktop.readAppResource(`scan/${name}`)
    if (bytes.byteLength > MAX_FINGERPRINT_BYTES) throw new Error('Scanner asset exceeds its byte budget')
    return bytes
  }
  const res = await fetch(`${import.meta.env.BASE_URL}scan/${name}`, { cache: "no-cache" })
  if (!res.ok) throw new Error(`Scanner data missing (${name}, HTTP ${res.status}). Run "npm run scan:fingerprints".`)
  if (Number(res.headers.get('content-length')) > MAX_FINGERPRINT_BYTES) throw new Error('Scanner asset exceeds its byte budget')
  const bytes = await res.arrayBuffer()
  if (bytes.byteLength > MAX_FINGERPRINT_BYTES) throw new Error('Scanner asset exceeds its byte budget')
  return bytes
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
        pending.get(m.id)?.resolve({ grid: m.grid, detections: m.detections, ms: m.ms, assetWarnings })
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
      w.terminate()
      if (worker !== w) return
      for (const p of pending.values()) p.reject(err)
      for (const p of identifying.values()) p.reject(err)
      pending.clear()
      identifying.clear()
      worker = null
      ready = null
    }
    w.onerror = (e) => fail(e.message || 'The scanner stopped unexpectedly. Try again, or scan a smaller part of the screenshot.')
    w.onmessageerror = () => fail('The scanner could not read its data. Try again.')
    Promise.resolve(window.desktop?.ensurePack('scan'))
      .then(() => Promise.all([loadFile('manifest.json'), loadFile('fingerprints.json'), loadFile('fingerprints.bin')]))
      .then(async ([manifestBuf, headerBuf, pixels]) => {
        if (manifestBuf.byteLength > 64 * 1024 || headerBuf.byteLength > MAX_FINGERPRINT_HEADER_BYTES) throw new Error('Scanner metadata exceeds its byte budget')
        const manifest = scannerManifest(JSON.parse(new TextDecoder().decode(manifestBuf)))
        for (const [name, bytes] of [['fingerprints.json', headerBuf], ['fingerprints.bin', pixels]] as const) {
          const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('')
          if (bytes.byteLength !== manifest.files[name].size || digest !== manifest.files[name].sha256)
            throw new Error('Scanner asset checksum differs. Rebuild or reinstall the matching content pack.')
        }
        const header = fingerprintHeader(JSON.parse(new TextDecoder().decode(headerBuf)), pixels.byteLength)
        if (worker !== w) return
        assetWarnings = manifest.excluded > 0
          ? ['Some catalog entries have no usable grid reference. Check unrecognized areas and add missing items manually.'] : []
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
  /** Explicit full-image registration; bypasses grid discovery only. */
  grid?: Grid,
): Promise<ScanResult> {
  await ensureWorker()
  const bitmap = await createImageBitmap(image)
  try {
    const area = checkedCrop(crop, bitmap)
    if (grid) checkedGrid(grid, area)
  } catch (error) {
    bitmap.close()
    throw error
  }
  const id = nextId++
  return new Promise<ScanResult>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress })
    const msg: WorkerRequest = { type: 'scan', id, bitmap, crop, learned, pitch, preferredPitch, words, grid }
    try {
      if (!worker) throw new Error('Scanner is unavailable. Try again.')
      worker.postMessage(msg, [bitmap])
    } catch (error) {
      pending.delete(id)
      bitmap.close()
      reject(error instanceof Error ? error : new Error(String(error)))
    }
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
