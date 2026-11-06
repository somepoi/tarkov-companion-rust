// Turns quest markers read off EFT Wiki map pictures into game x/z. Each spec names a fitted frame
// (scripts/boss-areas/specs/*.json, control points in a scaled copy of the same picture) and the
// marker pixels in the full-size picture. Prints one line per spot plus the frame's fit error.
// Usage: node scripts/quest-spots/place.cjs scripts/quest-spots/specs/<map>.json
// spec = { frame: "<path to boss-areas spec>", pictureWidth: <px of the full-size picture>, spots: { "<name>": [x, y] } }
// A picture with no fitted twin carries its own control points instead of `frame`:
// spec = { picture, affine, points: [[x, y, gameX, gameZ, label]], spots } (full-size pixels).
const fs = require('fs')
const path = require('path')
const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const frame = spec.frame ? JSON.parse(fs.readFileSync(path.resolve(spec.frame), 'utf8')) : spec
const frameWidth = spec.frame ? Number(/scaled to (\d+)/.exec(frame.units ?? '')?.[1]) : 0
const scale = frameWidth ? spec.pictureWidth / frameWidth : 1

function solve(A, b) {
  const n = b.length
  const M = A.map((row, i) => [...row, b[i]])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r
    ;[M[c], M[p]] = [M[p], M[c]]
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = M[r][c] / M[c][c]
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]
    }
  }
  return M.map((row, i) => row[n] / row[i])
}
function fit(pts, affine) {
  const rows = []
  const rhs = []
  for (const [ix, iy, gx, gz] of pts) {
    if (affine) {
      rows.push([ix, iy, 1, 0, 0, 0]); rhs.push(gx)
      rows.push([0, 0, 0, ix, iy, 1]); rhs.push(gz)
    } else {
      rows.push([ix, iy, 1, 0, 0, 0, -ix * gx, -iy * gx]); rhs.push(gx)
      rows.push([0, 0, 0, ix, iy, 1, -ix * gz, -iy * gz]); rhs.push(gz)
    }
  }
  const n = rows[0].length
  const AtA = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => rows.reduce((s, r) => s + r[i] * r[j], 0)))
  const Atb = Array.from({ length: n }, (_, i) => rows.reduce((s, r, k) => s + r[i] * rhs[k], 0))
  const h = solve(AtA, Atb)
  return affine ? [h[0], h[1], h[2], h[3], h[4], h[5], 0, 0] : h
}
const apply = (h, ix, iy) => {
  const w = h[6] * ix + h[7] * iy + 1
  return [(h[0] * ix + h[1] * iy + h[2]) / w, (h[3] * ix + h[4] * iy + h[5]) / w]
}

// Same outlier rule as boss-areas/fit.cjs, so a frame gives the same positions there and here.
let pts = frame.points
const affine = Boolean(frame.affine)
let h = fit(pts, affine)
for (let round = 0; round < 3; round++) {
  const errs = pts.map((p) => Math.hypot(...apply(h, p[0], p[1]).map((v, i) => v - p[2 + i])))
  const med = [...errs].sort((a, b) => a - b)[Math.floor(errs.length / 2)]
  const keep = pts.filter((_, i) => errs[i] <= Math.max(25, med * 3))
  if (keep.length === pts.length || keep.length < 6) break
  pts = keep
  h = fit(pts, affine)
}
const rms = Math.sqrt(pts.reduce((s, p) => s + Math.hypot(...apply(h, p[0], p[1]).map((v, i) => v - p[2 + i])) ** 2, 0) / pts.length)
for (const p of spec.frame ? [] : frame.points) console.log(`  control ${String(p[4]).padEnd(28)} err ${Math.hypot(...apply(h, p[0], p[1]).map((v, i) => v - p[2 + i])).toFixed(1)} m${pts.includes(p) ? "" : " (dropped)"}`)
console.log(`${path.basename(spec.frame ?? spec.picture)}: scale ${scale.toFixed(4)}, fit RMS ${rms.toFixed(1)} m over ${pts.length} points`)
for (const [name, [x, y]] of Object.entries(spec.spots ?? {})) {
  const [gx, gz] = apply(h, x / scale, y / scale)
  console.log(`  ${name.padEnd(56)} ${Math.round(gx)}, ${Math.round(gz)}`)
}
