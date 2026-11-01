/** Exact-pixel descriptor reuse only. Detections, scores, OCR and facts are never cached here. */
import { sampleRegion, type Grid, type Rgba } from './core'

const TILE = 32
const MAX_BYTES = 8 * 1024 * 1024
const MAX_ENTRIES = 4096
type SampleArgs = [x: number, y: number, width: number, height: number, outputWidth: number, outputHeight: number]
export type RegionSampler = (...args: SampleArgs) => Float32Array
export interface RegionFrame {
  scope: string
  geometry: string
  image: Rgba
  samples: Map<string, Float32Array>
}

export function prepareRegionReuse(image: Rgba, grid: Grid, scope: string, previous?: RegionFrame) {
  const geometry = JSON.stringify([image.width, image.height, grid.ox, grid.oy, grid.pitch, grid.cols, grid.rows])
  const old = previous?.scope === scope && previous.geometry === geometry ? previous : undefined
  const columns = Math.ceil(image.width / TILE)
  const changed = new Uint8Array(columns * Math.ceil(image.height / TILE))
  if (old) {
    // Detect RGBA changes, including text/count/FIR strips and cell borders.
    // A tile marked changed invalidates every sample touching it; no perceptual threshold.
    const a = image.data, b = old.image.data
    for (let y = 0; y < image.height; y++) {
      const row = Math.floor(y / TILE) * columns
      for (let x = 0; x < image.width; x++) {
        const tile = row + Math.floor(x / TILE)
        if (changed[tile]) continue
        const i = (y * image.width + x) * 4
        if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) changed[tile] = 1
      }
    }
  }
  const frame: RegionFrame = { scope, geometry, image, samples: new Map() }
  const stats = { reused: 0, computed: 0 }
  let bytes = 0
  const sample: RegionSampler = (...args) => {
    const [x, y, width, height, outputWidth, outputHeight] = args
    const key = args.join(',')
    const remembered = old?.samples.get(key)
    let unchanged = Boolean(remembered)
    if (unchanged) {
      // Mirror the sampler's final interval arithmetic, with one conservative
      // guard pixel for floating-point boundaries. Clamping matches sampleRegion.
      const right = x + (outputWidth - 1) * (width / outputWidth) + width / outputWidth
      const bottom = y + (outputHeight - 1) * (height / outputHeight) + height / outputHeight
      const x0 = Math.max(0, Math.floor(x) - 1), y0 = Math.max(0, Math.floor(y) - 1)
      const x1 = Math.min(image.width, Math.ceil(Math.max(x + width, right)) + 1)
      const y1 = Math.min(image.height, Math.ceil(Math.max(y + height, bottom)) + 1)
      for (let ty = Math.floor(y0 / TILE); ty <= Math.floor((y1 - 1) / TILE) && unchanged; ty++) {
        for (let tx = Math.floor(x0 / TILE); tx <= Math.floor((x1 - 1) / TILE); tx++) {
          if (changed[ty * columns + tx]) { unchanged = false; break }
        }
      }
    }
    const result = unchanged ? remembered! : sampleRegion(image, ...args)
    if (unchanged) stats.reused++
    else stats.computed++
    // Own only this frame's used descriptors. Exhausting the budget falls back
    // to fresh sampling; it cannot skip candidates or change match decisions.
    if (!frame.samples.has(key) && frame.samples.size < MAX_ENTRIES && bytes + result.byteLength <= MAX_BYTES) {
      frame.samples.set(key, result)
      bytes += result.byteLength
    }
    return result
  }
  return { sample, frame, stats }
}
