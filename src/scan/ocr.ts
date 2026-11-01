/**
 * Reads the short names printed on items (top-right of every slot) with Tesseract,
 * fully offline. The engine and English model ship in /ocr (npm run ocr:assets).
 * In the installed app the page is a local file, which Chromium cannot fetch() from,
 * so the files are served through the app's own read-only "tcres://" address.
 */
import { createWorker, OEM, PSM } from 'tesseract.js'
import type { OcrWord } from './core'
import { abortable } from './abort'
import type { ImageCrop } from './registration'
import { prepareText } from './prepareText'
import { TEXT_PAD as PAD } from './ocrPreparationConstants'

type TessWorker = Awaited<ReturnType<typeof createWorker>>

function assetBase(): string {
  if (location.protocol === 'file:') return 'tcres://app/ocr'
  return new URL(`${import.meta.env.BASE_URL}ocr`, location.href).href.replace(/\/$/, '')
}

let workerPromise: Promise<TessWorker> | null = null

let idle: ReturnType<typeof setTimeout> | undefined

function scheduleRelease() {
  clearTimeout(idle)
  idle = undefined
  if (queuedReads || !workerPromise) return
  const candidate = workerPromise
  idle = setTimeout(() => {
    idle = undefined
    if (queuedReads || workerPromise !== candidate) return
    // Detach before asynchronous termination so a fresh read gets a new engine.
    workerPromise = null
    void candidate.then((worker) => worker.terminate()).catch(() => undefined)
  }, 60_000)
}

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
      scheduleRelease()
      return worker
    })().catch((err: unknown) => {
      workerPromise = null
      throw err
    })
  }
  return workerPromise
}

/** Starts loading the reader in the background (the model is ~3 MB). */
export function warmUpOcr(): void {
  clearTimeout(idle)
  idle = undefined
  void getWorker().then(() => scheduleRelease()).catch(() => undefined)
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
  signal?: AbortSignal
}

let ocrQueue = Promise.resolve()
let queuedReads = 0

/** One executing read and at most one waiting read share the offline engine. */
export function readWords(image: Blob, crop: ImageCrop | null, opts: ReadOptions = {}): Promise<OcrWord[]> {
  if (opts.signal?.aborted) return Promise.reject(new DOMException('Text read was cancelled', 'AbortError'))
  if (queuedReads >= 2) return Promise.reject(new Error('The text reader is busy. Finish the current scan and try again.'))
  clearTimeout(idle)
  idle = undefined
  queuedReads++
  const read = ocrQueue.then(() => readWordsNow(image, crop, opts))
  ocrQueue = read.then(() => undefined, () => undefined)
  return abortable(read.finally(() => { queuedReads--; scheduleRelease() }), opts.signal)
}

async function readWordsNow(image: Blob, crop: ImageCrop | null, opts: ReadOptions): Promise<OcrWord[]> {
  const checkCurrent = () => {
    if (opts.signal?.aborted || (opts.isCurrent && !opts.isCurrent())) throw new DOMException('Text read was cancelled', 'AbortError')
  }
  checkCurrent()
  const { png, area, scale } = await prepareText(image, crop, opts, opts.signal)
  checkCurrent()
  const worker = await abortable(getWorker(), opts.signal)
  checkCurrent()
  const currentPromise = workerPromise
  const result = worker.recognize(png, {}, { blocks: true })
  const { data } = await new Promise<Awaited<typeof result>>((resolve, reject) => {
    const clear = () => opts.signal?.removeEventListener('abort', abort)
    const reset = () => {
      if (workerPromise === currentPromise) workerPromise = null
      void worker.terminate().catch(() => undefined)
    }
    const abort = () => {
      clear()
      reset()
      reject(new DOMException('Text read was cancelled', 'AbortError'))
    }
    opts.signal?.addEventListener('abort', abort, { once: true })
    result.then((value) => { clear(); resolve(value) }, (error: unknown) => {
      clear()
      reset()
      reject(error)
    })
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
