// Lighthouse minefields from json.tarkov.dev (hazards, exact outlines) in drawing units, saved to
// <out>.json; optionally drawn on the straightened render to check the fit.
// Usage: hazards.cjs <out-prefix> [--box=u0,v0,u1,v1 --px=2]
const fs = require('fs')
const F = require('./frames.cjs')

const args = process.argv.slice(2)
const [prefix] = args.filter((a) => !a.startsWith('--'))

;(async () => {
  const base = await (await fetch('https://json.tarkov.dev/pve/maps')).json()
  const map = Object.values(base.data.maps).find((m) => m.normalizedName === 'lighthouse')
  const fields = (map.hazards ?? [])
    .filter((h) => h.hazardType === 'minefield' && (h.outline ?? []).length >= 3)
    .map((h) => ({ p: h.outline.map((o) => F.gameToSvg(o.x, o.z).map((n) => +n.toFixed(2))), top: h.top, bottom: h.bottom }))
  fs.writeFileSync(`${prefix}.json`, JSON.stringify(fields))
  console.log(fields.length, 'minefields')
  const big = fields.filter((f) => {
    const us = f.p.map((p) => p[0])
    const vs = f.p.map((p) => p[1])
    return Math.max(...us) - Math.min(...us) > 15 || Math.max(...vs) - Math.min(...vs) > 15
  })
  for (const f of big) console.log('field', f.p.map((p) => p.map((n) => n.toFixed(0)).join(',')).join(' '))
})().catch((e) => console.log('FAILED', e.message))
