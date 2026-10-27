import type { Item, ItemsById } from '../api/types'
import type { Detection, Grid, OcrWord } from './core'
import { checkedCrop, checkedGrid, type ImageCrop, type ImageSize } from './registration'

export type QuantityStatus = 'candidate' | 'no-text' | 'ambiguous' | 'out-of-range' | 'low-confidence'
export interface QuantityEvidence {
  method: 'bottom-strip-v1'
  itemId: string
  text: string
  /** Minimum Tesseract word score, not a calibrated probability. */
  confidence: number | null
  maxQuantity: number
  crop: ImageCrop
  status: QuantityStatus
}
export interface QuantityReading {
  quantity: number | null
  evidence: QuantityEvidence
}
export interface QuantityReport {
  readings: Map<number, QuantityReading>
  eligible: number
  attempted: number
  skipped: number
  suggested: number
}

type Footprint = Pick<Detection, 'col' | 'row' | 'w' | 'h' | 'clipped'>
const MAX_REGIONS = 64
const MAX_ATLAS_PIXELS = 2_000_000
const MAX_ATLAS_WIDTH = 4096
const MAX_ATLAS_HEIGHT = 8192
const PAD = 24
const MIN_CONFIDENCE = 85

/** Missing catalog bounds do not erase a manually reviewed fact. */
export function quantityFitsCatalog(quantity: number | null, item: Item | undefined): boolean {
  if (quantity === null || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 0xffff_ffff) return false
  const maximum = item?.stackMaxSize
  return typeof maximum !== 'number' || !Number.isSafeInteger(maximum) || maximum < 1 || quantity <= maximum
}

export function canReadQuantity(item: Item | undefined, footprint: Footprint): boolean {
  const maximum = item?.stackMaxSize
  return !!item && typeof maximum === 'number' && Number.isSafeInteger(maximum)
    && maximum > 1 && maximum <= 0xffff_ffff && !footprint.clipped
    && ((footprint.w === item.width && footprint.h === item.height)
      || (footprint.w === item.height && footprint.h === item.width))
}

/** Keep the whole bottom strip: removing punctuation could hide a charge ratio. */
export function quantityCrop(grid: Grid, footprint: Footprint, size: ImageSize): ImageCrop {
  checkedGrid(grid, checkedCrop(null, size))
  if (![footprint.col, footprint.row, footprint.w, footprint.h].every(Number.isSafeInteger)
    || footprint.col < 0 || footprint.row < 0 || footprint.w < 1 || footprint.h < 1
    || footprint.col + footprint.w > grid.cols || footprint.row + footprint.h > grid.rows
    || footprint.clipped)
    throw new Error('The complete stack footprint must be inside the registered screenshot grid')
  const x = Math.ceil(grid.ox + footprint.col * grid.pitch + 1)
  const right = Math.floor(grid.ox + (footprint.col + footprint.w) * grid.pitch - 1)
  const bottom = Math.floor(grid.oy + (footprint.row + footprint.h) * grid.pitch - 1)
  const y = Math.floor(grid.oy + (footprint.row + footprint.h) * grid.pitch - grid.pitch * 0.34)
  const crop = checkedCrop({ x, y, w: right - x, h: bottom - y }, size)
  if (crop.x + crop.w > 65_536 || crop.y + crop.h > 65_536)
    throw new Error('The quantity crop exceeds the evidence coordinate budget')
  return crop
}

/** No digit whitelist, character substitution, implicit one, or ratio stripping. */
export function parseQuantityWords(words: OcrWord[], maximum: number): Pick<QuantityReading, 'quantity'> & Pick<QuantityEvidence, 'text' | 'confidence' | 'status'> {
  const nonempty = words.filter((word) => word.text.trim())
  const ordered = nonempty.slice(0, 17).sort((a, b) => a.x0 - b.x0)
  const raw = ordered.map((word) => word.text.trim()).join(' ')
  const text = Array.from(raw).slice(0, 256).join('')
  const scores = ordered.map((word) => word.conf)
  const confidence = scores.length && scores.every((score) => Number.isFinite(score) && score >= 0 && score <= 100)
    ? Math.min(...scores) : null
  const reject = (status: QuantityStatus) => ({ quantity: null, text, confidence, status })
  if (!raw) return reject('no-text')
  if (raw.length > 256 || nonempty.length > 16
    || ordered.some((word) => ![word.x0, word.y0, word.x1, word.y1].every(Number.isFinite)
      || word.x1 <= word.x0 || word.y1 <= word.y0)
    || Math.max(...ordered.map((word) => word.y0)) >= Math.min(...ordered.map((word) => word.y1)))
    return reject('ambiguous')
  // Thousands groups may be separated by spaces; arbitrary split digits may not.
  if (!/^[1-9]\d*$/.test(raw) && !/^[1-9]\d{0,2}(?:[ \u00a0]\d{3})+$/.test(raw))
    return reject('ambiguous')
  const quantity = Number(raw.replace(/[ \u00a0]/g, ''))
  if (!Number.isSafeInteger(maximum) || maximum <= 1 || maximum > 0xffff_ffff
    || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > maximum)
    return reject('out-of-range')
  if (confidence === null || confidence < MIN_CONFIDENCE) return reject('low-confidence')
  return { quantity, text, confidence, status: 'candidate' }
}

interface Region {
  index: number
  itemId: string
  crop: ImageCrop
  maximum: number
  scale: number
  top: number
  width: number
  height: number
}

/** One bounded, separate OCR pass after matching. Results are never confirmed facts. */
export async function readStackQuantities(
  image: Blob,
  grid: Grid,
  detections: Detection[],
  items: ItemsById,
  isCurrent: () => boolean = () => true,
): Promise<QuantityReport> {
  const checkCurrent = () => {
    if (!isCurrent()) throw new DOMException('Quantity read was cancelled', 'AbortError')
  }
  checkCurrent()
  const report: QuantityReport = { readings: new Map(), eligible: 0, attempted: 0, skipped: 0, suggested: 0 }
  const eligible = detections.flatMap((det, index) =>
    canReadQuantity(items[det.itemId], det) ? [{ det, index, maximum: items[det.itemId].stackMaxSize as number }] : [],
  )
  report.eligible = eligible.length
  if (!eligible.length) return report
  const source = await createImageBitmap(image)
  const regions: Region[] = []
  let atlasWidth = 0
  let atlasHeight = 0
  let canvas: OffscreenCanvas | undefined
  try {
    checkCurrent()
    checkedCrop(null, source)
    for (const { det, index, maximum } of eligible) {
      if (regions.length >= MAX_REGIONS) { report.skipped++; continue }
      let crop: ImageCrop
      try { crop = quantityCrop(grid, det, source) } catch { report.skipped++; continue }
      const scale = grid.pitch < 100 ? 4 : 2
      const width = crop.w * scale
      const height = crop.h * scale
      const nextWidth = Math.max(atlasWidth, width + 2 * PAD)
      const nextHeight = atlasHeight + height + 2 * PAD
      if (nextWidth > MAX_ATLAS_WIDTH || nextHeight > MAX_ATLAS_HEIGHT || nextWidth * nextHeight > MAX_ATLAS_PIXELS) {
        report.skipped++
        continue
      }
      regions.push({ index, itemId: det.itemId, crop, maximum, scale, top: atlasHeight + PAD, width, height })
      atlasWidth = nextWidth
      atlasHeight = nextHeight
    }
    if (!regions.length) return report
    canvas = new OffscreenCanvas(atlasWidth, atlasHeight)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Cannot create the stack quantity image')
    context.fillStyle = '#000'
    context.fillRect(0, 0, atlasWidth, atlasHeight)
    context.imageSmoothingEnabled = false
    for (const region of regions) {
      const { crop, top, width, height } = region
      context.drawImage(source, crop.x, crop.y, crop.w, crop.h, PAD, top, width, height)
    }
  } finally {
    source.close()
  }
  checkCurrent()
  const atlas = await canvas.convertToBlob({ type: 'image/png' })
  const { readWords } = await import('./ocr')
  const words = await readWords(atlas, null, { scale: 1, isCurrent })
  checkCurrent()
  for (const region of regions) {
    // Padding separates strips. A word crossing the source strip is ambiguous.
    const found = words.filter((word) => {
      const center = (word.y0 + word.y1) / 2
      return center >= region.top - PAD && center < region.top + region.height + PAD
    })
    const parsed = parseQuantityWords(found, region.maximum)
    if (found.some((word) => word.x0 < PAD || word.x1 > PAD + region.width
      || word.y0 < region.top || word.y1 > region.top + region.height)) {
      parsed.quantity = null
      parsed.status = 'ambiguous'
    }
    report.readings.set(region.index, {
      quantity: parsed.quantity,
      evidence: { method: 'bottom-strip-v1', itemId: region.itemId, text: parsed.text, confidence: parsed.confidence,
        status: parsed.status, maxQuantity: region.maximum, crop: region.crop },
    })
    if (parsed.quantity !== null) report.suggested++
  }
  report.attempted = regions.length
  return report
}
