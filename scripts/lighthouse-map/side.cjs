// Side by side: the RE3MR render (left) and a drawing in its own colours (right), same area and scale,
// with a light grid in drawing units (every 50, labelled every 100) on both halves.
// Usage: side.cjs <drawing.svg> <out.png> --crop=x,y,w,h (render px) [--scale=0.42] [--affine=…]
const sharp = require('sharp')
const F = require('./frames.cjs')

const args = process.argv.slice(2)
const [svgFile, out] = args.filter((a) => !a.startsWith('--'))
const opt = (k, d) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const scale = Number(opt('scale', '0.42'))
const affine = opt('affine') ? opt('affine').split(',').map(Number) : F.appRenderAffine()
const [cx, cy, cw, ch] = opt('crop').split(',').map(Number)

/** Extra classes a drawing defines in its own <style> (later rules win over STYLE). */
function ownStyle(file) {
  const m = /<style[^>]*>([\s\S]*?)<\/style>/.exec(require('fs').readFileSync(file, 'utf8'))
  return m ? m[1] : ''
}

/** The drawing's own colours (tarkov.dev style_common), so the right half looks like the app's map. */
const STYLE = `.trees{fill:#144043}.cement{fill:#c6c2c2}.land{fill:#1f5054}.rock{fill:#dcd5b6}.water{fill:#4a6b96}.wood{fill:#593700}.tarmac{fill:#768089}.gravel{fill:#946d3e}.building{fill:#1a2632}.floor{fill:#70777f}.locked{fill:#37414c}.map_border{fill:none;stroke:#000;stroke-width:2}.fence{fill:none;stroke:#c4e3c3;stroke-width:1}.road_tarmac{fill:none;stroke:#888}.road_gravel{fill:none;stroke:#946d3e}.road_small{stroke-width:5}.road_medium{stroke-width:8}.road_large{stroke-width:12}.railroad{fill:none;stroke:#914833;stroke-dasharray:6;stroke-width:3}.powerline{fill:none;stroke:#ffce00;stroke-width:2;stroke-dasharray:6,6}.danger{fill:red;fill-opacity:.4;stroke:red;stroke-dasharray:4,2;stroke-width:2}.stairs{fill:#FFD700}`

;(async () => {
  const W = Math.round(cw * scale)
  const H = Math.round(ch * scale)
  const m = F.svgToRenderMatrix(affine, 1)
  const t = [m[0] * scale, m[3] * scale, m[1] * scale, m[4] * scale, (m[2] - cx) * scale, (m[5] - cy) * scale]
  // grid in drawing units: lines u = const and v = const, mapped through t
  const inv = F.invert([t[0], t[2], t[4], t[1], t[3], t[5]])
  const corners = [[0, 0], [W, 0], [0, H], [W, H]].map(([x, y]) => [inv[0] * x + inv[1] * y + inv[2], inv[3] * x + inv[4] * y + inv[5]])
  const [u0, u1] = [Math.min(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[0]))]
  const [v0, v1] = [Math.min(...corners.map((c) => c[1])), Math.max(...corners.map((c) => c[1]))]
  const P = (u, v) => [t[0] * u + t[2] * v + t[4], t[1] * u + t[3] * v + t[5]]
  const grid = []
  for (let u = Math.ceil(u0 / 50) * 50; u <= u1; u += 50) {
    const [a, b] = [P(u, v0), P(u, v1)]
    grid.push(`<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="#fff" stroke-opacity="${u % 100 ? 0.15 : 0.35}"/>`)
    if (u % 100 === 0) grid.push(`<text x="${P(u, v0)[0] + 2}" y="12" font-size="11" font-family="Arial" fill="#ff0" stroke="#000" stroke-width="3" paint-order="stroke">${u}</text>`)
  }
  for (let v = Math.ceil(v0 / 50) * 50; v <= v1; v += 50) {
    const [a, b] = [P(u0, v), P(u1, v)]
    grid.push(`<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="#fff" stroke-opacity="${v % 100 ? 0.15 : 0.35}"/>`)
    if (v % 100 === 0) grid.push(`<text x="2" y="${P(u0, v)[1] - 2}" font-size="11" font-family="Arial" fill="#ff0" stroke="#000" stroke-width="3" paint-order="stroke">${v}</text>`)
  }
  const gridSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${grid.join('')}</svg>`
  const drawing = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#4a6b96"/><style>${STYLE}${ownStyle(svgFile)}</style><g transform="matrix(${t.join(' ')})">${F.svgInner(svgFile)}</g></svg>`
  const left = await sharp(F.RENDER, { limitInputPixels: false }).extract({ left: cx, top: cy, width: cw, height: ch }).resize(W, H).composite([{ input: Buffer.from(gridSvg) }]).png().toBuffer()
  const right = await sharp(Buffer.from(drawing)).composite([{ input: Buffer.from(gridSvg) }]).png().toBuffer()
  await sharp({ create: { width: 2 * W + 6, height: H, channels: 3, background: '#000' } })
    .composite([{ input: left, left: 0, top: 0 }, { input: right, left: W + 6, top: 0 }])
    .png()
    .toFile(out)
  console.log(out, `${2 * W + 6}x${H}`, `drawing units ${u0.toFixed(0)}–${u1.toFixed(0)} × ${v0.toFixed(0)}–${v1.toFixed(0)}`)
})().catch((e) => console.log('FAILED', e.message))
