// Builds the updated Lighthouse drawing (lighthouse-2026.svg) in tarkov.dev's flat style.
//
//  - Layout (sea, land, forest, rock, sand, dirt, concrete, roads, buildings): specs/jindouz.json,
//    made by jindouz.cjs from Jindouz's September 2026 2D map placed on the game's own positions
//    (the game's indoor loot spots lie inside its buildings).
//  - Hand-drawn extras in game positions: the causeway, its road and the island jetty
//    (specs/island.json), the water plant's tanks and the terminal's rails (specs/extras.json).
//  - Minefields are the game's own outlines (json.tarkov.dev hazards, see hazards.cjs), shown only
//    where you can walk.
//  - Style and the playable-area border come from tarkov.dev's drawing (tarkov-dev-svg-maps).
// The viewBox and frame are tarkov.dev's, so the app places it with the same transform.
// Usage: build.cjs <tarkov-dev.svg> <mines.json> <out.svg>
const fs = require('fs')
const path = require('path')
const F = require('./frames.cjs')

const [oldFile, minesFile, outFile] = process.argv.slice(2)
const SPECS = path.join(__dirname, 'specs')
const layout = JSON.parse(fs.readFileSync(path.join(SPECS, 'jindouz.json'), 'utf8'))
const specs = ['island.json', 'extras.json'].map((f) => JSON.parse(fs.readFileSync(path.join(SPECS, f), 'utf8')))
const all = (layer) => specs.flatMap((s) => s[layer] ?? [])

// --- shapes ------------------------------------------------------------------------------------------
const r1 = (n) => Math.round(n * 10) / 10
const pts = (list) => list.map(([u, v]) => `${r1(u)} ${r1(v)}`).join(' L')
const ring = (list) => `M${pts(list)}Z`
const line = (list) => `M${pts(list)}`

function shapeCorners(s) {
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
const shapeSvg = (s) => (s.rad ? `<circle cx="${r1(s.c[0])}" cy="${r1(s.c[1])}" r="${r1(s.rad)}"/>` : `<path d="${ring(shapeCorners(s))}"/>`)
function lineSvg(s, cls) {
  const width = s.w ? ` style="stroke-width:${s.w}"` : ''
  return `<path class="${cls}"${width} d="${line(s.l)}"/>`
}
/** A camp: a trodden clearing with a tent (top view: canvas square with its ridge). */
function campSvg(s) {
  const [u, v] = s.c
  return `<g transform="translate(${r1(u)} ${r1(v)})"><circle class="tc26-camp-ground" r="6"/><path class="tc26-tent" d="M-2.6 -2.2 L2.6 -2.2 L2.6 2.2 L-2.6 2.2Z"/><path class="tc26-tent-ridge" d="M-2.6 0 L2.6 0"/></g>`
}

/** One even-odd path for a layer of rings (holes included). */
const evenOdd = (rings) => (rings.length ? `<path fill-rule="evenodd" d="${rings.map(ring).join('')}"/>` : '')

// --- tarkov.dev's drawing: style and border ---------------------------------------------------------
const old = fs.readFileSync(oldFile, 'utf8')
const style = /<style[^>]*>([\s\S]*?)<\/style>/.exec(old)[1]
function oldGroup(id) {
  const start = old.indexOf(`<g id="${id}"`)
  if (start < 0) return ''
  const open = old.indexOf('>', start) + 1
  return old.slice(open, old.indexOf('</g>', open))
}

// --- areas drawn by hand instead of the layout (roadblocks): its shapes there are left out -------------
const centre = (r) => r.reduce((a, [u, v]) => [a[0] + u / r.length, a[1] + v / r.length], [0, 0])
const replaced = (r) => {
  const [u, v] = centre(r)
  return all('replace').some(([a, b, c, d]) => u >= a && u <= c && v >= b && v <= d)
}
const buildings = layout.building.filter((r) => !replaced(r))
const vehicles = (layout.vehicle ?? []).filter((r) => !replaced(r))

// --- minefields (game data), clipped to where you can walk --------------------------------------------
const mines = JSON.parse(fs.readFileSync(minesFile, 'utf8'))
const walkable = `<path clip-rule="evenodd" d="${layout.land.map(ring).join('')}"/>` + [...all('cement'), ...all('wood')].map((s) => shapeSvg(s)).join('')

const g = (id, cls, inner) => `    <g id="${id}"${cls ? ` class="${cls}"` : ''}>${inner}</g>\n`
const out = `<svg xmlns="http://www.w3.org/2000/svg" width="${F.VIEW[0]}" height="${F.VIEW[1]}" viewBox="0 0 ${F.VIEW[0]} ${F.VIEW[1]}">
  <desc>Escape from Tarkov's Lighthouse as of September 2026 in tarkov.dev's flat map style. Layout from Jindouz's Lighthouse 2D map (EFT Wiki), placed on the game's own coordinates using its loot spots; causeway and jetty drawn over it; minefields from the game's data via tarkov.dev; style and map border from the tarkov.dev SVG maps (the-hideout/tarkov-dev-svg-maps, Shebuka and contributors). Licensed CC BY-NC-SA 4.0. Not for use in cheating software.</desc>
  <style>${style.trim()}
    .tc26-sand { fill:#cfc7a3 }
    .tc26-road { fill:#8a8a8a }
    .road_tarmac { stroke-linejoin:round; stroke-linecap:round }
    .tc26-mines { fill:#ff2a1a; fill-opacity:.25; stroke:#ff3b30; stroke-width:.7; stroke-opacity:.85 }
    .tc26-water { fill:#4a6b96; stroke:#c6c2c2; stroke-width:1.5 }
    .tc26-covered { fill:#c6c2c2; stroke:#8a8a8a; stroke-width:1 }
    .tc26-ring { fill:none; stroke:#c6c2c2; stroke-width:2 }
    .tc26-vehicle { fill:#4b5a66; stroke:#c6c2c2; stroke-width:.4 }
    .tc26-block { fill:#c6c2c2; stroke:#1a2632; stroke-width:.4 }
    .tc26-gantry { fill:none; stroke:#c6c2c2; stroke-width:1; stroke-dasharray:1.5,1 }
    .tc26-camp-ground { fill:#946d3e; fill-opacity:.7 }
    .tc26-tent { fill:#8a7f4e; stroke:#1a2632; stroke-width:.6 }
    .tc26-tent-ridge { fill:none; stroke:#1a2632; stroke-width:.6 }
  </style>
  <defs><clipPath id="tc26-walkable">${walkable}</clipPath></defs>
  <g id="Ground_Level" data-layer="Ground_Level">
    <rect class="water" x="0" y="0" width="${F.VIEW[0]}" height="${F.VIEW[1]}"/>
${g('land', 'land', evenOdd(layout.land))}${g('forest', 'trees', evenOdd(layout.forest))}${g('rock', 'rock', evenOdd(layout.rock))}${g('sand', 'tc26-sand', evenOdd(layout.sand))}${g('dirt', 'gravel', evenOdd(layout.dirt))}${g('concrete', 'cement', evenOdd(layout.concrete) + all('cement').map((s) => shapeSvg(s)).join(''))}${g('roads', 'tc26-road', evenOdd(layout.road))}${g('road_lines', '', all('roads').map((s) => lineSvg(s, 'road_tarmac')).join(''))}${g('railroad', '', all('rails').map((s) => lineSvg(s, 'railroad')).join(''))}${g('pier', 'wood', all('wood').map((s) => shapeSvg(s)).join(''))}${g('tanks', '', all('tanks').map((s) => shapeSvg(s).replace(/^<(\w+)/, `<$1 class="tc26-${s.kind}"`)).join(''))}${g('roadblocks', '', all('blocks').map((s) => shapeSvg(s).replace(/^<(\w+)/, '<$1 class="tc26-block"')).join('') + all('gantries').map((s) => lineSvg(s, 'tc26-gantry')).join(''))}${g('vehicles', 'tc26-vehicle', vehicles.map((r) => `<path d="${ring(r)}"/>`).join('') + all('vehicles').map((s) => shapeSvg(s)).join(''))}${g('buildings', 'building', buildings.map((r) => `<path d="${ring(r)}"/>`).join('') + all('buildings').map((s) => shapeSvg(s)).join(''))}${g('camps', '', all('camps').map(campSvg).join(''))}${g('limit', 'map_border', oldGroup('limit'))}    <g id="mines" class="tc26-mines" clip-path="url(#tc26-walkable)">${mines.map((m) => `<path d="${ring(m.p)}"/>`).join('')}</g>
  </g>
</svg>
`
fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, out)
console.log(`wrote ${outFile} (${(out.length / 1024).toFixed(0)} KB): ${buildings.length + all('buildings').length} buildings, ${vehicles.length + all('vehicles').length} vehicles, ${all('camps').length} camps, ${layout.road.length} road areas, ${all('tanks').length} tanks, ${mines.length} minefields`)
