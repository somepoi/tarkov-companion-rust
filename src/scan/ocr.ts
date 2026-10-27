/**
 * Reads the short names printed on items (top-right of every slot) with Tesseract,
 * fully offline. The engine and English model ship in /ocr (npm run ocr:assets).
 * In the installed app the page is a local file, which Chromium cannot fetch() from,
 * so the files are served through the app's own read-only "tcres://" address.
 */
import { createWorker, OEM, PSM } from 'tesseract.js'
import type { OcrWord } from './core'
import { checkedCrop, type ImageCrop } from './registration'

type TessWorker = Awaited<ReturnType<typeof createWorker>>

function assetBase(): string {
  if (location.protocol === 'file:') return 'tcres://app/ocr'
  return new URL(`${import.meta.env.BASE_URL}ocr`, location.href).href.replace(/\/$/, '')
}

let workerPromise: Promise<TessWorker> | null = null
/** Blank margin around the image handed to the reader. */
const PAD = 24

function getWorker(): Promise<TessWorker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const base = assetBase()
      const worker = await createWorker('eng', OEM.LSTM_ONLY, {
        workerPath: `${base}/worker.min.js`,
        corePath: base,
        langPath: base,
        gzip: true,
        cacheMethod: 'none',
        workerBlobURL: true,
      })
      try {
        await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT })
      } catch (error) {
        await worker.terminate().catch(() => undefined)
        throw error
      }
      return worker
    })().catch((err: unknown) => {
      workerPromise = null
      throw err
    })
  }
  return workerPromise
}

/** Separable bicubic (Keys, a = -0.5) resize of a single-channel image. */
function bicubicResize(src: Float32Array, w: number, h: number, W: number, H: number): Float32Array {
  const kernel = (x: number) => {
    const t = Math.abs(x)
    if (t <= 1) return 1.5 * t ** 3 - 2.5 * t ** 2 + 1
    if (t < 2) return -0.5 * t ** 3 + 2.5 * t ** 2 - 4 * t + 2
    return 0
  }
  const pass = (data: Float32Array, inW: number, inH: number, outW: number, horizontal: boolean) => {
    // outW is the target length along the pass direction (width for horizontal, height for vertical).
    const len = outW
    const res = new Float32Array(horizontal ? outW * inH : inW * outW)
    const inLen = horizontal ? inW : inH
    const ratio = inLen / len
    for (let o = 0; o < len; o++) {
      const center = (o + 0.5) * ratio - 0.5
      const i0 = Math.floor(center)
      const wts = [-1, 0, 1, 2].map((k) => kernel(center - (i0 + k)))
      const sum = wts.reduce((x, y) => x + y, 0)
      for (let line = 0; line < (horizontal ? inH : inW); line++) {
        let v = 0
        for (let k = 0; k < 4; k++) {
          const i = Math.min(inLen - 1, Math.max(0, i0 - 1 + k))
          v += wts[k] * (horizontal ? data[line * inW + i] : data[i * inW + line])
        }
        if (horizontal) res[line * outW + o] = v / sum
        else res[o * inW + line] = v / sum
      }
    }
    return res
  }
  const horiz = pass(src, w, h, W, true)
  return pass(horiz, W, h, H, false)
}

/** Starts loading the reader in the background (the model is ~3 MB). */
export function warmUpOcr(): void {
  void getWorker().catch(() => undefined)
}

/** Otsu's threshold: the brightness that best splits the picture into dark and light. */
function otsuThreshold(lum: Float32Array): number {
  const hist = new Array<number>(256).fill(0)
  for (const v of lum) hist[Math.max(0, Math.min(255, Math.round(v)))]++
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]
  let sumB = 0
  let wB = 0
  let best = 0
  let threshold = 150
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (wB === 0) continue
    const wF = lum.length - wB
    if (wF === 0) break
    sumB += t * hist[t]
    const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2
    if (between > best) {
      best = between
      threshold = t
    }
  }
  return threshold
}

/**
 * Words in the screenshot, in screenshot pixel coordinates. Only the bright lettering
 * is kept (item names are white), enlarged 2x for small screenshots. `threshold` 'auto'
 * picks the cut-off from the picture (grey text on dark panels, e.g. the quest list).
 */
interface ReadOptions {
  threshold?: number | 'auto'
  /** Quantity strips have already been enlarged in their atlas. */
  scale?: 1 | 2 | 4
  isCurrent?: () => boolean
}

let ocrQueue = Promise.resolve()
let queuedReads = 0

/** One executing read and at most one waiting read share the offline engine. */
export function readWords(image: Blob, crop: ImageCrop | null, opts: ReadOptions = {}): Promise<OcrWord[]> {
  if (queuedReads >= 2) return Promise.reject(new Error('The text reader is busy. Finish the current scan and try again.'))
  queuedReads++
  const read = ocrQueue.then(() => readWordsNow(image, crop, opts))
  ocrQueue = read.then(() => undefined, () => undefined)
  return read.finally(() => { queuedReads-- })
}

async function readWordsNow(image: Blob, crop: ImageCrop | null, opts: ReadOptions): Promise<OcrWord[]> {
  const checkCurrent = () => {
    if (opts.isCurrent && !opts.isCurrent()) throw new DOMException('Text read was cancelled', 'AbortError')
  }
  checkCurrent()
  const bitmap = await createImageBitmap(image)
  let area: ImageCrop
  let src: OffscreenCanvas
  let sctx: OffscreenCanvasRenderingContext2D
  try {
    checkCurrent()
    area = checkedCrop(crop, bitmap)
    src = new OffscreenCanvas(area.w, area.h)
    const context = src.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('The text reader cannot create an image canvas')
    sctx = context
    sctx.drawImage(bitmap, area.x, area.y, area.w, area.h, 0, 0, area.w, area.h)
  } finally {
    bitmap.close()
  }
  const scale = opts.scale ?? (area.w < 1800 ? 2 : 1)
  if (area.w * area.h * scale * scale > 40_000_000)
    throw new Error('The enlarged text image exceeds the pixel budget. Select a smaller area.')
  // Luminance at native size, then a sharp bicubic enlargement (the browser's own canvas
  // scaling blurs the small lettering and the reader then misreads names).
  const rgba = sctx.getImageData(0, 0, area.w, area.h).data
  const lum = new Float32Array(area.w * area.h)
  for (let i = 0; i < lum.length; i++) lum[i] = rgba[i * 4] * 0.299 + rgba[i * 4 + 1] * 0.587 + rgba[i * 4 + 2] * 0.114
  const big = scale === 1 ? lum : bicubicResize(lum, area.w, area.h, area.w * scale, area.h * scale)
  // Never below 90: on a mostly black screenshot Otsu would also keep dim panel edges.
  const cutoff = opts.threshold === 'auto' ? Math.max(90, otsuThreshold(lum)) : (opts.threshold ?? 150)
  const W = area.w * scale
  const H = area.h * scale
  // A blank margin: Tesseract misses text that touches the image border (narrow snips).
  const canvas = new OffscreenCanvas(W + 2 * PAD, H + 2 * PAD)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('The text reader cannot create its enlarged image canvas')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const out = ctx.createImageData(W, H)
  for (let i = 0; i < big.length; i++) {
    const v = big[i] > cutoff ? 0 : 255 // white names -> black text on white
    out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = v
    out.data[i * 4 + 3] = 255
  }
  ctx.putImageData(out, PAD, PAD)
  const png = await canvas.convertToBlob({ type: 'image/png' })
  checkCurrent()
  const worker = await getWorker()
  checkCurrent()
  const { data } = await worker.recognize(png, {}, { blocks: true }).catch(async (error: unknown) => {
    workerPromise = null
    await worker.terminate().catch(() => undefined)
    throw error
  })
  checkCurrent()
  const words: OcrWord[] = []
  for (const b of data.blocks ?? []) {
    for (const para of b.paragraphs) {
      for (const line of para.lines) {
        for (const w of line.words) {
          words.push({
            text: w.text,
            conf: w.confidence,
            x0: area.x + (w.bbox.x0 - PAD) / scale,
            y0: area.y + (w.bbox.y0 - PAD) / scale,
            x1: area.x + (w.bbox.x1 - PAD) / scale,
            y1: area.y + (w.bbox.y1 - PAD) / scale,
          })
        }
      }
    }
  }
  return words
}
