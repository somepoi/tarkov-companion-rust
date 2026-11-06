// The check that the drawing puts buildings where the game has them: containers that only exist
// indoors (drawers, PC blocks, safes, cash registers, jackets, medcases) and door locks must lie
// inside a drawn building. Prints the share that does and the misses grouped per 25 m square.
// Game points come from json.tarkov.dev (PvE maps doc), saved once to --cache; loose loot is kept in
// the same file for trace.cjs (k: 'loose').
// Usage: check.cjs <drawing.svg> --cache=points.json [--list]
const fs = require('fs')
const F = require('./frames.cjs')
const { pathPoints } = require('./svgpath.cjs')

const args = process.argv.slice(2)
const [svgFile] = args.filter((a) => !a.startsWith('--'))
const opt = (k, d) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const cache = opt('cache')

async function loadPoints() {
  if (cache && fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'))
  const base = await (await fetch('https://json.tarkov.dev/pve/maps')).json()
  const en = await (await fetch('https://json.tarkov.dev/pve/maps_en')).json()
  const T = en.data ?? en
  const map = Object.values(base.data.maps).find((m) => m.normalizedName === 'lighthouse')
  const names = {}
  for (const c of Object.values(base.data.lootContainers ?? {})) names[c.id] = T[c.name] ?? c.name
  const pts = []
  const add = (k, name, p) => p && pts.push({ k, name, x: p.x, z: p.z, y: p.y })
  for (const c of map.lootContainers ?? []) add('container', names[c.lootContainer] ?? c.lootContainer, c.position)
  for (const l of map.locks ?? []) add('lock', l.lockType === 'trunk' ? 'trunk' : 'door', l.position)
  for (const l of map.lootLoose ?? []) add('loose', 'loose', l.position)
  for (const e of [...(map.extracts ?? []), ...(map.transits ?? [])]) add('extract', T[e.name] ?? e.name, e.position)
  for (const s of map.switches ?? []) add('switch', T[s.name] ?? s.name, s.position)
  for (const s of map.stationaryWeapons ?? []) add('gun', 'gun', s.position)
  if (cache) fs.writeFileSync(cache, JSON.stringify(pts))
  return pts
}

function inside(poly, [u, v]) {
  let c = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > v !== yj > v && u < ((xj - xi) * (v - yi)) / (yj - yi) + xi) c = !c
  }
  return c
}
function distance(poly, [u, v]) {
  let best = Infinity
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j]
    const [bx, by] = poly[i]
    const dx = bx - ax
    const dy = by - ay
    const t = Math.max(0, Math.min(1, ((u - ax) * dx + (v - ay) * dy) / (dx * dx + dy * dy || 1)))
    best = Math.min(best, Math.hypot(ax + t * dx - u, ay + t * dy - v))
  }
  return best
}

const INDOOR = /^(drawer|pc block|safe|cash register|jacket|medcase)$/i

;(async () => {
  const pts = await loadPoints()
  const svg = fs.readFileSync(svgFile, 'utf8')
  const group = /<g id="buildings"[^>]*>([\s\S]*?)<\/g>/.exec(svg)[1]
  const polys = [...group.matchAll(/d="([^"]+)"/g)].map((m) => pathPoints(m[1]))
  // the same spot listed twice (container variants) counts once
  const seen = new Set()
  const indoor = pts.filter((p) => {
    if (!((p.k === 'lock' && p.name === 'door') || (p.k === 'container' && INDOOR.test(p.name)))) return false
    const key = `${p.name}@${p.x.toFixed(1)},${p.z.toFixed(1)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  let ok = 0
  const cells = {}
  for (const p of indoor) {
    const q = F.gameToSvg(p.x, p.z)
    const d = polys.some((poly) => inside(poly, q)) ? 0 : Math.min(...polys.map((poly) => distance(poly, q)))
    if (d <= 1) {
      ok++
      continue
    }
    const k = `${Math.round(q[0] / 25) * 25},${Math.round(q[1] / 25) * 25}`
    ;(cells[k] ??= []).push(`${p.name}@${Math.round(q[0])},${Math.round(q[1])} y${Math.round(p.y)} ${d.toFixed(0)}m`)
  }
  console.log(`${ok} of ${indoor.length} indoor-only spots (drawers, PC blocks, safes, cash registers, jackets, medcases, door locks; car trunks left out) lie in a drawn building (1 m tolerance)`)
  const list = Object.entries(cells).sort((a, b) => b[1].length - a[1].length)
  for (const [k, l] of opt('list') ? list : list.slice(0, 15)) console.log(`  ${k.padEnd(10)} ${l.length}  ${l.slice(0, 3).join(' | ')}`)
})()
