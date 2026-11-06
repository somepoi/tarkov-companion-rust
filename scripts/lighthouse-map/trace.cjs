// The RE3MR render straightened into drawing units (1 unit ≈ 1 m, north up, same axes as the
// drawing), with a grid every 5 units (labelled every 25) and, on top, the traced shapes so far
// (cyan, numbered) and optionally the old drawing's buildings (faint pink).
// Usage: trace.cjs <out.png> --box=u0,v0,u1,v1 [--px=4] [--specs=specs.json] [--old=old.svg] [--only=buildings]
const fs = require('fs')
const sharp = require('sharp')
const F = require('./frames.cjs')

const args = process.argv.slice(2)
const [out] = args.filter((a) => !a.startsWith('--'))
const opt = (k, d) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const [u0, v0, u1, v1] = opt('box').split(',').map(Number)
const PX = Number(opt('px', '4'))
const specsFile = opt('specs')
const oldFile = opt('old')

/** Corner points of a traced shape: a polygon {p}, or a rectangle {c, w, h, a} (a = degrees, clockwise). */
function shapePoints(s) {
  if (s.p) return s.p
  if (s.r) {
    const [a, b, c, d] = s.r
    return [[a, b], [c, b], [c, d], [a, d]]
  }
  const [cx, cy] = s.c
  const r = ((s.a ?? 0) * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const x = (sx * s.w) / 2
    const y = (sy * s.h) / 2
    return [cx + x * cos - y * sin, cy + x * sin + y * cos]
  })
}

;(async () => {
  const W = Math.round((u1 - u0) * PX)
  const H = Math.round((v1 - v0) * PX)
  const m = F.svgToRenderMatrix(F.appRenderAffine(), 1)
  const toR = (u, v) => [m[0] * u + m[1] * v + m[2], m[3] * u + m[4] * v + m[5]]
  const cs = [toR(u0, v0), toR(u1, v0), toR(u0, v1), toR(u1, v1)]
  const rx0 = Math.max(0, Math.floor(Math.min(...cs.map((c) => c[0]))) - 2)
  const ry0 = Math.max(0, Math.floor(Math.min(...cs.map((c) => c[1]))) - 2)
  const rx1 = Math.min(F.RENDER_SIZE[0], Math.ceil(Math.max(...cs.map((c) => c[0]))) + 2)
  const ry1 = Math.min(F.RENDER_SIZE[1], Math.ceil(Math.max(...cs.map((c) => c[1]))) + 2)
  const rw = rx1 - rx0
  const rh = ry1 - ry0
  const data = await F.renderRegion(rx0, ry0, rw, rh)
  const img = Buffer.alloc(W * H * 3)
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const [x, y] = toR(u0 + (i + 0.5) / PX, v0 + (j + 0.5) / PX)
      const fx = x - rx0 - 0.5
      const fy = y - ry0 - 0.5
      const x0 = Math.floor(fx)
      const y0 = Math.floor(fy)
      if (x0 < 0 || y0 < 0 || x0 >= rw - 1 || y0 >= rh - 1) continue
      const ax = fx - x0
      const ay = fy - y0
      for (let c = 0; c < 3; c++) {
        const p = (yy, xx) => data[3 * (yy * rw + xx) + c]
        img[3 * (j * W + i) + c] = Math.round(p(y0, x0) * (1 - ax) * (1 - ay) + p(y0, x0 + 1) * ax * (1 - ay) + p(y0 + 1, x0) * (1 - ax) * ay + p(y0 + 1, x0 + 1) * ax * ay)
      }
    }
  const g = []
  const X = (u) => (u - u0) * PX
  const Y = (v) => (v - v0) * PX
  for (let u = Math.ceil(u0 / 5) * 5; u <= u1; u += 5) {
    const major = u % 25 === 0
    g.push(`<line x1="${X(u)}" y1="0" x2="${X(u)}" y2="${H}" stroke="#fff" stroke-opacity="${major ? 0.5 : 0.16}"/>`)
    if (major) g.push(`<text x="${X(u) + 2}" y="11" font-size="10" font-family="Arial" fill="#ff0" stroke="#000" stroke-width="3" paint-order="stroke">${u}</text>`)
  }
  for (let v = Math.ceil(v0 / 5) * 5; v <= v1; v += 5) {
    const major = v % 25 === 0
    g.push(`<line x1="0" y1="${Y(v)}" x2="${W}" y2="${Y(v)}" stroke="#fff" stroke-opacity="${major ? 0.5 : 0.16}"/>`)
    if (major) g.push(`<text x="2" y="${Y(v) - 2}" font-size="10" font-family="Arial" fill="#ff0" stroke="#000" stroke-width="3" paint-order="stroke">${v}</text>`)
  }
  if (oldFile && opt('all')) {
    // every group of the drawing as thin outlines: water/land cyan, rock orange, roads white, cement grey, buildings pink
    const st = `.water{stroke:#00e5ff}.land{stroke:#7CFC00}.rock{stroke:#ffb000}.tarmac,.road_tarmac{stroke:#ffffff}.gravel,.road_gravel{stroke:#ff7a00}.cement{stroke:#bbbbbb}.building{stroke:#ff2bd6}.wood{stroke:#ffd27f}.fence{stroke:#c4e3c3}.railroad{stroke:#ff5533}.danger{stroke:#ff0000}.map_border{stroke:#ff0000}`
    g.push(`<g transform="translate(${-u0 * PX} ${-v0 * PX}) scale(${PX})" fill="none" stroke-width="${(1.3 / PX).toFixed(3)}"><style>${st} path,circle{fill:none!important;stroke-width:${(1.3 / PX).toFixed(3)}px}</style>${F.svgInner(oldFile)}</g>`)
  } else if (oldFile) {
    const s = fs.readFileSync(oldFile, 'utf8')
    const block = s.slice(s.indexOf('<g id="buildings"'), s.indexOf('</g>', s.indexOf('<g id="buildings"')))
    g.push(`<g transform="translate(${-u0 * PX} ${-v0 * PX}) scale(${PX})" fill="none" stroke="#ff2bd6" stroke-opacity="0.55" stroke-width="${0.4}">${block.replace(/<g[^>]*>/, '')}</g>`)
  }
  for (const file of (specsFile ?? '').split(';').filter((f) => f && fs.existsSync(f))) {
    const specs = JSON.parse(fs.readFileSync(file, 'utf8'))
    const only = opt('only')
    for (const [layer, shapes] of Object.entries(specs)) {
      if (only && layer !== only) continue
      shapes.forEach((s, i) => {
        if (s.l) {
          // a line: roads as a translucent band of their width, rails/fences thin
          const d = s.l.map(([u, v], k) => `${k ? 'L' : 'M'}${X(u).toFixed(1)} ${Y(v).toFixed(1)}`).join('')
          const wide = s.w ? s.w * PX : 2
          g.push(`<path d="${d}" fill="none" stroke="${layer === 'roads' ? '#00ffff' : layer === 'rails' ? '#ff5533' : '#c4e3c3'}" stroke-opacity="${s.w ? 0.35 : 0.9}" stroke-width="${wide}" stroke-linejoin="round" stroke-linecap="round"/>`)
          if (s.w) g.push(`<path d="${d}" fill="none" stroke="#00ffff" stroke-width="1"/>`)
          return
        }
        const pts = shapePoints(s)
        if (pts.some(([u, v]) => u >= u0 - 20 && u <= u1 + 20 && v >= v0 - 20 && v <= v1 + 20)) {
          g.push(`<polygon points="${pts.map(([u, v]) => `${X(u).toFixed(1)},${Y(v).toFixed(1)}`).join(' ')}" fill="none" stroke="#00ffff" stroke-width="1.5"/>`)
          const [cu, cv] = pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0])
          g.push(`<text x="${X(cu)}" y="${Y(cv) + 3}" font-size="9" text-anchor="middle" font-family="Arial" fill="#0ff" stroke="#000" stroke-width="2.5" paint-order="stroke">${layer[0]}${i}</text>`)
        }
      })
    }
  }
  // game-data outlines in drawing units ({p} list, e.g. minefields.json): red
  if (opt('zones')) {
    const zones = JSON.parse(fs.readFileSync(opt('zones'), 'utf8'))
    for (const z of zones.zones ?? zones) {
      if (z.p.every(([u, v]) => u < u0 || u > u1 || v < v0 || v > v1)) continue
      g.push(`<polygon points="${z.p.map(([u, v]) => `${X(u).toFixed(1)},${Y(v).toFixed(1)}`).join(' ')}" fill="#ff0000" fill-opacity="0.25" stroke="#ff2020" stroke-width="1.2"/>`)
    }
  }
  // game-data points (points.json from points.cjs): locks red, containers yellow, extracts cyan, guns orange
  const pointsFile = opt('points')
  if (pointsFile) {
    const COLOR = { lock: '#ff2020', container: '#ffe600', extract: '#00e5ff', switch: '#39ff14', gun: '#ff8c00', loose: '#ff4dff' }
    for (const p of JSON.parse(fs.readFileSync(pointsFile, 'utf8'))) {
      const [u, v] = F.gameToSvg(p.x, p.z)
      if (u < u0 || u > u1 || v < v0 || v > v1) continue
      const r = p.k === 'lock' ? 3.5 : p.k === 'loose' ? 1.8 : 2.5
      g.push(`<circle cx="${X(u).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="${r}" fill="${COLOR[p.k]}" stroke="#000" stroke-width="${p.k === 'loose' ? 0.6 : 1}"/>`)
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${g.join('')}</svg>`
  await sharp(img, { raw: { width: W, height: H, channels: 3 } }).composite([{ input: Buffer.from(svg) }]).png().toFile(out)
  console.log(out, W, 'x', H)
})().catch((e) => console.log('FAILED', e.message))

module.exports = { shapePoints }
