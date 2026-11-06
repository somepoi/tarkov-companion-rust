// Game-data points (locks, loot containers, extracts, transits, switches, stationary guns) of
// Lighthouse from json.tarkov.dev, saved once to points.json next to the output, then drawn on a
// render crop with a fit: locks red, containers yellow, extracts/transits cyan, switches green.
// Usage: points.cjs <out.png> --crop=x,y,w,h [--zoom=2] [--affine=…] [--cache=points.json]
const fs = require('fs')
const path = require('path')
const sharp = require('sharp')
const F = require('./frames.cjs')

const args = process.argv.slice(2)
const [out] = args.filter((a) => !a.startsWith('--'))
const opt = (k, d) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const ZOOM = Number(opt('zoom', '2'))
const affine = opt('affine') ? opt('affine').split(',').map(Number) : F.appRenderAffine()
const [cx, cy, cw, ch] = opt('crop').split(',').map(Number)
const cache = opt('cache', path.join(path.dirname(out), 'points.json'))

async function loadPoints() {
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'))
  const base = await (await fetch('https://json.tarkov.dev/pve/maps')).json()
  const map = Object.values(base.data.maps).find((m) => m.normalizedName === 'lighthouse')
  const pts = []
  for (const l of map.locks ?? []) if (l.position) pts.push({ k: 'lock', x: l.position.x, z: l.position.z, y: l.position.y })
  for (const c of map.lootContainers ?? []) if (c.position) pts.push({ k: 'container', x: c.position.x, z: c.position.z, y: c.position.y })
  for (const e of map.extracts ?? []) if (e.position) pts.push({ k: 'extract', x: e.position.x, z: e.position.z, y: e.position.y })
  for (const t of map.transits ?? []) if (t.position) pts.push({ k: 'extract', x: t.position.x, z: t.position.z, y: t.position.y })
  for (const s of map.switches ?? []) if (s.position) pts.push({ k: 'switch', x: s.position.x, z: s.position.z, y: s.position.y })
  for (const s of map.stationaryWeapons ?? []) if (s.position) pts.push({ k: 'gun', x: s.position.x, z: s.position.z, y: s.position.y })
  fs.writeFileSync(cache, JSON.stringify(pts))
  return pts
}

const COLOR = { lock: '#ff2020', container: '#ffe600', extract: '#00e5ff', switch: '#39ff14', gun: '#ff8c00' }

;(async () => {
  const pts = await loadPoints()
  const W = Math.round(cw * ZOOM)
  const H = Math.round(ch * ZOOM)
  const marks = []
  for (const p of pts) {
    const [rx, ry] = F.gameToRender(affine, p.x, p.z)
    const x = (rx - cx) * ZOOM
    const y = (ry - cy) * ZOOM
    if (x < 0 || y < 0 || x > W || y > H) continue
    marks.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${p.k === 'container' ? 3 : 4}" fill="${COLOR[p.k]}" stroke="#000" stroke-width="1"/>`)
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${marks.join('')}</svg>`
  await sharp(F.RENDER, { limitInputPixels: false }).extract({ left: cx, top: cy, width: cw, height: ch }).resize(W, H, { kernel: 'nearest' }).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toFile(out)
  console.log(out, marks.length, 'points')
})().catch((e) => console.log('FAILED', e.message))
