/**
 * The stash cell size (pixels) from the last scan that matched well. Snips come in any
 * size, but the game draws cells at one size per resolution/UI scale, so the next scan
 * tries this size first and keeps it whenever it fits the new image at least as well.
 * After a resolution change it stops fitting and the scanner measures afresh.
 */
const KEY = 'tc-scan-cell-size'

export function rememberedCellSize(): number | undefined {
  try {
    const v = Number(localStorage.getItem(KEY))
    return v >= 20 && v <= 300 ? v : undefined
  } catch {
    return undefined
  }
}

/** Saves the cell size when the scan clearly worked (enough confident matches). */
export function rememberCellSize(pitch: number, sure: number, total: number): void {
  if (sure < 4 || sure < total * 0.6) return
  try {
    localStorage.setItem(KEY, pitch.toFixed(3))
  } catch {
    // storage unavailable: the scanner just measures every image
  }
}

/** The user fixed the grid by hand (Manual tuning): keep this cell size for the next snips. */
export function keepCellSize(pitch: number): void {
  if (!(pitch >= 20 && pitch <= 300)) return
  try {
    localStorage.setItem(KEY, pitch.toFixed(3))
  } catch {
    // storage unavailable: the scanner just measures every image
  }
}
