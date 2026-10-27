import type { Grid } from './core'

export interface ImageSize { width: number; height: number }
export interface ImageCrop { x: number; y: number; w: number; h: number }

const MAX_PIXELS = 40_000_000

export function checkedCrop(crop: ImageCrop | null, size: ImageSize): ImageCrop {
  const area = crop ?? { x: 0, y: 0, w: size.width, h: size.height }
  if (![size.width, size.height, area.x, area.y, area.w, area.h].every(Number.isSafeInteger)
    || size.width < 1 || size.height < 1 || size.width * size.height > MAX_PIXELS
    || area.x < 0 || area.y < 0 || area.w < 1 || area.h < 1
    || area.x + area.w > size.width || area.y + area.h > size.height)
    throw new Error('Select an area inside the screenshot. Images must contain at most 40 million pixels.')
  return { ...area }
}

/** The registration is in full-image pixels; the worker translates it once. */
export function checkedGrid(grid: Grid, crop: ImageCrop): Grid {
  if (![grid.pitch, grid.ox, grid.oy].every(Number.isFinite)
    || grid.pitch < 1 || grid.pitch > 8192
    || ![grid.cols, grid.rows].every(Number.isSafeInteger)
    || grid.cols < 1 || grid.cols > 256 || grid.rows < 1 || grid.rows > 256)
    throw new Error('Enter a valid grid origin, cell size and container dimensions.')
  const epsilon = 0.000001
  if (grid.ox < crop.x - epsilon || grid.oy < crop.y - epsilon
    || grid.ox + grid.cols * grid.pitch + 1 > crop.x + crop.w + epsilon
    || grid.oy + grid.rows * grid.pitch + 1 > crop.y + crop.h + epsilon)
    throw new Error('The complete container grid must fit inside the selected screenshot area.')
  return { ...grid }
}

export function cropForGrid(grid: Grid, size: ImageSize): ImageCrop {
  const full = checkedCrop(null, size)
  checkedGrid(grid, full)
  return checkedCrop({
    x: Math.floor(grid.ox),
    y: Math.floor(grid.oy),
    w: Math.ceil(grid.ox + grid.cols * grid.pitch + 1) - Math.floor(grid.ox),
    h: Math.ceil(grid.oy + grid.rows * grid.pitch + 1) - Math.floor(grid.oy),
  }, size)
}
