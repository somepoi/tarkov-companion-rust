// A part of a drawing in its own colours (drawing units, north up), with optional game-data points
// on top (locks red, containers yellow, extracts cyan) and quest zones (cyan outlines): the check
// that what the game places lands on the right building, road or shore.
// Usage: drawing.cjs <drawing.svg> <out.png> --box=u0,v0,u1,v1 [--px=2] [--points=points.json] [--zones=zones.json]
const fs = require('fs')
const sharp = require('sharp')
const F = require('./frames.cjs')

const args = process.argv.slice(2)
const [svgFile, out] = args.filter((a) => !a.startsWith('--'))
const opt = (k, d) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const [u0, v0, u1, v1] = opt('box').split(',').map(Number)
const PX = Number(opt('px', '2'))

;(async () => {
  const W = Math.round((u1 - u0) * PX)
  const H = Math.round((v1 - v0) * PX)
  const src = fs.readFileSync(svgFile, 'utf8')
  const style = /<style[^>]*>([\s\S]*?)<\/style>/.exec(src)?.[1] ?? ''
  const X = (u) => ((u - u0) * PX).toFixed(1)
  const Y = (v) => ((v - v0) * PX).toFixed(1)
  const marks = []
  if (opt('zones')) {
    for (const z of JSON.parse(fs.readFileSync(opt('zones'), 'utf8')).zones) {
      if (z.p.every(([u, v]) => u < u0 || u > u1 || v < v0 || v > v1)) continue
      marks.push(`<polygon points="${z.p.map(([u, v]) => `${X(u)},${Y(v)}`).join(' ')}" fill="none" stroke="#00ffff" stroke-width="1.5"/>`)
    }
  }
  if (opt('points')) {
    const COLOR = { lock: '#ff2020', container: '#ffe600', extract: '#00e5ff', switch: '#39ff14', gun: '#ff8c00' }
    for (const p of JSON.parse(fs.readFileSync(opt('points'), 'utf8'))) {
      const [u, v] = F.gameToSvg(p.x, p.z)
      if (u < u0 || u > u1 || v < v0 || v > v1) continue
      marks.push(`<circle cx="${X(u)}" cy="${Y(v)}" r="${p.k === 'lock' ? 3.5 : 2.5}" fill="${COLOR[p.k]}" stroke="#000" stroke-width="1"/>`)
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#4a6b96"/><style>${style}</style><g transform="translate(${-u0 * PX} ${-v0 * PX}) scale(${PX})">${F.svgInner(svgFile)}</g>${marks.join('')}</svg>`
  await sharp(Buffer.from(svg), { limitInputPixels: false }).png().toFile(out)
  console.log(out, W, 'x', H)
})().catch((e) => console.log('FAILED', e.message))
