/// <reference lib="webworker" />
import { decodeScreenshot } from '../scan/imageBudget'
import type { AlignmentAnchor, AlignmentRequest, AlignmentResponse, AlignmentSource } from './alignViewPixels'
import { checkedCrop, checkedGrid } from '../scan/registration'

const integer = (value: number, minimum: number, maximum: number) => Number.isSafeInteger(value) && value >= minimum && value <= maximum
const validSize = (source: { columns: number; rows: number }) => integer(source.columns, 1, 256) && integer(source.rows, 1, 256)

async function patches(source: AlignmentSource, budget: { remaining: number }): Promise<Map<string, AlignmentAnchor>> {
  if (!validSize(source) || source.anchors.length > 128 || source.image.size > 64 * 1024 * 1024)
    throw new Error('Position hint exceeds image or anchor limits. Enter the position manually.')
  const bitmap = await decodeScreenshot(source.image)
  try {
    const full = checkedCrop(null, bitmap)
    const canvas = new OffscreenCanvas(1, 1)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Position hints require image processing support. Enter the position manually.')
    const unique = new Map<string, AlignmentAnchor>()
    const duplicates = new Set<string>()
    for (const anchor of source.anchors) {
      const grid = checkedGrid(anchor.grid, full)
      if (grid.cols !== source.columns || grid.rows !== source.rows
        || !integer(anchor.column, 0, source.columns - 1) || !integer(anchor.row, 0, source.rows - 1)
        || !integer(anchor.width, 1, source.columns - anchor.column) || !integer(anchor.height, 1, source.rows - anchor.row))
        throw new Error('Reviewed footprints have incompatible pixel registration. Enter the position manually.')
      const x = Math.round(grid.ox + anchor.column * grid.pitch) + 2
      const y = Math.round(grid.oy + anchor.row * grid.pitch) + 2
      const width = Math.round(anchor.width * grid.pitch) - 4
      const height = Math.round(anchor.height * grid.pitch) - 4
      const pixels = width * height
      if (width < 1 || height < 1 || pixels > 1_000_000 || pixels > budget.remaining)
        throw new Error('A reviewed pixel patch exceeds position-hint limits. Enter the position manually; no partial hint was used.')
      checkedCrop({ x, y, w: width, h: height }, bitmap)
      budget.remaining -= pixels
      canvas.width = width; canvas.height = height
      context.drawImage(bitmap, x, y, width, height, 0, 0, width, height)
      const data = context.getImageData(0, 0, width, height).data
      let low = 765, high = 0
      for (let at = 0; at < data.length; at += 4) {
        const brightness = data[at] + data[at + 1] + data[at + 2]
        low = Math.min(low, brightness); high = Math.max(high, brightness)
      }
      if (high - low < 48) continue
      const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(data))
      const hash = `${anchor.width}:${anchor.height}:${width}:${height}:` + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
      if (unique.has(hash)) { unique.delete(hash); duplicates.add(hash) }
      else if (!duplicates.has(hash)) unique.set(hash, anchor)
    }
    return unique
  } finally { bitmap.close() }
}

async function align(request: AlignmentRequest): Promise<AlignmentResponse> {
  const { current, reference, container } = request
  if (!validSize(container) || !validSize(reference) || !validSize(current)
    || current.columns > container.columns || current.rows > container.rows
    || !integer(reference.column, 0, container.columns - reference.columns)
    || !integer(reference.row, 0, container.rows - reference.rows))
    throw new Error('View dimensions do not fit this container. Enter the position manually.')
  const budget = { remaining: 16_000_000 }
  const left = await patches(reference, budget)
  const right = await patches(current, budget)
  const offsets = new Map<string, { column: number; row: number; matches: AlignmentAnchor[] }>()
  for (const [hash, anchor] of right) {
    const prior = left.get(hash)
    if (!prior) continue
    const column = reference.column + prior.column - anchor.column
    const row = reference.row + prior.row - anchor.row
    const key = `${column}:${row}`
    const group = offsets.get(key) ?? { column, row, matches: [] }
    group.matches.push(anchor); offsets.set(key, group)
  }
  const group = offsets.size === 1 ? [...offsets.values()][0] : undefined
  if (!group || group.matches.length < 3 || new Set(group.matches.map((anchor) => anchor.column)).size < 2
    || new Set(group.matches.map((anchor) => anchor.row)).size < 2)
    return { proposal: null, message: 'No unambiguous position: need at least three distinct exact pixel matches across multiple rows and columns, all agreeing on one offset. Enter the position manually.' }
  const { column, row } = group
  if (!integer(column, 0, container.columns - current.columns) || !integer(row, 0, container.rows - current.rows))
    return { proposal: null, message: 'Pixel matches place part of the view outside this container. Check the selected source, layout and dimensions manually.' }
  const overlapColumns = Math.max(0, Math.min(column + current.columns, reference.column + reference.columns) - Math.max(column, reference.column))
  const overlapRows = Math.max(0, Math.min(row + current.rows, reference.row + reference.rows) - Math.max(row, reference.row))
  return { proposal: { column, row, matchedPatches: group.matches.length, overlapCells: overlapColumns * overlapRows },
    message: 'Position hint only. Check the same unchanged container and resolve overlap authority separately.' }
}

self.onmessage = (event: MessageEvent<AlignmentRequest>) => {
  void align(event.data).then((result) => self.postMessage(result))
    .catch((error: unknown) => self.postMessage({ error: error instanceof Error ? error.message : String(error) }))
}
