/**
 * Stash screenshot scanner: pure functions on raw RGBA pixels, shared by the
 * build script (fingerprints from tarkov.dev grid images) and the in-app worker.
 *
 * How it works
 * 1. Every item has a tarkov.dev "grid image": exactly what the game draws in a
 *    stash (background tint, icon, short name). Each is reduced to a small RGB
 *    fingerprint of FP pixels per cell.
 * 2. The screenshot's grid (cell pitch and offset) is found from the faint cell
 *    lines, so any resolution / UI scale works.
 * 3. Every grid position and item footprint is sampled the same way and compared
 *    with the fingerprints of that footprint (and rotated items). The best
 *    non-overlapping matches win.
 */

/** Fingerprint resolution: pixels per cell side. */
export const FP = 12

export interface Rgba {
  width: number
  height: number
  data: Uint8Array | Uint8ClampedArray
}

/**
 * Area-averaged resample of the box [x0, x0+w) × [y0, y0+h) (float coords) into
 * outW × outH RGB. Same function for fingerprints and screenshot regions, so both
 * sides blur identically.
 */
export function sampleRegion(img: Rgba, x0: number, y0: number, w: number, h: number, outW: number, outH: number, out?: Float32Array): Float32Array {
  const res = out ?? new Float32Array(outW * outH * 3)
  const sx = w / outW
  const sy = h / outH
  const { width, height, data } = img
  for (let oy = 0; oy < outH; oy++) {
    const ya = y0 + oy * sy
    const yb = ya + sy
    const iy0 = Math.max(0, Math.floor(ya))
    const iy1 = Math.min(height, Math.ceil(yb))
    for (let ox = 0; ox < outW; ox++) {
      const xa = x0 + ox * sx
      const xb = xa + sx
      const ix0 = Math.max(0, Math.floor(xa))
      const ix1 = Math.min(width, Math.ceil(xb))
      let r = 0
      let g = 0
      let b = 0
      let wsum = 0
      for (let y = iy0; y < iy1; y++) {
        const wy = Math.min(y + 1, yb) - Math.max(y, ya)
        if (wy <= 0) continue
        for (let x = ix0; x < ix1; x++) {
          const wx = Math.min(x + 1, xb) - Math.max(x, xa)
          if (wx <= 0) continue
          const wgt = wx * wy
          const i = (y * width + x) * 4
          r += data[i] * wgt
          g += data[i + 1] * wgt
          b += data[i + 2] * wgt
          wsum += wgt
        }
      }
      const o = (oy * outW + ox) * 3
      if (wsum > 0) {
        res[o] = r / wsum
        res[o + 1] = g / wsum
        res[o + 2] = b / wsum
      } else {
        res[o] = res[o + 1] = res[o + 2] = 0
      }
    }
  }
  return res
}

/** Rotates an RGB fingerprint (w × h pixels) 90° clockwise into h × w. */
export function rotateCW(src: Uint8Array | Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 3
      // (x, y) -> (h - 1 - y, x) in an h-wide image
      const di = (x * h + (h - 1 - y)) * 3
      out[di] = src[si]
      out[di + 1] = src[si + 1]
      out[di + 2] = src[si + 2]
    }
  }
  return out
}

/**
 * Pixels to ignore when comparing: the bottom strip of the item, where the game
 * draws stack counts, durability ("60/60") and the found-in-raid tick that the
 * grid images do not have. For rotated items the short-name strip at the top is
 * ignored too (the game keeps the text horizontal while the icon turns).
 */
export function compareMask(wCells: number, hCells: number, rotated: boolean): Uint8Array {
  const W = wCells * FP
  const H = hCells * FP
  const mask = new Uint8Array(W * H)
  const bottom = H - Math.round(FP * 0.3)
  const top = rotated ? Math.round(FP * 0.25) : 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // Outer 1-px frame: selection/hover borders differ between game and image.
      const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1
      mask[y * W + x] = edge || y >= bottom || y < top ? 0 : 1
    }
  }
  return mask
}

/** Mean absolute difference per channel over unmasked pixels (0..255). */
export function distance(a: Float32Array, b: Uint8Array | Float32Array, mask: Uint8Array, cutoff = Infinity): number {
  let sum = 0
  let n = 0
  const limit = cutoff * mask.length * 3
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue
    const i = p * 3
    sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])
    n += 3
    if (sum > limit) return Infinity
  }
  return n ? sum / n : Infinity
}

// ---------------------------------------------------------------------------
// Grid detection
// ---------------------------------------------------------------------------

export interface Grid {
  /** Cell pitch in screenshot pixels (cell plus one border line). */
  pitch: number
  /** Position of the first grid line. */
  ox: number
  oy: number
  cols: number
  rows: number
}

/** Edge strength profile along one axis (sum of brightness changes across the other axis). */
function edgeProfile(img: Rgba, axis: 'x' | 'y'): Float32Array {
  const { width, height, data } = img
  const len = axis === 'x' ? width : height
  const prof = new Float32Array(len)
  const lum = (x: number, y: number) => {
    const i = (y * width + x) * 4
    return data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
  }
  if (axis === 'x') {
    for (let y = 0; y < height; y += 2) for (let x = 1; x < width - 1; x++) prof[x] += Math.abs(lum(x + 1, y) - lum(x - 1, y))
  } else {
    for (let x = 0; x < width; x += 2) for (let y = 1; y < height - 1; y++) prof[y] += Math.abs(lum(x, y + 1) - lum(x, y - 1))
  }
  return prof
}

/** Line score (and best offset) for every candidate pitch along one axis. */
function periodScores(prof: Float32Array, pitches: number[]): { pitch: number; offset: number; score: number }[] {
  const len = prof.length
  let mean = 0
  for (const v of prof) mean += v
  mean /= len
  const at = (pos: number) => {
    const i = Math.round(pos)
    // Lines are 1-2 px wide after anti-aliasing: take the strongest of the neighbourhood.
    return Math.max(prof[i - 1] ?? 0, prof[i] ?? 0, prof[i + 1] ?? 0)
  }
  const results: { pitch: number; offset: number; score: number }[] = []
  for (const p of pitches) {
    let best = -Infinity
    let bestOff = 0
    for (let off = 0; off < p; off += 0.5) {
      let s = 0
      let k = 0
      for (let pos = off; pos < len - 1; pos += p) {
        s += at(pos)
        k++
      }
      if (k < 3) continue
      const score = s / k - mean
      if (score > best) {
        best = score
        bestOff = off
      }
    }
    results.push({ pitch: p, offset: bestOff, score: best })
  }
  return results
}

/** Finds the stash cell grid. `hintPitch` narrows the search (e.g. from a previous scan). */
export function detectGrid(img: Rgba, hintPitch?: number): Grid {
  const minP = hintPitch ? hintPitch * 0.97 : Math.max(32, img.height / 40)
  // Small crops (a 3-row container) still need room for the real pitch: use the longer side.
  const maxP = hintPitch ? hintPitch * 1.03 : Math.min(160, Math.max(img.width, img.height) / 3)
  const range = (lo: number, hi: number) => {
    const out: number[] = []
    for (let p = lo; p <= hi; p += 0.05) out.push(p)
    return out
  }
  // Multiples of the true pitch score as high as the pitch itself: take the smallest strong one.
  const pick = (list: { pitch: number; offset: number; score: number }[]) => {
    const top = Math.max(...list.map((r) => r.score))
    return list.find((r) => r.score >= top * 0.92) ?? list[0]
  }
  const px = pick(periodScores(edgeProfile(img, 'x'), range(minP, maxP)))
  // Same pitch both ways: search y only around the x result.
  const py = pick(periodScores(edgeProfile(img, 'y'), range(px.pitch * 0.98, px.pitch * 1.02)))
  const pitch = hintPitch ? hintPitch : (px.pitch + py.pitch) / 2
  // With a known pitch (a selection inside an already-scanned screenshot), only the offsets are searched.
  const ox = hintPitch ? periodScores(edgeProfile(img, 'x'), [hintPitch])[0].offset : px.offset
  const oy = hintPitch ? periodScores(edgeProfile(img, 'y'), [hintPitch])[0].offset : py.offset
  const cols = Math.floor((img.width - ox) / pitch)
  const rows = Math.floor((img.height - oy) / pitch)
  return { pitch, ox, oy, cols, rows }
}

/** Offsets along one axis whose lines are strongest (local maxima), best first. */
function offsetCandidates(prof: Float32Array, pitch: number, count: number): number[] {
  const scored: { off: number; score: number }[] = []
  for (let off = 0; off < pitch; off += 1) {
    let sum = 0
    let k = 0
    for (let pos = off; pos < prof.length - 1; pos += pitch) {
      const i = Math.round(pos)
      sum += Math.max(prof[i - 1] ?? 0, prof[i] ?? 0, prof[i + 1] ?? 0)
      k++
    }
    scored.push({ off, score: k ? sum / k : 0 })
  }
  const peaks = scored.filter((c, i) => c.score >= (scored[i - 1]?.score ?? -1) && c.score >= (scored[(i + 1) % scored.length]?.score ?? -1))
  return peaks.sort((a, b) => b.score - a.score).slice(0, count).map((c) => c.off)
}

/**
 * Small grids (a selected container) have few lines, and item name text can look
 * like a grid line. Try the strongest line positions and keep the alignment where
 * 1x1 items match best on average.
 */
export function refineGrid(img: Rgba, grid: Grid, candidates: Map<string, Candidate[]>): Grid {
  const xs = offsetCandidates(edgeProfile(img, 'x'), grid.pitch, 4)
  const ys = offsetCandidates(edgeProfile(img, 'y'), grid.pitch, 4)
  const ones = candidates.get('1x1') ?? []
  const mask = compareMask(1, 1, false)
  let best = { grid, score: Infinity }
  for (const ox of xs) {
    for (const oy of ys) {
      const cols = Math.floor((img.width - ox) / grid.pitch)
      const rows = Math.floor((img.height - oy) / grid.pitch)
      if (cols < 1 || rows < 1) continue
      const errs: number[] = []
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const region = sampleRegion(img, ox + c * grid.pitch, oy + r * grid.pitch, grid.pitch + 1, grid.pitch + 1, FP, FP)
          let e = Infinity
          for (const cand of ones) {
            if (cand.rotated) continue
            e = Math.min(e, distance(region, cand.fp, mask, e))
          }
          errs.push(e)
        }
      }
      // Average of the better half: big items and empty slots don't match 1x1 pictures anyway.
      errs.sort((a, b) => a - b)
      const half = errs.slice(0, Math.max(1, Math.ceil(errs.length / 2)))
      const score = half.reduce((a, b) => a + b, 0) / half.length
      if (score < best.score) best = { grid: { ...grid, ox, oy, cols, rows }, score }
    }
  }
  return best.grid
}

/**
 * Robust grid finding. Grid lines alone can mislead (long items and highlighted
 * slots hide lines, so a wrong period can score best), so the line analysis only
 * proposes a few cell sizes and offsets; each proposal is then judged by how well
 * real items line up with it: the grid where the sampled cells look most like
 * actual item pictures wins.
 */
/** Cell pitch ÷ height of the printed item names (measured on real screenshots: 8.4). */
const PITCH_PER_NAME_HEIGHT = 8.4

/**
 * Cell size from the item names read by OCR: names are printed at a fixed size relative
 * to the slot (pitch ≈ 8.4 × letter height) and sit flush with each slot's right edge
 * and top, so their right edges and tops repeat exactly every pitch. The letter height
 * gives a rough size (±25%, which rules out half/double grids); the repeat gives the
 * exact one. Null when there are too few readable names.
 */
export function pitchFromWords(words: OcrWord[] | undefined): { pitch: number; strength: number; estimate: number } | null {
  // Two readable names already fix the size: their gap is a whole number of cells and the
  // letter height says which number.
  const names = (words ?? []).filter((w) => w.conf >= 45 && normName(w.text).length >= 3 && /[a-z]{2}/i.test(w.text))
  if (names.length < 2) return null
  // Height from the confident reads when there are enough of them (noise reads are often oddly sized).
  const sure = names.filter((w) => w.conf >= 70)
  const heights = (sure.length >= 2 ? sure : names).map((w) => w.y1 - w.y0).sort((a, b) => a - b)
  const est = PITCH_PER_NAME_HEIGHT * heights[heights.length >> 1]
  // Repeat strength: how tightly right edges (and tops) line up for a given pitch.
  const strength = (q: number) => {
    let cx = 0
    let sx = 0
    let cy = 0
    let sy = 0
    for (const w of names) {
      const ax = (2 * Math.PI * w.x1) / q
      const ay = (2 * Math.PI * w.y0) / q
      cx += Math.cos(ax)
      sx += Math.sin(ax)
      cy += Math.cos(ay)
      sy += Math.sin(ay)
    }
    return (Math.hypot(cx, sx) + Math.hypot(cy, sy)) / (2 * names.length)
  }
  let best = { pitch: est, strength: -1, estimate: est }
  for (let q = est * 0.75; q <= est * 1.25; q += 0.05) {
    const sc = strength(q)
    if (sc > best.strength) best = { pitch: q, strength: sc, estimate: est }
  }
  return best.strength >= 0.6 ? best : null
}

/**
 * Where the grid lines are, from the item names: a name ends 2.6% of a cell left of its slot's
 * right line and starts 6.2% of a cell below its top line (measured on five screenshots, all
 * within 0.5%). Line analysis alone can pick a wrong offset when big dark items (guns) draw
 * strong edges of their own.
 */
const NAME_RIGHT_INSET = 0.026
const NAME_TOP_INSET = 0.062
function offsetsFromWords(words: OcrWord[] | undefined, pitch: number): { ox: number; oy: number; agree: number } | null {
  const good = (words ?? []).filter((w) => w.conf >= 60 && normName(w.text).length >= 3)
  if (good.length < 3) return null
  let agree = 1
  const phase = (vals: number[]) => {
    let c = 0
    let sn = 0
    for (const v of vals) {
      c += Math.cos((2 * Math.PI * v) / pitch)
      sn += Math.sin((2 * Math.PI * v) / pitch)
    }
    const r = Math.hypot(c, sn) / vals.length
    if (r < 0.8) return null
    agree = Math.min(agree, r)
    return (((Math.atan2(sn, c) / (2 * Math.PI)) * pitch) % pitch + pitch) % pitch
  }
  // Only the last word of a name ("Hand drill") touches the slot's right edge.
  const last = good.filter((w) => !(words ?? []).some((o) => o !== w && Math.abs(o.y0 - w.y0) < 0.15 * pitch && o.x0 >= w.x1 - 2 && o.x0 - w.x1 < 0.15 * pitch))
  if (last.length < 3) return null
  const ox = phase(last.map((w) => w.x1 + NAME_RIGHT_INSET * pitch))
  const oy = phase(good.map((w) => w.y0 - NAME_TOP_INSET * pitch))
  return ox === null || oy === null ? null : { ox, oy, agree }
}

/**
 * @param preferred cell size from the previous confident scan. Snips differ in size but the
 *   game's cell size only changes with resolution/UI scale, so the remembered size is tried
 *   too and kept whenever it fits this image about as well as the freshly detected one.
 */
/** How much worse the remembered cell size may fit when no item names could be read. */
const NAMELESS_TOLERANCE = 1.5

export function chooseGrid(img: Rgba, candidates: Map<string, Candidate[]>, words?: OcrWord[], preferred?: number): Grid & { fit: number } {
  // No game resolution draws cells smaller than ~36 px (64 px at 1080p scales with the screen).
  const fromWords = pitchFromWords(words)
  // Names set the allowed range (rules out half / two-thirds / double grids); lines and item
  // fit still pick the exact size inside it.
  const minP = fromWords ? fromWords.pitch * 0.97 : Math.max(36, Math.min(img.width, img.height) / 40)
  // Without names, a snip must hold a few cells; with names even a one-slot snip works.
  const maxP = fromWords ? fromWords.pitch * 1.03 : Math.min(200, Math.max(img.width, img.height) / 3)
  const pitches: number[] = []
  for (let q = minP; q <= maxP; q += 0.1) pitches.push(q)
  const px = edgeProfile(img, 'x')
  const py = edgeProfile(img, 'y')
  const sx = periodScores(px, pitches)
  const sy = periodScores(py, pitches)
  const topX = Math.max(...sx.map((r) => (Number.isFinite(r.score) ? r.score : 0)), 1e-9)
  const topY = Math.max(...sy.map((r) => (Number.isFinite(r.score) ? r.score : 0)), 1e-9)
  const combined = pitches.map((q, i) => ({ pitch: q, score: (Number.isFinite(sx[i].score) ? sx[i].score / topX : 0) + (Number.isFinite(sy[i].score) ? sy[i].score / topY : 0) }))
  // Local maxima of the line score, strongest first, plus their halves and thirds (a period
  // two or three cells wide also scores well when lines are hidden).
  const peaks = combined.filter((c, i) => c.score >= (combined[i - 1]?.score ?? -1) && c.score >= (combined[i + 1]?.score ?? -1)).sort((a, b) => b.score - a.score)
  const proposals: number[] = []
  const addProposal = (q: number) => {
    if (q < minP || q > maxP) return
    if (proposals.some((o) => Math.abs(o - q) / q < 0.015)) return
    proposals.push(q)
  }
  if (fromWords) addProposal(fromWords.pitch)
  for (const peak of peaks.slice(0, 6)) {
    addProposal(peak.pitch)
    addProposal(peak.pitch / 2)
    addProposal(peak.pitch / 3)
  }

  const ones = (candidates.get('1x1') ?? []).filter((c) => !c.rotated && !c.negative)
  const mask = compareMask(1, 1, false)
  const scoreGrid = (pitch: number, ox: number, oy: number): number => {
    const cols = Math.floor((img.width - ox) / pitch)
    const rows = Math.floor((img.height - oy) / pitch)
    if (cols < 1 || rows < 1) return Infinity
    // Up to ~36 cells spread over the whole grid.
    const step = Math.max(1, Math.floor((cols * rows) / 36))
    const errs: number[] = []
    for (let k = 0; k < cols * rows; k += step) {
      const r = Math.floor(k / cols)
      const c = k % cols
      const region = sampleRegion(img, ox + c * pitch, oy + r * pitch, pitch + 1, pitch + 1, FP, FP)
      // Empty slots say nothing about alignment.
      let m = 0
      for (let i = 0; i < region.length; i++) m += region[i]
      m /= region.length
      let v = 0
      for (let i = 0; i < region.length; i++) v += (region[i] - m) ** 2
      if (Math.sqrt(v / region.length) < 10) continue
      const rm = meanColor(region, mask)
      let best = 40
      for (const cand of ones) {
        const md = (Math.abs(rm[0] - cand.mean[0]) + Math.abs(rm[1] - cand.mean[1]) + Math.abs(rm[2] - cand.mean[2])) / 3
        if (md >= best) continue
        const d = distance(region, cand.fp, mask, best)
        if (d < best) best = d
      }
      errs.push(best)
    }
    if (errs.length < Math.min(4, cols * rows)) return Infinity
    errs.sort((a, b) => a - b)
    // Better half: big items never match 1x1 pictures whatever the grid.
    const half = errs.slice(0, Math.ceil(errs.length / 2))
    return half.reduce((a, b) => a + b, 0) / half.length
  }

  let best = { pitch: proposals[0] ?? 64, ox: 0, oy: 0, score: Infinity }
  // A cell size at which the names do not line up is wrong when another size lines them up.
  const namedAt = new Map(proposals.map((q) => [q, offsetsFromWords(words, q)]))
  const bestAgree = Math.max(0, ...[...namedAt.values()].map((n) => n?.agree ?? 0))
  for (const q of proposals) {
    // Names line up best at the true size (a 1.7% wrong size drifts them by a quarter cell over 14 columns).
    if (bestAgree && (namedAt.get(q)?.agree ?? 0) < bestAgree - 0.03) continue
    // Names agreeing on the line positions beat the line analysis (dark gun pictures have
    // strong edges of their own and fit 1x1 pictures under a wrong grid about as well).
    const named = namedAt.get(q) ?? null
    const near = (o: number, n: number) => Math.min(Math.abs(o - n), q - Math.abs(o - n)) < 0.08 * q
    const oxs = named ? [named.ox, ...offsetCandidates(px, q, 3).filter((o) => near(o, named.ox))] : offsetCandidates(px, q, 3)
    const oys = named ? [named.oy, ...offsetCandidates(py, q, 3).filter((o) => near(o, named.oy))] : offsetCandidates(py, q, 3)
    for (const ox of oxs) {
      for (const oy of oys) {
        const sc = scoreGrid(q, ox, oy)
        if (sc < best.score) best = { pitch: q, ox, oy, score: sc }
      }
    }
  }
  // Precision: which items do the sampled slots resemble under the rough grid? Then nudge
  // pitch and offsets in sub-pixel steps, re-checking only those shortlisted items.
  const refine = (best: { pitch: number; ox: number; oy: number; score: number }, pitchScale = 1) => {
  const roughCols = Math.floor((img.width - best.ox) / best.pitch)
  const roughRows = Math.floor((img.height - best.oy) / best.pitch)
  const cells: { r: number; c: number; shortlist: Candidate[] }[] = []
  const stride = Math.max(1, Math.floor((roughCols * roughRows) / 64))
  for (let k = 0; k < roughCols * roughRows; k += stride) {
    const r = Math.floor(k / roughCols)
    const c = k % roughCols
    const region = sampleRegion(img, best.ox + c * best.pitch, best.oy + r * best.pitch, best.pitch + 1, best.pitch + 1, FP, FP)
    let m = 0
    for (let i = 0; i < region.length; i++) m += region[i]
    m /= region.length
    let v = 0
    for (let i = 0; i < region.length; i++) v += (region[i] - m) ** 2
    if (Math.sqrt(v / region.length) < 10) continue
    const scored = ones.map((cand) => ({ cand, d: distance(region, cand.fp, mask, 60) })).filter((x) => x.d < 60).sort((x, y) => x.d - y.d)
    if (scored.length) cells.push({ r, c, shortlist: scored.slice(0, 6).map((x) => x.cand) })
  }
  const fitScore = (pitch: number, ox: number, oy: number) => {
    const errs: number[] = []
    for (const cell of cells) {
      const region = sampleRegion(img, ox + cell.c * pitch, oy + cell.r * pitch, pitch + 1, pitch + 1, FP, FP)
      let e = Infinity
      for (const cand of cell.shortlist) e = Math.min(e, distance(region, cand.fp, mask, e))
      errs.push(e)
    }
    errs.sort((x, y) => x - y)
    const half = errs.slice(0, Math.max(1, Math.ceil(errs.length / 2)))
    return half.reduce((x, y) => x + y, 0) / half.length
  }
  let fine = { pitch: best.pitch, ox: best.ox, oy: best.oy, score: cells.length >= 4 ? fitScore(best.pitch, best.ox, best.oy) : Infinity }
  if (Number.isFinite(fine.score)) {
    // Coordinate descent: pitch, then x, then y, a few rounds with shrinking steps.
    for (const [pRange, pStep, oRange, oStep] of [[0.012 * pitchScale, 0.02, 4, 0.5], [0.003 * pitchScale, 0.005, 1, 0.125]]) {
      for (let round = 0; round < 2; round++) {
        const center = { ...fine }
        for (let q = center.pitch * (1 - pRange); q <= center.pitch * (1 + pRange); q += pStep) {
          const sc = fitScore(q, fine.ox, fine.oy)
          if (sc < fine.score) fine = { ...fine, pitch: q, score: sc }
        }
        for (let ox = center.ox - oRange; ox <= center.ox + oRange; ox += oStep) {
          const sc = fitScore(fine.pitch, ox, fine.oy)
          if (sc < fine.score) fine = { ...fine, ox, score: sc }
        }
        for (let oy = center.oy - oRange; oy <= center.oy + oRange; oy += oStep) {
          const sc = fitScore(fine.pitch, fine.ox, oy)
          if (sc < fine.score) fine = { ...fine, oy, score: sc }
        }
      }
    }
  }
  return fine
  }

  let result = refine(best)
  let fit = scoreGrid(result.pitch, result.ox, result.oy)
  if (preferred && Math.abs(preferred - result.pitch) / preferred > 0.015) {
    let start = { pitch: preferred, ox: 0, oy: 0, score: Infinity }
    // Only offsets that leave room for a whole cell (a one-column strip barely holds one).
    const fits = (offs: number[], size: number) => {
      const ok = offs.filter((o) => o + preferred <= size + 1)
      return ok.length ? ok : [Math.max(0, (size - preferred) / 2)]
    }
    for (const ox of fits(offsetCandidates(px, preferred, 6), img.width)) {
      for (const oy of fits(offsetCandidates(py, preferred, 6), img.height)) {
        const sc = scoreGrid(preferred, ox, oy)
        if (sc < start.score) start = { pitch: preferred, ox, oy, score: sc }
      }
    }
    if (Number.isFinite(start.score)) {
      // Refining can slide a one-cell strip off the image; then keep the unrefined start.
      const refined = refine(start, 0.4)
      const alt = Number.isFinite(scoreGrid(refined.pitch, refined.ox, refined.oy)) ? refined : start
      const altFit = scoreGrid(alt.pitch, alt.ox, alt.oy)
      // A wrong grid only wins on a fresh image by luck; on the same screen the remembered
      // size fits at least as well (checked on random snips), so it is kept on a tie or better.
      // Without readable names a half-size grid can fit narrow snips by chance (half an item
      // looks like a small item), so then the remembered size gets some slack.
      if (altFit <= fit * (fromWords ? 1 : NAMELESS_TOLERANCE)) {
        result = alt
        fit = altFit
      }
    }
  }
  return { pitch: result.pitch, ox: result.ox, oy: result.oy, cols: Math.floor((img.width - result.ox) / result.pitch), rows: Math.floor((img.height - result.oy) / result.pitch), fit }
}


// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export interface FingerprintIndex {
  /** Item ids in file order. */
  ids: string[]
  widths: Uint8Array
  heights: Uint8Array
  offsets: Uint32Array
  /** All fingerprints, RGB, FP px per cell. */
  pixels: Uint8Array
  /** 0 tarkov.dev picture, 1 shipped correction, 2 shipped confirmation, 3 shipped "not this item". */
  corrections?: Uint8Array
  /** English short name per entry (what the game prints on the item), for the name check. */
  names?: string[]
  /** 1 = a gun (base weapon or one of its ready-made builds). */
  guns?: Uint8Array
}

export interface Detection {
  itemId: string
  col: number
  row: number
  /** Footprint as seen on screen (after rotation). */
  w: number
  h: number
  rotated: boolean
  /** Mean absolute difference (lower is better). */
  error: number
  /** Next best different items for this spot, for "change item". */
  alternatives: { itemId: string; error: number }[]
  /** Matched one of the user's own corrections rather than a tarkov.dev picture. */
  learned?: boolean
  /** The printed short name read from the screenshot matches this item. */
  nameMatch?: boolean
  /** Only partly visible (cut off by the bottom of the screenshot); h is the visible part. */
  clipped?: boolean
  /** A gun found by its printed name only (a custom build no picture matches): the box size is a guess. */
  byName?: boolean
}

/** A reference taken from a real screenshot after the user corrected a match. */
export interface LearnedFingerprint {
  itemId: string
  /** Footprint exactly as it appeared on screen (rotation already applied). */
  w: number
  h: number
  /** RGB, FP px per cell, w*FP x h*FP. */
  fp: Uint8Array
  /**
   * correct   = the user picked this item for this look (a fixed mistake)
   * confirmed = the user kept an uncertain match (a success)
   * not       = this look is NOT itemId (the wrong guess from a fixed mistake)
   */
  kind?: 'correct' | 'confirmed' | 'not'
}

/**
 * Learned references win close calls: they come from the same game, resolution and
 * lighting. Fixed mistakes count more than confirmations.
 */
const LEARNED_BONUS = 1.5
const CONFIRMED_BONUS = 0.8
/** A region this close to a "not X" memory is the same look the user already rejected as X. */
const NOT_RADIUS = 9

export interface ScanOptions {
  /** Internal worker optimization; must be equivalent to sampleRegion on this image. */
  sample?: (x: number, y: number, width: number, height: number, outputWidth: number, outputHeight: number) => Float32Array
  /** Accept matches below this error (0..255 per channel). */
  maxError?: number
  /** Only these item ids (e.g. skip presets). */
  allow?: (id: string) => boolean
  /** Words read from the screenshot (OCR), in the same pixel coordinates as the image. */
  words?: OcrWord[]
}

export interface OcrWord {
  text: string
  /** 0..100 */
  conf: number
  x0: number
  y0: number
  x1: number
  y1: number
}

interface Candidate {
  idx: number
  itemId: string
  learned: boolean
  /** Error reduction for learned references. */
  bonus: number
  /** A "this look is not itemId" memory: never a match itself, only a penalty. */
  negative?: boolean
  /** Normalised short name (see normName), for the name check. */
  name?: string
  rotated: boolean
  fp: Uint8Array | Float32Array
  mean: [number, number, number]
  /** Pixels that belong to the item itself (icon + name), not its slot background; null if too few. */
  iconMask: Uint8Array | null
  iconMean: [number, number, number]
  /** A gun picture (mostly dark background, which reads as empty slots). */
  gun?: boolean
  /** Guns: the weapon's own pixels. Half of a gun's score comes from these, so plain dark
   *  background (an empty stash patch) does not pass for a gun picture. */
  gunMask?: Uint8Array | null
}

/** Guns are judged half on the whole picture, half on the weapon's own pixels. */
function gunAdjusted(err: number, region: Float32Array, c: Candidate): number {
  if (!c.gunMask || !Number.isFinite(err)) return err
  return (err + distance(region, c.fp, c.gunMask)) / 2
}

/** Extra error added to background-free matches, so a full match is preferred when both fit. */
const ICON_PENALTY = 4

/**
 * The item's own pixels: everything that differs clearly from the slot background
 * (estimated from the ring just inside the frame). Lets a match survive a tinted or
 * highlighted slot (e.g. a grey "BrokenLCD" slot vs the dark-blue reference).
 */
function iconMaskFor(fp: Uint8Array | Float32Array, w: number, h: number, base: Uint8Array, minShare = 0.4): Uint8Array | null {
  const W = w * FP
  const H = h * FP
  const ring: number[][] = [[], [], []]
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      if (x !== 1 && y !== 1 && x !== W - 2 && y !== H - 2) continue
      const i = (y * W + x) * 3
      for (let c = 0; c < 3; c++) ring[c].push(fp[i + c])
    }
  }
  const bg = ring.map((vals) => vals.sort((a, b) => a - b)[Math.floor(vals.length / 2)])
  const mask = new Uint8Array(base.length)
  let n = 0
  let total = 0
  for (let p = 0; p < base.length; p++) {
    if (!base[p]) continue
    total++
    const i = p * 3
    const d = Math.abs(fp[i] - bg[0]) + Math.abs(fp[i + 1] - bg[1]) + Math.abs(fp[i + 2] - bg[2])
    if (d > 36) {
      mask[p] = 1
      n++
    }
  }
  // Tiny icons would match random textures: only use this for substantial items.
  return n >= Math.max(24, total * minShare) ? mask : null
}

function meanColor(v: Uint8Array | Float32Array, mask: Uint8Array): [number, number, number] {
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue
    r += v[p * 3]
    g += v[p * 3 + 1]
    b += v[p * 3 + 2]
    n++
  }
  return n ? [r / n, g / n, b / n] : [0, 0, 0]
}

/** Groups fingerprints by on-screen footprint "WxH", adding rotated variants of non-square items. */
export function buildCandidates(index: FingerprintIndex, opts: ScanOptions = {}): Map<string, Candidate[]> {
  const groups = new Map<string, Candidate[]>()
  const push = (w: number, h: number, c: Candidate) => {
    const key = `${w}x${h}`
    const list = groups.get(key)
    if (list) list.push(c)
    else groups.set(key, [c])
  }
  for (let i = 0; i < index.ids.length; i++) {
    if (opts.allow && !opts.allow(index.ids[i])) continue
    const w = index.widths[i]
    const h = index.heights[i]
    const len = w * FP * h * FP * 3
    const fp = index.pixels.subarray(index.offsets[i], index.offsets[i] + len)
    const add = (cw: number, ch: number, rotated: boolean, f: Uint8Array | Float32Array) => {
      const base = compareMask(cw, ch, rotated)
      // Rotated thin items (stocks, barrels) match too much without their background.
      const iconMask = rotated ? null : iconMaskFor(f, cw, ch, base)
      const src = index.corrections?.[i] ?? 0
      const name = index.names?.[i] ? normName(index.names[i]) : undefined
      const gun = index.guns?.[i] === 1
      push(cw, ch, { gun, gunMask: gun ? iconMaskFor(f, cw, ch, base, 0.05) : null, name, idx: i, itemId: index.ids[i], learned: src === 1 || src === 2, negative: src === 3, bonus: src === 1 ? LEARNED_BONUS : src === 2 ? CONFIRMED_BONUS : 0, rotated, fp: f, mean: meanColor(f, base), iconMask, iconMean: iconMask ? meanColor(f, iconMask) : [0, 0, 0] })
    }
    add(w, h, false, fp)
    // Shipped user memories are already in on-screen orientation.
    if (w !== h && !index.corrections?.[i]) add(h, w, true, rotateCW(fp, w * FP, h * FP))
  }
  return groups
}

/** Base candidates plus the user's corrections (a new map; the base one is not modified). */
export function withLearned(base: Map<string, Candidate[]>, learned: LearnedFingerprint[]): Map<string, Candidate[]> {
  if (learned.length === 0) return base
  const out = new Map<string, Candidate[]>()
  const names = new Map<string, string>()
  for (const [k, v] of base) {
    out.set(k, [...v])
    for (const c of v) if (c.name && !names.has(c.itemId)) names.set(c.itemId, c.name)
  }
  for (const l of learned) {
    const key = `${l.w}x${l.h}`
    const mask = compareMask(l.w, l.h, false)
    const kind = l.kind ?? 'correct'
    const c: Candidate = {
      idx: -1,
      itemId: l.itemId,
      learned: kind !== 'not',
      bonus: kind === 'confirmed' ? CONFIRMED_BONUS : kind === 'correct' ? LEARNED_BONUS : 0,
      negative: kind === 'not',
      name: names.get(l.itemId),
      rotated: false,
      fp: l.fp,
      mean: meanColor(l.fp, mask),
      iconMask: null,
      iconMean: [0, 0, 0],
    }
    const list = out.get(key)
    if (list) list.push(c)
    else out.set(key, [c])
  }
  return out
}

const AREA_BONUS = 0.8
/** The size bonus never exceeds this, so a big poor match cannot beat several good small ones. */
const AREA_BONUS_MAX = 2
/**
 * Printed-name check. The game prints each item's short name in its top-right corner;
 * names survive icon redraws, so a matching name is strong evidence.
 */
const NAME_MATCH = 0.75
const NAME_BONUS = 10
/** When some candidate's name matches a confidently read label, the others lose this much. */
const NAME_PENALTY = 12
/** A label this close to an item's short name pins that item's top-right corner (see scanGrid). */
const ANCHOR_MATCH = 0.85

/** Lowercase, letters that OCR confuses mapped together (0/o, 1/l/i/|, 5/s), punctuation dropped. */
export function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/0/g, 'o')
    .replace(/[1i|!]/g, 'l')
    .replace(/5/g, 's')
    .replace(/[^a-z0-9]/g, '')
}

/** 1 = same, 0 = nothing in common (edit distance relative to the longer name). */
export function nameSimilarity(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  const m = a.length
  const n = b.length
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return 1 - prev[n] / Math.max(m, n)
}

/** A printed name. alt = the same words read with a wider word gap ("USP" + "45" → "USP .45"). */
type Label = { text: string; conf: number; alt?: string }
const labelSim = (label: Label, name: string): number => Math.max(nameSimilarity(label.text, name), label.alt ? nameSimilarity(label.alt, name) : 0)

/** Words in the top-right corner of a slot, keyed "row,col" (the slot the name belongs to). */
function nameLabels(words: OcrWord[] | undefined, grid: Grid): Map<string, Label> {
  const out = labelsWithGap(words, grid, 0.1)
  // Spaces before a dot or digit come out wider; a wider gap would glue neighbouring reads that
  // are fine apart ("SurvL"), so the wide reading is only an alternative.
  for (const [key, wide] of labelsWithGap(words, grid, 0.13)) {
    const l = out.get(key)
    if (l && wide.text !== l.text) l.alt = wide.text
  }
  return out
}

function labelsWithGap(words: OcrWord[] | undefined, grid: Grid, gap: number): Map<string, Label> {
  const out = new Map<string, Label>()
  // Names with spaces ("F scdr", "Hand drill") come back as separate words: join neighbours on
  // one line. Words of one line differ by a pixel or two in height, so group them into lines
  // first and read each line left to right (sorting by height alone let "Awl" further along the
  // line slip between "Hand" and "drill").
  const byHeight = [...(words ?? [])].sort((a, b) => a.y0 - b.y0)
  const lines: OcrWord[][] = []
  for (const w of byHeight) {
    const line = lines.find((l) => Math.abs(l[0].y0 - w.y0) < 0.15 * grid.pitch)
    if (line) line.push(w)
    else lines.push([w])
  }
  const sorted = lines.flatMap((l) => l.sort((a, b) => a.x0 - b.x0))
  const merged: OcrWord[] = []
  for (const w of sorted) {
    const prev = merged[merged.length - 1]
    // Same line, a space apart, and inside the same slot (neighbouring slots' names often touch).
    const slotOf = (x: number) => Math.floor((x - grid.ox) / grid.pitch - 0.02)
    // Never glue a clean read to junk read off the item's picture ("FENA" + "Poster").
    const junkPair = Math.min(prev?.conf ?? 0, w.conf) < 40 && Math.max(prev?.conf ?? 0, w.conf) >= 60
    if (prev && !junkPair && Math.abs(prev.y0 - w.y0) < 0.15 * grid.pitch && w.x0 >= prev.x1 - 2 && w.x0 - prev.x1 < gap * grid.pitch && slotOf(prev.x1) === slotOf(w.x1)) {
      merged[merged.length - 1] = { text: prev.text + w.text, conf: Math.min(prev.conf, w.conf), x0: prev.x0, y0: Math.min(prev.y0, w.y0), x1: w.x1, y1: Math.max(prev.y1, w.y1) }
    } else merged.push({ ...w })
  }
  for (const w of merged) {
    const text = normName(w.text)
    // Weak reads (junk around the letters) still count, but only for near-exact names (see below).
    if (text.length < 2 || (w.conf < 40 && text.length < 3)) continue
    const col = Math.floor((w.x1 - grid.ox) / grid.pitch - 0.02)
    const row = Math.floor((w.y0 - grid.oy) / grid.pitch)
    if (col < 0 || row < 0 || col >= grid.cols || row >= grid.rows) continue
    if (grid.ox + (col + 1) * grid.pitch - w.x1 > 0.35 * grid.pitch) continue // not right-aligned
    if (w.y0 - (grid.oy + row * grid.pitch) > 0.4 * grid.pitch) continue // not at the top (counts sit at the bottom)
    const key = `${row},${col}`
    const prev = out.get(key)
    if (!prev || w.conf > prev.conf) out.set(key, { text, conf: w.conf })
  }
  return out
}

/**
 * Empty slots: the plainest cells of the screenshot (lowest contrast) form an
 * "empty slot" template; any cell close to it is empty. A completely full grid
 * has no low-contrast cells, so nothing is marked empty.
 */
export function emptyCells(img: Rgba, grid: Grid): boolean[][] {
  const cells: { v: Float32Array; sd: number }[][] = []
  for (let r = 0; r < grid.rows; r++) {
    const rowCells: { v: Float32Array; sd: number }[] = []
    for (let c = 0; c < grid.cols; c++) {
      const v = sampleRegion(img, grid.ox + c * grid.pitch, grid.oy + r * grid.pitch, grid.pitch + 1, grid.pitch + 1, FP, FP)
      let m = 0
      for (let i = 0; i < v.length; i++) m += v[i]
      m /= v.length
      let q = 0
      for (let i = 0; i < v.length; i++) q += (v[i] - m) ** 2
      rowCells.push({ v, sd: Math.sqrt(q / v.length) })
    }
    cells.push(rowCells)
  }
  const plain = cells.flat().filter((c) => c.sd < 8)
  if (plain.length === 0) return cells.map((r) => r.map(() => false))
  const tpl = new Float32Array(FP * FP * 3)
  for (const c of plain) for (let i = 0; i < tpl.length; i++) tpl[i] += c.v[i] / plain.length
  const mask = compareMask(1, 1, false)
  return cells.map((r) => r.map((c) => c.sd < 10 && distance(c.v, tpl, mask) < 6))
}

/**
 * Guns by their printed name. A modded gun has a size and look no picture has (every stock,
 * scope and magazine changes it), but the game still prints the base weapon's short name in
 * its top-right corner. For a confidently read gun name with no picture match at that corner,
 * offer boxes of every plausible gun size anchored there: no empty slots and no other item's
 * name inside. Bigger boxes rank slightly better; the greedy pass keeps whatever fits around
 * the other items. Marked byName so the dialog asks the user to check the size.
 */
const GUN_NAME_MATCH = 0.85
const BY_NAME_ERROR = 21
function gunsByName(grid: Grid, labels: Map<string, Label>, index: FingerprintIndex, empty: boolean[][], found: Detection[]): Detection[] {
  if (!index.guns || !index.names) return []
  const gunNames = new Map<string, string>()
  index.ids.forEach((id, i) => {
    if (index.guns?.[i] && index.names?.[i]) gunNames.set(normName(index.names[i]), id)
  })
  const out: Detection[] = []
  for (const [key, label] of labels) {
    if (label.conf < 50 || label.text.length < 3) continue
    let best: { id: string; sim: number } | null = null
    for (const [name, id] of gunNames) {
      const sim = labelSim(label, name)
      if (sim >= GUN_NAME_MATCH && (!best || sim > best.sim)) best = { id, sim }
    }
    if (!best) continue
    const [row, rightCol] = key.split(',').map(Number)
    // A picture already matched this gun at this corner: nothing to add.
    if (found.some((d) => d.itemId === best.id && d.row === row && d.col + d.w - 1 === rightCol && d.error <= 18)) continue
    for (let h = 1; h <= 3; h++) {
      for (let w = 2; w <= 8; w++) {
        const col = rightCol - w + 1
        if (col < 0 || row + h > grid.rows) continue
        let ok = true
        for (let y = row; y < row + h && ok; y++) {
          for (let x = col; x < col + w && ok; x++) {
            if (empty[y][x]) ok = false
            else if ((y !== row || x !== rightCol) && labels.has(`${y},${x}`)) ok = false
          }
        }
        if (!ok) continue
        out.push({ itemId: best.id, col, row, w, h, rotated: false, error: BY_NAME_ERROR - 0.2 * w * h, alternatives: [], nameMatch: true, byName: true })
      }
    }
  }
  return out
}

/**
 * A modded gun is often a cell or two longer (stock, suppressor) or a row taller (magazine)
 * than any picture of it. When a named gun has unclaimed, not-empty cells right next to it
 * (left along its whole height, or below along its whole width) with no other item's name
 * in them, they are part of the gun.
 */
function growGuns(out: Detection[], grid: Grid, labels: Map<string, Label>, index: FingerprintIndex, empty: boolean[][], taken: Set<string>): Detection[] {
  const gunIds = new Set(index.ids.filter((_, i) => index.guns?.[i]))
  const gone = new Set<Detection>()
  // Nameless pieces of a gun get matched to other guns' pictures (or weakly to anything).
  const piece = (o: Detection) => !o.nameMatch && !labels.has(`${o.row},${o.col + o.w - 1}`) && (gunIds.has(o.itemId) || o.error >= 12)
  const owner = (x: number, y: number) => out.find((o) => !gone.has(o) && x >= o.col && x < o.col + o.w && y >= o.row && y < o.row + o.h)
  // The cells may be added when they are unclaimed or held by pieces lying wholly inside them.
  const grab = (d: Detection, cells: [number, number][]): boolean => {
    if (!cells.length || cells.some(([x, y]) => x < 0 || y >= grid.rows || labels.has(`${y},${x}`))) return false
    if (!cells.some(([x, y]) => !empty[y][x])) return false
    const inBlock = (o: Detection) => {
      for (let y = o.row; y < o.row + o.h; y++) for (let x = o.col; x < o.col + o.w; x++) if (!cells.some(([cx, cy]) => cx === x && cy === y)) return false
      return true
    }
    const holders = new Set<Detection>()
    for (const [x, y] of cells) {
      if (!taken.has(`${x},${y}`)) continue
      const o = owner(x, y)
      if (!o || o === d || !piece(o) || !inBlock(o)) return false
      holders.add(o)
    }
    for (const o of holders) gone.add(o)
    for (const [x, y] of cells) taken.add(`${x},${y}`)
    return true
  }
  for (const d of out) {
    if (gone.has(d) || !d.nameMatch || d.clipped || !gunIds.has(d.itemId)) continue
    for (let k = 0; k < 3; k++) {
      const left: [number, number][] = []
      for (let y = d.row; y < d.row + d.h; y++) left.push([d.col - 1, y])
      if (!grab(d, left)) break
      d.col -= 1
      d.w += 1
      d.byName = true
    }
    const below: [number, number][] = []
    for (let x = d.col; x < d.col + d.w; x++) below.push([x, d.row + d.h])
    if (d.h < 3 && d.row + d.h < grid.rows && below.filter(([x, y]) => !empty[y][x]).length * 2 >= below.length && grab(d, below)) {
      d.h += 1
      d.byName = true
    }
  }
  return gone.size ? out.filter((o) => !gone.has(o)) : out
}


/** Looks for items on the grid; returns non-overlapping detections, best first. */
export function scanGrid(img: Rgba, grid: Grid, candidates: Map<string, Candidate[]>, index: FingerprintIndex, opts: ScanOptions = {}, onProgress?: (done: number, total: number) => void): Detection[] {
  const sample = opts.sample ?? ((x: number, y: number, w: number, h: number, outW: number, outH: number) => sampleRegion(img, x, y, w, h, outW, outH))
  const maxError = opts.maxError ?? 28
  const footprints = [...candidates.keys()].map((k) => k.split('x').map(Number) as [number, number])
  const raw: Detection[] = []
  const masks = new Map<string, Uint8Array>()
  const maskFor = (w: number, h: number, rotated: boolean) => {
    const k = `${w}x${h}${rotated ? 'r' : ''}`
    let m = masks.get(k)
    if (!m) masks.set(k, (m = compareMask(w, h, rotated)))
    return m
  }
  const empty = emptyCells(img, grid)
  const labels = nameLabels(opts.words, grid)
  const total = grid.rows * grid.cols
  let done = 0
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      if (empty[row][col]) {
        done++
        continue
      }
      for (const [w, h] of footprints) {
        if (col + w > grid.cols || row + h > grid.rows) continue
        // An item never covers an empty slot, except guns: a gun's picture is mostly the plain
        // dark background around a thin weapon, so its slots read as empty. Guns may cover up
        // to half empty-looking slots (only gun pictures are tried there).
        let emptyCount = 0
        for (let y = row; y < row + h; y++) for (let x = col; x < col + w; x++) if (empty[y][x]) emptyCount++
        if (emptyCount && (w * h < 2 || emptyCount * 2 > w * h)) continue
        const gunsOnly = emptyCount > 0
        const x0 = grid.ox + col * grid.pitch
        const y0 = grid.oy + row * grid.pitch
        const region = sample(x0, y0, w * grid.pitch + 1, h * grid.pitch + 1, w * FP, h * FP)
        const all = candidates.get(`${w}x${h}`) ?? []
        const list = gunsOnly ? all.filter((c) => c.gun) : all
        if (!list.length) continue
        const top: { itemId: string; learned: boolean; rotated: boolean; error: number; name?: string; nameMatch?: boolean }[] = []
        let cutoff = maxError * 1.5
        const regionMean = { plain: meanColor(region, maskFor(w, h, false)), rot: meanColor(region, maskFor(w, h, true)) }
        // Rejected looks (nearest neighbour): if this spot is closer to a look the user said is NOT X
        // than to X's own picture, X is ruled out here. Nearly identical looks are always ruled out.
        const rejectedAt = new Map<string, number>()
        for (const c of list) {
          if (!c.negative) continue
          const d = distance(region, c.fp, maskFor(w, h, false), cutoff)
          if (d < (rejectedAt.get(c.itemId) ?? Infinity)) rejectedAt.set(c.itemId, d)
        }
        for (const c of list) {
          if (c.negative) continue
          const rm = c.rotated ? regionMean.rot : regionMean.plain
          // Cheap reject: average colour far off means the full comparison cannot win.
          const md = (Math.abs(rm[0] - c.mean[0]) + Math.abs(rm[1] - c.mean[1]) + Math.abs(rm[2] - c.mean[2])) / 3
          let err = md > cutoff ? Infinity : distance(region, c.fp, maskFor(w, h, c.rotated), cutoff)
          // Second opinion on the item's own pixels only (slot background ignored).
          if (c.iconMask) {
            const im = meanColor(region, c.iconMask)
            const imd = (Math.abs(im[0] - c.iconMean[0]) + Math.abs(im[1] - c.iconMean[1]) + Math.abs(im[2] - c.iconMean[2])) / 3
            if (imd <= cutoff) {
              const iconErr = distance(region, c.fp, c.iconMask, Math.min(err, cutoff)) + ICON_PENALTY
              if (iconErr < err) err = iconErr
            }
          }
          err = gunAdjusted(err, region, c)
          if (err === Infinity) continue
          const dNot = rejectedAt.get(c.itemId)
          if (dNot !== undefined && (dNot < NOT_RADIUS || dNot <= err)) continue
          if (c.bonus) err = Math.max(0, err - c.bonus)
          top.push({ itemId: c.itemId, learned: c.learned, rotated: c.rotated, error: err, name: c.name })
          top.sort((a, b) => a.error - b.error)
          if (top.length > 12) top.length = 12
          if (top.length === 12) cutoff = Math.min(cutoff, top[11].error)
        }
        // The printed name (top-right corner of the item, read by OCR). Items whose short name
        // matches are considered even when their icon looks different (icons get redrawn).
        const label = labels.get(`${row},${col + w - 1}`)
        // A weakly read label must match a name almost exactly.
        const matchAt = label && label.conf < 40 ? 0.9 : NAME_MATCH
        if (label) {
          for (const c of list) {
            if (c.negative || !c.name || rejectedAt.has(c.itemId)) continue
            if (top.some((t) => t.itemId === c.itemId && t.rotated === c.rotated)) continue
            if (labelSim(label, c.name) < matchAt) continue
            let err = distance(region, c.fp, maskFor(w, h, c.rotated))
            if (c.iconMask) err = Math.min(err, distance(region, c.fp, c.iconMask) + ICON_PENALTY)
            err = gunAdjusted(err, region, c)
            if (c.bonus) err = Math.max(0, err - c.bonus)
            top.push({ itemId: c.itemId, learned: c.learned, rotated: c.rotated, error: err, name: c.name })
          }
          // Exact names score fully, near misses ("Scdr." vs "F scdr.") less.
          const sims = top.map((t) => (t.name ? labelSim(label, t.name) : 0))
          const someoneMatches = sims.some((x) => x >= matchAt)
          top.forEach((t, i) => {
            const sim = sims[i]
            if (sim >= matchAt) {
              t.error = Math.max(0, t.error - NAME_BONUS * (sim - 0.5) * 2)
              t.nameMatch = true
            } else if (someoneMatches && label.conf >= 50 && label.text.length >= 3) {
              t.error += NAME_PENALTY
            }
          })
          top.sort((x, y) => x.error - y.error)
        }
        if (top.length && top[0].error <= maxError) {
          const best = top[0]
          const seen = new Set([best.itemId])
          const alternatives: Detection['alternatives'] = []
          for (const t of top.slice(1)) {
            const id = t.itemId
            if (seen.has(id)) continue
            seen.add(id)
            alternatives.push({ itemId: id, error: t.error })
          }
          raw.push({ itemId: best.itemId, col, row, w, h, rotated: best.rotated, error: best.error, alternatives, learned: best.learned || undefined, nameMatch: best.nameMatch || undefined })
        }
      }
      done++
      if (onProgress && done % 8 === 0) onProgress(done, total)
    }
  }
  // Items cut off by the bottom edge of the screenshot: their name (top-right) is still
  // visible, so when it matches, compare just the visible rows of that item.
  for (const [key, label] of labels) {
    const [row, rightCol] = key.split(',').map(Number)
    for (const [w, h] of footprints) {
      const col = rightCol - w + 1
      const visible = grid.rows - row
      if (col < 0 || row + h <= grid.rows || visible < 1) continue
      let covers = false
      for (let y = row; y < grid.rows && !covers; y++) for (let x = col; x < col + w; x++) if (empty[y][x]) covers = true
      if (covers) continue
      const region = sample(grid.ox + col * grid.pitch, grid.oy + row * grid.pitch, w * grid.pitch + 1, visible * grid.pitch, w * FP, visible * FP)
      const mask = compareMask(w, visible, false)
      for (const c of candidates.get(`${w}x${h}`) ?? []) {
        if (c.negative || c.rotated || !c.name) continue
        const sim = labelSim(label, c.name)
        if (sim < 0.85) continue
        const err = distance(region, c.fp.subarray(0, w * FP * visible * FP * 3), mask)
        if (err > maxError * 1.5) continue
        raw.push({ itemId: c.itemId, col, row, w, h: visible, rotated: false, error: Math.max(0, err + 2 - NAME_BONUS * (sim - 0.5) * 2), alternatives: [], nameMatch: true, clipped: true })
      }
    }
  }

  // Name anchors. A confidently read label that is (nearly) an item's short name marks that
  // item's top-right corner, so the item can only sit at one place: try it exactly there, even
  // over slots that looked empty (a dark item edge, e.g. the Hand drill's tip, passes for an
  // empty slot). Then every other box is checked against the names it covers.
  const anchors = new Map<string, Set<string>>()
  const nameIds = new Map<string, string[]>()
  for (const list of candidates.values()) {
    for (const c of list) {
      if (!c.name || c.negative) continue
      const ids = nameIds.get(c.name)
      if (!ids) nameIds.set(c.name, [c.itemId])
      else if (!ids.includes(c.itemId)) ids.push(c.itemId)
    }
  }
  const already = new Set(raw.map((d) => `${d.itemId}|${d.col}|${d.row}|${d.w}|${d.h}`))
  for (const [key, label] of labels) {
    if (label.conf < 50 || label.text.length < 3) continue
    const sims = new Map<string, number>()
    for (const [name, ids] of nameIds) {
      const sim = labelSim(label, name)
      if (sim >= ANCHOR_MATCH) for (const id of ids) sims.set(id, Math.max(sims.get(id) ?? 0, sim))
    }
    if (!sims.size) continue
    anchors.set(key, new Set(sims.keys()))
    const [row, rightCol] = key.split(',').map(Number)
    for (const [w, h] of footprints) {
      const col = rightCol - w + 1
      if (col < 0 || row + h > grid.rows) continue
      let emptyCount = 0
      for (let y = row; y < row + h; y++) for (let x = col; x < col + w; x++) if (empty[y][x]) emptyCount++
      if (emptyCount * 2 > w * h) continue
      const list = (candidates.get(`${w}x${h}`) ?? []).filter((c) => !c.negative && sims.has(c.itemId))
      if (!list.length) continue
      const region = sample(grid.ox + col * grid.pitch, grid.oy + row * grid.pitch, w * grid.pitch + 1, h * grid.pitch + 1, w * FP, h * FP)
      for (const c of list) {
        const id = `${c.itemId}|${col}|${row}|${w}|${h}`
        if (already.has(id)) continue
        let err = distance(region, c.fp, maskFor(w, h, c.rotated))
        if (c.iconMask) err = Math.min(err, distance(region, c.fp, c.iconMask) + ICON_PENALTY)
        err = gunAdjusted(err, region, c)
        if (c.bonus) err = Math.max(0, err - c.bonus)
        if (err > maxError * 1.5) continue
        already.add(id)
        const sim = sims.get(c.itemId) ?? 0
        raw.push({ itemId: c.itemId, col, row, w, h, rotated: c.rotated, error: Math.max(0, err - NAME_BONUS * (sim - 0.5) * 2), alternatives: [], learned: c.learned || undefined, nameMatch: true })
      }
    }
  }
  raw.push(...gunsByName(grid, labels, index, empty, raw))
  if (anchors.size) {
    for (const d of raw) {
      if (d.byName) continue
      if (d.clipped) continue
      let conflict = false
      for (let y = d.row; y < d.row + d.h && !conflict; y++) {
        for (let x = d.col; x < d.col + d.w && !conflict; x++) {
          const ids = anchors.get(`${y},${x}`)
          if (!ids) continue
          // A name must sit in the box's own top-right slot, and be this item's name.
          const corner = y === d.row && x === d.col + d.w - 1
          if (!corner || !ids.has(d.itemId)) conflict = true
        }
      }
      if (conflict) d.error += NAME_PENALTY
    }
  }

  // Greedy, best first, no overlaps. A whole item fits slightly worse than one of its own
  // corners does (more pixels, more chance of a highlight), so larger footprints get a
  // small bonus per extra cell: the 400 ml WD-40 must beat "100 ml WD-40 + something".
  const rank = (d: Detection) => d.error - Math.min(AREA_BONUS_MAX, AREA_BONUS * (d.w * d.h - 1))
  raw.sort((a, b) => rank(a) - rank(b))
  // A big uncertain match must not swallow slots that already hold confident smaller items.
  const confident = raw.filter((d) => d.error < 12)
  const coversConfident = (d: Detection) =>
    confident.some((c) => c !== d && c.w * c.h < d.w * d.h && c.col >= d.col && c.row >= d.row && c.col + c.w <= d.col + d.w && c.row + c.h <= d.row + d.h)
  const taken = new Set<string>()
  const out: Detection[] = []
  for (const d of raw) {
    let free = true
    for (let y = d.row; y < d.row + d.h && free; y++) for (let x = d.col; x < d.col + d.w; x++) if (taken.has(`${x},${y}`)) free = false
    if (!free) continue
    if (d.w * d.h > 1 && d.error >= 15 && coversConfident(d)) continue
    for (let y = d.row; y < d.row + d.h; y++) for (let x = d.col; x < d.col + d.w; x++) taken.add(`${x},${y}`)
    out.push(d)
  }
  const grown = growGuns(out, grid, labels, index, empty, taken)
  onProgress?.(total, total)
  return grown.sort((a, b) => a.row - b.row || a.col - b.col)
}

/**
 * Best items for one box the user placed or moved by hand (the scan dialog's box editor):
 * every item of that on-screen footprint (both orientations), compared over the box, with
 * the printed name in the box's top-right slot counted like in scanGrid. Best first.
 */
export function identifyRegion(
  img: Rgba,
  grid: Grid,
  candidates: Map<string, Candidate[]>,
  box: { col: number; row: number; w: number; h: number },
  words?: OcrWord[],
  limit = 10,
): { itemId: string; error: number; rotated: boolean; nameMatch: boolean; learned: boolean }[] {
  const { col, row, w, h } = box
  const list = candidates.get(`${w}x${h}`) ?? []
  if (!list.length) return []
  const region = sampleRegion(img, grid.ox + col * grid.pitch, grid.oy + row * grid.pitch, w * grid.pitch + 1, h * grid.pitch + 1, w * FP, h * FP)
  const masks = { plain: compareMask(w, h, false), rot: compareMask(w, h, true) }
  const label = nameLabels(words, grid).get(`${row},${col + w - 1}`)
  const best = new Map<string, { itemId: string; error: number; rotated: boolean; nameMatch: boolean; learned: boolean }>()
  for (const c of list) {
    if (c.negative) continue
    let err = distance(region, c.fp, c.rotated ? masks.rot : masks.plain)
    if (c.iconMask) err = Math.min(err, distance(region, c.fp, c.iconMask) + ICON_PENALTY)
    err = gunAdjusted(err, region, c)
    if (c.bonus) err = Math.max(0, err - c.bonus)
    let nameMatch = false
    if (label && c.name) {
      const sim = labelSim(label, c.name)
      if (sim >= (label.conf < 40 ? 0.9 : NAME_MATCH)) {
        err = Math.max(0, err - NAME_BONUS * (sim - 0.5) * 2)
        nameMatch = true
      }
    }
    const prev = best.get(c.itemId)
    if (!prev || err < prev.error) best.set(c.itemId, { itemId: c.itemId, error: err, rotated: c.rotated, nameMatch, learned: c.learned })
  }
  return [...best.values()].sort((a, b) => a.error - b.error).slice(0, limit)
}

/** Serialized fingerprint file: JSON header line + binary pixels. */
export interface FingerprintHeader {
  version: 1
  fp: number
  generated: string
  /** src = user memories shipped with the app (see scan-corrections/). */
  items: { id: string; w: number; h: number; o: number; src?: 'correction' | 'confirmed' | 'not'; n?: string; g?: 1 }[]
}

export function indexFromParts(header: FingerprintHeader, pixels: Uint8Array): FingerprintIndex {
  const n = header.items.length
  const index: FingerprintIndex = {
    ids: header.items.map((i) => i.id),
    widths: new Uint8Array(n),
    heights: new Uint8Array(n),
    offsets: new Uint32Array(n),
    pixels,
    corrections: Uint8Array.from(header.items, (it) => (it.src === 'correction' ? 1 : it.src === 'confirmed' ? 2 : it.src === 'not' ? 3 : 0)),
    names: header.items.map((it) => it.n ?? ''),
    guns: Uint8Array.from(header.items, (it) => (it.g ? 1 : 0)),
  }
  header.items.forEach((it, i) => {
    index.widths[i] = it.w
    index.heights[i] = it.h
    index.offsets[i] = it.o
  })
  return index
}
