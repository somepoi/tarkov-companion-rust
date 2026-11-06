// Fits a homography from picture pixels to game x/z using control points (extract markers whose
// game position is known), prints each point's error in metres, then converts the marked areas.
// Usage (node scripts/boss-areas/fit.cjs specs/x.json).
// Reference points: positions.cjs <map> prints extract/transit positions; wiki-pictures.cjs <outDir> <page...> downloads the pictures.
// spec = { points: [[ix, iy, gx, gz, label]], areas: { name: [[ix, iy], ...] } }
const fs = require('fs')
const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))

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

// Least squares for h (8 unknowns, h33 = 1): gx = (h0 ix + h1 iy + h2) / (h6 ix + h7 iy + 1), same for gz.
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

let pts = spec.points
const affine = Boolean(spec.affine)
let h = fit(pts, affine)
for (let round = 0; round < 3; round++) {
  const errs = pts.map((p) => Math.hypot(...apply(h, p[0], p[1]).map((v, i) => v - p[2 + i])))
  const sorted = [...errs].sort((a, b) => a - b)
  const med = sorted[Math.floor(sorted.length / 2)]
  const keep = pts.filter((_, i) => errs[i] <= Math.max(25, med * 3))
  if (keep.length === pts.length || keep.length < 6) break
  console.log(`dropping ${pts.length - keep.length} outliers: ${pts.filter((_, i) => errs[i] > Math.max(25, med * 3)).map((p) => p[4]).join(', ')}`)
  pts = keep
  h = fit(pts, affine)
}
let sq = 0
for (const p of spec.points) {
  const [x, z] = apply(h, p[0], p[1])
  const e = Math.hypot(x - p[2], z - p[3])
  if (pts.includes(p)) sq += e * e
  console.log(`  ${(p[4] ?? '').padEnd(24)} err ${e.toFixed(1).padStart(6)} m${pts.includes(p) ? '' : '  (not used)'}`)
}
console.log(`RMS ${Math.sqrt(sq / pts.length).toFixed(1)} m over ${pts.length} points`)
for (const [name, poly] of Object.entries(spec.areas ?? {})) {
  const g = poly.map(([ix, iy]) => apply(h, ix, iy).map((v) => Math.round(v)))
  console.log(`${name}: ${JSON.stringify(g)}`)
}
for (const [name, [ix, iy]] of Object.entries(spec.probe ?? {})) console.log(`probe ${name}: ${apply(h, ix, iy).map((v) => Math.round(v)).join(',')}`)
