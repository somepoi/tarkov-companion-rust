import { decodeScreenshot } from './imageBudget'
import { checkedCrop, type ImageCrop } from './registration'

import { TEXT_PAD as PAD } from './ocrPreparationConstants'
export interface TextPreparationOptions {
  threshold?: number | 'auto'
  scale?: 1 | 2 | 4
}
export interface PreparedText {
  png: Blob
  area: ImageCrop
  scale: number
}
export interface TextPreparationRequest {
  image: Blob
  crop: ImageCrop | null
  options: TextPreparationOptions
}
export type TextPreparationResponse = { result: PreparedText } | { error: string }

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

/** Runs in a disposable worker; keep pixel arithmetic identical to the original reader. */
export async function prepareTextPixels(image: Blob, crop: ImageCrop | null, opts: TextPreparationOptions): Promise<PreparedText> {
  const bitmap = await decodeScreenshot(image)
  let area: ImageCrop
  let src: OffscreenCanvas
  let sctx: OffscreenCanvasRenderingContext2D
  try {
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
  return { png, area, scale }
}
