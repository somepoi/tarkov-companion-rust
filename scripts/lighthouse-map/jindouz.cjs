// Today's Lighthouse layout from Jindouz's 2D map (EFT Wiki, September 2026), placed on the game's
// own coordinates and restyled in tarkov.dev's flat colours.
//
// Why: RE3MR's render drifts from the game (7-12 m at the water plant, about 70 m on Lightkeeper
// island), so containers and loot showed up beside their buildings. Jindouz's plan, fitted window by
// window to the game's own loot spots (loose loot, drawers, jackets, PC blocks, safes, door locks),
// puts those spots inside his buildings.
//
//   fetch                       downloads the picture to assets-src/lighthouse/ (SHA-256 checked)
//   fit --cache=points.json     local fits (shift / turn / scale per 260 m window) -> specs/jindouz-fits.json
//   extract                     every pixel sorted into water / forest / grass / rock / sand / concrete /
//                               road / dirt / building, labels and icons filled from their surroundings,
//                               outlines traced (marching squares), simplified and placed through the fits
//                               -> specs/jindouz.json (drawing units, read by build.cjs)
//   view <out.png> --box=u0,v0,u1,v1 [--px=3] [--cache=points.json]   the fitted picture with game points
//
// Single-threaded and done once per map update: build.cjs only reads specs/jindouz.json.
// Usage: node scripts/lighthouse-map/jindouz.cjs <command> [options]   (no Node here: ELECTRON_RUN_AS_NODE=1 electron.exe)
const fs = require('fs')
const path = require('path')
const F = require('./frames.cjs')

const PICTURE = path.join(F.ROOT, 'assets-src', 'lighthouse', 'jindouz-lighthouse-v1.webp')
const PICTURE_URL = 'https://static.wikia.nocookie.net/escapefromtarkov_gamepedia/images/1/13/Jindouz_Lighthouse_Map_V1.png/revision/latest'
const PICTURE_SHA256 = '36b6498dced2055475e6f7428a53542961ceb7412ac5101e56e2b6316605dc1c'
const SPECS = path.join(__dirname, 'specs')
const FITS = path.join(SPECS, 'jindouz-fits.json')
const OUT = path.join(SPECS, 'jindouz.json')

const args = process.argv.slice(2)
const command = args[0]
const opt = (k, d) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d

// --- global placement: affine picture px -> game x/z from the extract markers -----------------------
// (scripts/boss-areas/specs/lighthouse.json, measured on the 1152 x 2000 copies of this frame)
const bossSpec = JSON.parse(fs.readFileSync(path.join(F.ROOT, 'scripts', 'boss-areas', 'specs', 'lighthouse.json'), 'utf8'))
const PIC_SCALE = 2242 / 1152
const ctrl = bossSpec.points.map(([ix, iy, gx, gz]) => [ix * PIC_SCALE, iy * PIC_SCALE, gx, gz])
function leastSquares(rows, rhs) {
  const n = rows[0].length
  const A = Array.from({ length: n }, () => new Array(n + 1).fill(0))
  rows.forEach((r, k) => {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) A[i][j] += r[i] * r[j]
      A[i][n] += r[i] * rhs[k]
    }
  })
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r
    ;[A[c], A[p]] = [A[p], A[c]]
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = A[r][c] / A[c][c]
      for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k]
    }
  }
  return A.map((r, i) => r[n] / r[i])
}
const GX = leastSquares(ctrl.map(([ix, iy]) => [ix, iy, 1]), ctrl.map((p) => p[2]))
const GZ = leastSquares(ctrl.map(([ix, iy]) => [ix, iy, 1]), ctrl.map((p) => p[3]))
const DET = GX[0] * GZ[1] - GX[1] * GZ[0]
const picToGame = (px, py) => [GX[0] * px + GX[1] * py + GX[2], GZ[0] * px + GZ[1] * py + GZ[2]]
function gameToPic(x, z) {
  const a = x - GX[2]
  const b = z - GZ[2]
  return [(GZ[1] * a - GX[1] * b) / DET, (-GZ[0] * a + GX[0] * b) / DET]
}

// --- local fits ----------------------------------------------------------------------------------------
/** Where a globally placed picture point really is in the picture, for one window fit. */
function applyLocal(f, [px, py]) {
  const c = Math.cos((f.rot * Math.PI) / 180)
  const s = Math.sin((f.rot * Math.PI) / 180)
  const ax = px - f.cx
  const ay = py - f.cy
  return [f.cx + f.sc * (c * ax - s * ay) + f.dx, f.cy + f.sc * (s * ax + c * ay) + f.dy]
}
function undoLocal(f, [qx, qy]) {
  const c = Math.cos((-f.rot * Math.PI) / 180)
  const s = Math.sin((-f.rot * Math.PI) / 180)
  const ax = (qx - f.dx - f.cx) / f.sc
  const ay = (qy - f.dy - f.cy) / f.sc
  return [f.cx + c * ax - s * ay, f.cy + s * ax + c * ay]
}
const SIGMA = 110
const blendWeight = (f, [u, v]) => f.score * Math.exp(-((u - f.centre[0]) ** 2 + (v - f.centre[1]) ** 2) / (2 * SIGMA ** 2)) + 1e-12
function loadFits() {
  return JSON.parse(fs.readFileSync(FITS, 'utf8')).fits
}
/** Picture pixel -> drawing units through the window fits, blended by distance. */
function makePicToDrawing(fits) {
  return (q) => {
    let guess = F.gameToSvg(...picToGame(...q))
    for (let iter = 0; iter < 2; iter++) {
      let su = 0
      let sv = 0
      let sw = 0
      for (const f of fits) {
        const [u, v] = F.gameToSvg(...picToGame(...undoLocal(f, q)))
        const w = blendWeight(f, guess)
        su += w * u
        sv += w * v
        sw += w
      }
      guess = [su / sw, sv / sw]
    }
    return guess
  }
}
/** Drawing units -> picture pixel through the window fits (for views). */
function makeDrawingToPic(fits) {
  return (u, v) => {
    const g = gameToPic(...F.svgToGame(u, v))
    let sx = 0
    let sy = 0
    let sw = 0
    for (const f of fits) {
      const [x, y] = applyLocal(f, g)
      const w = blendWeight(f, [u, v])
      sx += w * x
      sy += w * y
      sw += w
    }
    return [sx / sw, sy / sw]
  }
}

// --- the picture and its colours -----------------------------------------------------------------------
async function loadPicture() {
  const sharp = require('sharp')
  sharp.concurrency(1)
  sharp.cache(false)
  if (!fs.existsSync(PICTURE)) throw new Error(`missing ${PICTURE}: run "jindouz.cjs fetch" first`)
  const { data, info } = await sharp(PICTURE).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, W: info.width, H: info.height }
}
// class ids; 0 = unknown (labels, icons, outlines), filled from the neighbours
const CLASSES = ['unknown', 'water', 'forest', 'grass', 'rock', 'sand', 'concrete', 'road', 'dirt', 'building']
const COLOURS = {
  water: [[104, 168, 216], [80, 136, 176], [80, 120, 144], [104, 168, 208], [112, 168, 200], [112, 168, 208], [88, 136, 168], [88, 136, 176], [80, 136, 168], [96, 176, 208]],
  forest: [[88, 112, 88], [72, 88, 72], [80, 88, 72], [96, 112, 96]],
  grass: [[120, 160, 120], [136, 176, 136], [120, 152, 120], [120, 160, 112], [112, 168, 128], [144, 176, 136], [120, 152, 112], [112, 160, 112], [144, 176, 144], [128, 160, 112], [128, 160, 128]],
  rock: [[80, 80, 80], [48, 48, 48], [72, 80, 72], [72, 80, 80], [80, 80, 72], [68, 81, 68]],
  sand: [[200, 200, 160], [192, 200, 160], [200, 216, 200], [208, 224, 192]],
  concrete: [[192, 192, 192]],
  road: [[96, 96, 88], [96, 96, 80], [104, 96, 88], [99, 96, 85]],
  dirt: [[184, 152, 120], [184, 152, 112], [192, 160, 112]],
  building: [[160, 168, 96], [160, 168, 104], [162, 160, 100], [176, 176, 128]],
}
const REFS = Object.entries(COLOURS).flatMap(([name, list]) => list.map((c) => [CLASSES.indexOf(name), c]))
// Jindouz shades some areas (the resort, the chalets) with a light cyan box (about 8 %): buildings
// and dirt there would otherwise read as grass
const tint = (c) => c.map((v, i) => Math.round(0.92 * v + 0.08 * [0, 255, 255][i]))
for (const name of ['building', 'dirt']) for (const c of COLOURS[name]) REFS.push([CLASSES.indexOf(name), tint(c)])
// shaded building fills measured in the resort (jindouz.cjs probe)
for (const c of [[152, 176, 112], [152, 176, 120], [152, 176, 128]]) REFS.push([CLASSES.indexOf('building'), c])
const MAX_COLOUR_DISTANCE = 30
// Jindouz's floor-plan panels, in drawing units as the fitted map shows them (jindouz.cjs view):
// their contents are not the map. What lies under each: sea, or 'ground' (the out-of-bounds
// forest east of the chalets: its own colours stay, only the plans go)
const INSETS = [
  [25, 120, 335, 285, 'water'], // water plant floors
  [275, 785, 335, 880, 'water'], // seaside houses
  [-40, 1280, 70, 1430, 'water'], // lighthouse floors
  [175, 1615, 335, 1705, 'water'], // Lightkeeper island houses
  [795, 745, 1070, 1255, 'ground'], // village, USEC cottage, chalet, sunken house
  [775, 1485, 1075, 1775, 'water'], // side tunnel
]

// --- fit ------------------------------------------------------------------------------------------------
const INDOOR = /drawer|jacket|pc block|safe|medcase|cash/i
async function fit() {
  const cache = opt('cache')
  if (!cache || !fs.existsSync(cache)) throw new Error('fit needs --cache=points.json (made by check.cjs)')
  const points = JSON.parse(fs.readFileSync(cache, 'utf8'))
    .filter((p) => p.k === 'loose' || (p.k === 'lock' && p.name === 'door') || (p.k === 'container' && INDOOR.test(p.name)))
    .map((p) => ({ ...p, uv: F.gameToSvg(p.x, p.z) }))
  const pic = await loadPicture()
  const near = (r, g, b, c) => Math.abs(r - c[0]) + Math.abs(g - c[1]) + Math.abs(b - c[2]) < 38
  const isBuilding = (x, y) => {
    if (x < 0 || y < 0 || x >= pic.W || y >= pic.H) return false
    const i = 3 * (y * pic.W + x)
    return near(pic.data[i], pic.data[i + 1], pic.data[i + 2], [162, 160, 100])
  }
  const onBuilding = (x, y) => isBuilding(x, y) || isBuilding(x + 1, y) || isBuilding(x - 1, y) || isBuilding(x, y + 1) || isBuilding(x, y - 1)
  const windows = []
  const SIZE = 260
  for (let cu = 80; cu <= 960; cu += 130) for (let cv = 40; cv <= 1640; cv += 130) windows.push([cu, cv])
  const fits = []
  for (const [cu, cv] of windows) {
    const pts = points.filter((p) => Math.abs(p.uv[0] - cu) <= SIZE / 2 && Math.abs(p.uv[1] - cv) <= SIZE / 2)
    if (pts.length < 30) continue
    const base = pts.map((p) => gameToPic(p.x, p.z))
    const cx = base.reduce((a, b) => a + b[0], 0) / base.length
    const cy = base.reduce((a, b) => a + b[1], 0) / base.length
    let before = 0
    for (const [x, y] of base) if (onBuilding(Math.round(x), Math.round(y))) before++
    let best = { score: -1 }
    const R = 60
    for (let sc = 0.9; sc <= 1.101; sc += 0.05)
      for (let rot = -10; rot <= 10; rot += 2) {
        const c = Math.cos((rot * Math.PI) / 180)
        const s = Math.sin((rot * Math.PI) / 180)
        for (let dx = -R; dx <= R; dx += 2)
          for (let dy = -R; dy <= R; dy += 2) {
            let n = 0
            for (const [x, y] of base) {
              const ax = x - cx
              const ay = y - cy
              if (onBuilding(Math.round(cx + sc * (c * ax - s * ay) + dx), Math.round(cy + sc * (s * ax + c * ay) + dy))) n++
            }
            const size = Math.hypot(dx, dy) + Math.abs(rot) + 20 * Math.abs(sc - 1)
            if (n > best.score || (n === best.score && size < best.size)) best = { score: n, sc: Number(sc.toFixed(2)), rot, dx, dy, size }
          }
      }
    const share = best.score / pts.length
    const f = { centre: [cu, cv], points: pts.length, before, score: best.score, share: Number(share.toFixed(2)), sc: best.sc, rot: best.rot, dx: best.dx, dy: best.dy, cx: Number(cx.toFixed(1)), cy: Number(cy.toFixed(1)) }
    console.log(`window ${cu},${cv}: ${pts.length} spots, on buildings ${before} -> ${best.score} (${Math.round(share * 100)}%), scale ${f.sc} turn ${f.rot} shift ${f.dx},${f.dy} px`)
    fits.push(f)
  }
  // a fit only counts when it explains most spots and agrees with its neighbours
  const kept = fits.filter((f) => {
    if (f.share < 0.35) return false
    const nb = fits.filter((g) => g !== f && Math.hypot(g.centre[0] - f.centre[0], g.centre[1] - f.centre[1]) < 200 && g.share >= 0.35)
    if (!nb.length) return true
    const mx = nb.reduce((a, g) => a + g.dx, 0) / nb.length
    const my = nb.reduce((a, g) => a + g.dy, 0) / nb.length
    return Math.hypot(f.dx - mx, f.dy - my) < 40
  })
  fs.writeFileSync(
    FITS,
    JSON.stringify(
      {
        about: 'Local fits of Jindouz\'s Lighthouse map (2242 x 3892 px) to the game\'s indoor loot spots: per 260-unit window, the shift / turn / scale (around cx, cy, picture px) that puts the most spots on building pixels. Made by jindouz.cjs fit; extract blends them by distance (sigma 110 units).',
        fits: kept,
      },
      null,
      1,
    ) + '\n',
  )
  console.log(`kept ${kept.length} of ${fits.length} window fits`)
}

// --- extract --------------------------------------------------------------------------------------------
async function extract() {
  const pic = await loadPicture()
  const { W, H, data } = pic
  const fits = loadFits()
  const toDrawing = makePicToDrawing(fits)
  // 1. nearest reference colour
  const cls = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) {
    const r = data[3 * i]
    const g = data[3 * i + 1]
    const b = data[3 * i + 2]
    let best = 0
    let bd = MAX_COLOUR_DISTANCE
    for (const [id, c] of REFS) {
      const d = Math.abs(r - c[0]) + Math.abs(g - c[1]) + Math.abs(b - c[2])
      if (d < bd) {
        bd = d
        best = id
      }
    }
    cls[i] = best
  }
  // 2. not the map: labels and icons (bright, saturated colours, plus 3 px for their black outline)
  //    and the floor-plan insets; specks under 50 px left over from them
  const WATER = CLASSES.indexOf('water')
  const text = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) {
    const r = data[3 * i]
    const g = data[3 * i + 1]
    const b = data[3 * i + 2]
    if (Math.max(r, g, b) - Math.min(r, g, b) > 150) text[i] = 1
  }
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (!text[y * W + x]) continue
      for (let dy = -3; dy <= 3; dy++)
        for (let dx = -3; dx <= 3; dx++) {
          const xx = x + dx
          const yy = y + dy
          if (xx >= 0 && yy >= 0 && xx < W && yy < H) cls[yy * W + xx] = 0
        }
    }
  const plain = new Set(['forest', 'grass', 'rock'].map((n) => CLASSES.indexOf(n)))
  const toPic = makeDrawingToPic(fits)
  for (const [a, b, c, d, fill] of INSETS) {
    const quad = [[a, b], [c, b], [c, d], [a, d]].map(([u, v]) => toPic(u, v))
    const xs = quad.map((q) => q[0])
    const ys = quad.map((q) => q[1])
    for (let y = Math.max(0, Math.floor(Math.min(...ys))); y <= Math.min(H - 1, Math.ceil(Math.max(...ys))); y++)
      for (let x = Math.max(0, Math.floor(Math.min(...xs))); x <= Math.min(W - 1, Math.ceil(Math.max(...xs))); x++) {
        if (!insidePolygon(quad, x, y)) continue
        const i = y * W + x
        cls[i] = fill === 'ground' ? (plain.has(cls[i]) ? cls[i] : 0) : CLASSES.indexOf(fill)
      }
  }
  const BUILDING = CLASSES.indexOf('building')
  // (sheds are small but real: buildings keep anything from 20 px)
  removeSpecks(cls, W, H, (c) => (c === BUILDING ? 20 : 50))
  // buildings take their own black outline (up to 4 px with its soft edge), but never grow into labels or icons:
  // everything else unknown becomes ground (a label over wagons must not turn into a building)
  for (let pass = 0; pass < 4; pass++) {
    const grow = []
    for (let i = 0; i < W * H; i++) {
      if (cls[i] || text[i]) continue
      const x = i % W
      if ((x > 0 && cls[i - 1] === BUILDING) || (x < W - 1 && cls[i + 1] === BUILDING) || cls[i - W] === BUILDING || cls[i + W] === BUILDING) grow.push(i)
    }
    for (const i of grow) cls[i] = BUILDING
  }
  fillUnknown(cls, W, H, WATER, new Set([BUILDING]))
  // 4. majority smoothing (two passes) against speckles
  for (let pass = 0; pass < 2; pass++) {
    const next = Uint8Array.from(cls)
    for (let y = 1; y < H - 1; y++)
      for (let x = 1; x < W - 1; x++) {
        const count = new Uint8Array(CLASSES.length)
        let top = cls[y * W + x]
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) count[cls[(y + dy) * W + x + dx]]++
        for (let c = 1; c < CLASSES.length; c++) if (count[c] > count[top]) top = c
        if (count[top] >= 5) next[y * W + x] = top
      }
    cls.set(next)
  }
  // 5. outlines per layer (painter's order: land under everything, then the rest on top)
  const layers = {
    land: { has: (c) => c !== WATER, eps: 1.6, minArea: 80 },
    forest: { has: (c) => c === CLASSES.indexOf('forest'), eps: 1.6, minArea: 80 },
    rock: { has: (c) => c === CLASSES.indexOf('rock'), eps: 1.6, minArea: 60 },
    sand: { has: (c) => c === CLASSES.indexOf('sand'), eps: 1.5, minArea: 60 },
    dirt: { has: (c) => c === CLASSES.indexOf('dirt'), eps: 1.2, minArea: 40 },
    concrete: { has: (c) => c === CLASSES.indexOf('concrete'), eps: 1.2, minArea: 40 },
    road: { has: (c) => c === CLASSES.indexOf('road'), eps: 1.2, minArea: 40 },
    // from 25 px (about 6.5 m2): cars count; vehicles are split off below
    building: { has: (c) => c === CLASSES.indexOf('building'), eps: 1.0, minArea: 25, solid: true },
  }
  const out = {}
  for (const [name, L] of Object.entries(layers)) {
    const mask = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) mask[i] = L.has(cls[i]) ? 1 : 0
    const loops = marchingSquares(mask, W, H)
      .map((loop) => ({ loop, area: ringArea(loop) }))
      .filter(({ area }) => Math.abs(area) >= L.minArea)
    // buildings: outer outlines only (courtyards filled), one shape each
    const keep = L.solid ? loops.filter(({ area }) => area > 0) : loops
    out[name] = keep
      .map(({ loop }) => {
        const r = simplifyRing(loop, L.eps).map((q) => toDrawing(q))
        return (L.solid ? squareUp(r) : r).map((p) => p.map((n) => Math.round(n * 10) / 10))
      })
      .filter((r) => r.length >= 3)
    console.log(`${name}: ${out[name].length} outlines`)
  }
  // Jindouz draws vehicles (the roadblocks' trucks, the UN checkpoint, cars) like small buildings:
  // a narrow outline under 40 m2 is a vehicle
  const vehicle = []
  out.building = out.building.filter((r) => {
    const { w, h } = mainRect(r)
    const isVehicle = w * h <= 40 && Math.max(w, h) >= 1.7 * Math.min(w, h)
    if (isVehicle) vehicle.push(r)
    return !isVehicle
  })
  out.vehicle = vehicle
  console.log(`building: ${out.building.length} after ${vehicle.length} vehicles split off`)
  out.camps = findCamps(pic, toDrawing).filter(([u, v]) => !INSETS.some(([a, b, c, d]) => u >= a && u <= c && v >= b && v <= d))
  fs.writeFileSync(
    OUT,
    JSON.stringify({
      about: "Generated by jindouz.cjs extract from Jindouz's Lighthouse 2D map (EFT Wiki, September 2026), placed by specs/jindouz-fits.json. Rings in drawing units; land, forest, rock, sand, dirt, concrete and road are drawn with the even-odd rule (holes included), buildings and vehicles one shape each; camps = where his tent icons stand (build.cjs draws only the ones listed in extras.json, checked by eye).",
      ...out,
    }) + '\n',
  )
  console.log(`wrote ${OUT}`)
}

function insidePolygon(poly, x, y) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
/** Sets every same-class patch smaller than `min(class)` pixels to unknown (0). */
function removeSpecks(cls, W, H, min) {
  const seen = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) {
    if (seen[i] || !cls[i]) continue
    const c = cls[i]
    const stack = [i]
    const members = []
    seen[i] = 1
    while (stack.length) {
      const j = stack.pop()
      members.push(j)
      const x = j % W
      const y = (j - x) / W
      if (x > 0 && !seen[j - 1] && cls[j - 1] === c) { seen[j - 1] = 1; stack.push(j - 1) }
      if (x < W - 1 && !seen[j + 1] && cls[j + 1] === c) { seen[j + 1] = 1; stack.push(j + 1) }
      if (y > 0 && !seen[j - W] && cls[j - W] === c) { seen[j - W] = 1; stack.push(j - W) }
      if (y < H - 1 && !seen[j + W] && cls[j + W] === c) { seen[j + W] = 1; stack.push(j + W) }
    }
    if (members.length < min(c)) for (const j of members) cls[j] = 0
  }
}
/**
 * Gives each unknown pixel the most common class among its known neighbours, growing in from the
 * edges. Classes in `exclude` do not spread (a gap they enclose is filled without the rule after).
 */
function fillUnknown(cls, W, H, fallback, exclude = new Set()) {
  let frontier = []
  const queued = new Uint8Array(W * H)
  const spreads = (c) => c && !exclude.has(c)
  const knownNeighbour = (j) => {
    const x = j % W
    const y = (j - x) / W
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx
        const yy = y + dy
        if ((dx || dy) && xx >= 0 && yy >= 0 && xx < W && yy < H && spreads(cls[yy * W + xx])) return true
      }
    return false
  }
  for (let i = 0; i < W * H; i++)
    if (!cls[i] && knownNeighbour(i)) {
      frontier.push(i)
      queued[i] = 1
    }
  while (frontier.length) {
    const assigned = []
    for (const j of frontier) {
      const x = j % W
      const y = (j - x) / W
      const count = new Uint16Array(CLASSES.length)
      let top = 0
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          const yy = y + dy
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue
          const c = cls[yy * W + xx]
          if (spreads(c) && ++count[c] > count[top]) top = c
        }
      assigned.push([j, top])
    }
    const next = []
    for (const [j, c] of assigned) cls[j] = c
    for (const [j] of assigned) {
      const x = j % W
      const y = (j - x) / W
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          const yy = y + dy
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue
          const k = yy * W + xx
          if (!cls[k] && !queued[k]) {
            queued[k] = 1
            next.push(k)
          }
        }
    }
    frontier = next
  }
  if (exclude.size) return fillUnknown(cls, W, H, fallback)
  for (let i = 0; i < W * H; i++) if (!cls[i]) cls[i] = fallback
}

/** Closed outlines of a 0/1 mask, in picture pixels (pixel centres at x + 0.5). Outer rings and holes run opposite ways. */
function marchingSquares(mask, W, H) {
  const at = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? mask[y * W + x] : 0)
  // directed edges between edge midpoints, keyed by their start point; inside stays on the left
  const next = new Map()
  const key = (x, y) => `${x},${y}`
  const add = (a, b) => next.set(key(...a), b)
  for (let y = -1; y < H; y++)
    for (let x = -1; x < W; x++) {
      const tl = at(x, y)
      const tr = at(x + 1, y)
      const br = at(x + 1, y + 1)
      const bl = at(x, y + 1)
      const code = tl * 8 + tr * 4 + br * 2 + bl
      if (code === 0 || code === 15) continue
      // midpoints in doubled pixel-centre units to stay integer
      const T = [2 * x + 2, 2 * y + 1]
      const R = [2 * x + 3, 2 * y + 2]
      const B = [2 * x + 2, 2 * y + 3]
      const Lm = [2 * x + 1, 2 * y + 2]
      switch (code) {
        case 1: add(Lm, B); break
        case 2: add(B, R); break
        case 3: add(Lm, R); break
        case 4: add(R, T); break
        case 5: add(Lm, T); add(R, B); break
        case 6: add(B, T); break
        case 7: add(Lm, T); break
        case 8: add(T, Lm); break
        case 9: add(T, B); break
        case 10: add(T, R); add(B, Lm); break
        case 11: add(T, R); break
        case 12: add(R, Lm); break
        case 13: add(R, B); break
        case 14: add(B, Lm); break
      }
    }
  const loops = []
  for (const [startKey] of next) {
    if (!next.has(startKey)) continue
    const loop = []
    let k = startKey
    while (next.has(k)) {
      const [x, y] = k.split(',').map(Number)
      loop.push([x / 2, y / 2])
      const b = next.get(k)
      next.delete(k)
      k = key(...b)
    }
    if (loop.length >= 3) loops.push(loop)
  }
  return loops
}
/** Signed area (positive = the orientation outer rings get above). */
function ringArea(ring) {
  let a = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1])
  return a / 2
}
/** Douglas-Peucker on a closed ring (split at the point farthest from the first). */
/** Width and height of an outline's smallest bounding box over all directions (drawing units). */
function mainRect(ring) {
  let best = { a: Infinity, w: 0, h: 0 }
  for (let deg = 0; deg < 90; deg += 2) {
    const t = (deg * Math.PI) / 180
    const c = Math.cos(t)
    const s = Math.sin(t)
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
    for (const [u, v] of ring) {
      const x = u * c + v * s
      const y = -u * s + v * c
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
    }
    if ((x1 - x0) * (y1 - y0) < best.a) best = { a: (x1 - x0) * (y1 - y0), w: x1 - x0, h: y1 - y0 }
  }
  return best
}

/**
 * Straightens a building outline to right angles along its main direction (drawing units):
 * near-horizontal edges get one y, near-vertical ones one x, steps under 1 m go. Outlines that are
 * not really rectangular (the lighthouse, angled wings) keep their shape: the squared one is used
 * only when its area stays within 12 % and it does not turn inside out.
 */
function squareUp(ring) {
  if (ring.length < 4) return ring
  const area = (r) => r.reduce((a, p, i) => { const q = r[(i + 1) % r.length]; return a + p[0] * q[1] - q[0] * p[1] }, 0) / 2
  // main direction: the angle (mod 90) whose bounding box is smallest
  let best = { a: Infinity, t: 0 }
  for (let deg = 0; deg < 90; deg += 1) {
    const t = (deg * Math.PI) / 180
    const c = Math.cos(t)
    const s = Math.sin(t)
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
    for (const [u, v] of ring) {
      const x = u * c + v * s
      const y = -u * s + v * c
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
    }
    const a = (x1 - x0) * (y1 - y0)
    if (a < best.a) best = { a, t }
  }
  const c = Math.cos(best.t)
  const s = Math.sin(best.t)
  const rot = ring.map(([u, v]) => [u * c + v * s, -u * s + v * c])
  // edges as horizontal (y = const) or vertical (x = const), merged when consecutive and alike
  const edges = []
  for (let i = 0; i < rot.length; i++) {
    const [ax, ay] = rot[i]
    const [bx, by] = rot[(i + 1) % rot.length]
    const len = Math.hypot(bx - ax, by - ay)
    if (len < 1e-6) continue
    const horizontal = Math.abs(bx - ax) >= Math.abs(by - ay)
    const value = horizontal ? (ay + by) / 2 : (ax + bx) / 2
    const last = edges[edges.length - 1]
    if (last && last.horizontal === horizontal) {
      last.value = (last.value * last.len + value * len) / (last.len + len)
      last.len += len
    } else edges.push({ horizontal, value, len })
  }
  if (edges.length > 1 && edges[0].horizontal === edges[edges.length - 1].horizontal) {
    const a = edges.pop()
    edges[0].value = (edges[0].value * edges[0].len + a.value * a.len) / (edges[0].len + a.len)
    edges[0].len += a.len
  }
  // drop short steps (a short edge between two alike edges): merge those three
  for (let changed = true; changed && edges.length > 4; ) {
    changed = false
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i]
      if (e.len >= 1) continue
      const prev = edges[(i - 1 + edges.length) % edges.length]
      const next = edges[(i + 1) % edges.length]
      if (prev.horizontal !== next.horizontal) continue
      prev.value = (prev.value * prev.len + next.value * next.len) / (prev.len + next.len)
      prev.len += next.len + e.len
      edges.splice(i, 1)
      edges.splice(edges.indexOf(next), 1)
      changed = true
      break
    }
  }
  if (edges.length < 4 || edges.length % 2) return ring
  const corners = edges.map((e, i) => {
    const n = edges[(i + 1) % edges.length]
    return e.horizontal ? [n.value, e.value] : [e.value, n.value]
  })
  const squared = corners.map(([x, y]) => [x * c - y * s, x * s + y * c])
  const a0 = area(ring)
  const a1 = area(squared)
  if (Math.sign(a0) !== Math.sign(a1) || Math.abs(a1 - a0) > 0.12 * Math.abs(a0)) return ring
  return squared
}

function simplifyRing(ring, eps) {
  const dp = (pts) => {
    if (pts.length < 3) return pts
    const [ax, ay] = pts[0]
    const [bx, by] = pts[pts.length - 1]
    const len = Math.hypot(bx - ax, by - ay) || 1
    let idx = 0
    let dmax = 0
    for (let i = 1; i < pts.length - 1; i++) {
      const d = Math.abs((by - ay) * pts[i][0] - (bx - ax) * pts[i][1] + bx * ay - by * ax) / len
      if (d > dmax) {
        dmax = d
        idx = i
      }
    }
    if (dmax <= eps) return [pts[0], pts[pts.length - 1]]
    return [...dp(pts.slice(0, idx + 1)).slice(0, -1), ...dp(pts.slice(idx))]
  }
  let far = 0
  let fd = -1
  ring.forEach(([x, y], i) => {
    const d = Math.hypot(x - ring[0][0], y - ring[0][1])
    if (d > fd) {
      fd = d
      far = i
    }
  })
  const a = dp(ring.slice(0, far + 1))
  const b = dp([...ring.slice(far), ring[0]])
  return [...a.slice(0, -1), ...b.slice(0, -1)]
}

// --- view -----------------------------------------------------------------------------------------------
async function view() {
  const sharp = require('sharp')
  const out = args[1]
  const [u0, v0, u1, v1] = opt('box').split(',').map(Number)
  const PX = Number(opt('px', '3'))
  const W = Math.round((u1 - u0) * PX)
  const H = Math.round((v1 - v0) * PX)
  const pic = await loadPicture()
  const toPic = makeDrawingToPic(loadFits())
  const img = Buffer.alloc(W * H * 3)
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const [px, py] = toPic(u0 + (i + 0.5) / PX, v0 + (j + 0.5) / PX)
      const x = Math.round(px)
      const y = Math.round(py)
      if (x < 0 || y < 0 || x >= pic.W || y >= pic.H) continue
      for (let c = 0; c < 3; c++) img[3 * (j * W + i) + c] = pic.data[3 * (y * pic.W + x) + c]
    }
  const g = []
  const X = (u) => (u - u0) * PX
  const Y = (v) => (v - v0) * PX
  for (let u = Math.ceil(u0 / 25) * 25; u <= u1; u += 25) g.push(`<line x1="${X(u)}" y1="0" x2="${X(u)}" y2="${H}" stroke="#fff" stroke-opacity="0.35"/><text x="${X(u) + 2}" y="11" font-size="10" font-family="Arial" fill="#ff0" stroke="#000" stroke-width="3" paint-order="stroke">${u}</text>`)
  for (let v = Math.ceil(v0 / 25) * 25; v <= v1; v += 25) g.push(`<line x1="0" y1="${Y(v)}" x2="${W}" y2="${Y(v)}" stroke="#fff" stroke-opacity="0.35"/><text x="2" y="${Y(v) - 2}" font-size="10" font-family="Arial" fill="#ff0" stroke="#000" stroke-width="3" paint-order="stroke">${v}</text>`)
  if (opt('cache')) {
    const C = { lock: '#ff2020', container: '#ffe600', extract: '#00e5ff', switch: '#39ff14', gun: '#ff8c00', loose: '#ff4dff' }
    for (const p of JSON.parse(fs.readFileSync(opt('cache'), 'utf8'))) {
      const [u, v] = F.gameToSvg(p.x, p.z)
      if (u < u0 || u > u1 || v < v0 || v > v1) continue
      g.push(`<circle cx="${X(u)}" cy="${Y(v)}" r="${p.k === 'loose' ? 1.8 : 2.5}" fill="${C[p.k]}" stroke="#000" stroke-width="0.6"/>`)
    }
  }
  await sharp(img, { raw: { width: W, height: H, channels: 3 } })
    .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${g.join('')}</svg>`) }])
    .png()
    .toFile(out)
  console.log(out, W, 'x', H)
}

async function fetchPicture() {
  const crypto = require('crypto')
  const res = await fetch(PICTURE_URL, { headers: { Referer: 'https://escapefromtarkov.fandom.com/', 'User-Agent': 'Mozilla/5.0' } })
  if (!res.ok) throw new Error(`download failed: ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const sha = crypto.createHash('sha256').update(buf).digest('hex')
  if (sha !== PICTURE_SHA256) throw new Error(`unexpected picture (sha256 ${sha}); if Jindouz updated the map, check it and update PICTURE_SHA256`)
  fs.mkdirSync(path.dirname(PICTURE), { recursive: true })
  fs.writeFileSync(PICTURE, buf)
  console.log(`saved ${PICTURE} (${buf.length} bytes)`)
}

/** probe --box=u0,v0,u1,v1: the picture's most common colours there (rounded to 8), for tuning COLOURS */
async function probe() {
  const pic = await loadPicture()
  const toPic = makeDrawingToPic(loadFits())
  const [u0, v0, u1, v1] = opt('box').split(',').map(Number)
  const h = {}
  for (let u = u0; u <= u1; u += 0.5)
    for (let v = v0; v <= v1; v += 0.5) {
      const [px, py] = toPic(u, v).map(Math.round)
      const i = 3 * (py * pic.W + px)
      const k = [pic.data[i], pic.data[i + 1], pic.data[i + 2]].map((c) => Math.round(c / 8) * 8).join(',')
      h[k] = (h[k] ?? 0) + 1
    }
  console.log(Object.entries(h).sort((a, b) => b[1] - a[1]).slice(0, 16).map(([k, n]) => `${k}:${n}`).join('  '))
}

/** Jindouz's camp icons (a small tent in very dark red, about (24, 0, 0)) in drawing units. */
function findCamps(pic, toDrawing) {
  const { W, H, data } = pic
  const isTent = (i) => data[3 * i] >= 12 && data[3 * i] <= 44 && data[3 * i + 1] <= 14 && data[3 * i + 2] <= 14
  const seen = new Uint8Array(W * H)
  const camps = []
  for (let i = 0; i < W * H; i++) {
    if (seen[i] || !isTent(i)) continue
    const stack = [i]
    seen[i] = 1
    let n = 0
    let sx = 0
    let sy = 0
    let x0 = W
    let x1 = 0
    let y0 = H
    let y1 = 0
    while (stack.length) {
      const j = stack.pop()
      const x = j % W
      const y = (j - x) / W
      n++
      sx += x
      sy += y
      x0 = Math.min(x0, x)
      x1 = Math.max(x1, x)
      y0 = Math.min(y0, y)
      y1 = Math.max(y1, y)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          const yy = y + dy
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue
          const k = yy * W + xx
          if (!seen[k] && isTent(k)) {
            seen[k] = 1
            stack.push(k)
          }
        }
    }
    // the icon is about 14 x 14 px; its body is a solid triangle (about half its box filled)
    const w = x1 - x0 + 1
    const h = y1 - y0 + 1
    if (n < 40 || n > 400 || w < 8 || h < 8 || w > 30 || h > 30 || n / (w * h) < 0.25) continue
    camps.push(toDrawing([sx / n, (y0 + y1) / 2 + 0.5]).map((v) => Math.round(v * 10) / 10))
  }
  return camps
}

/** camps: lists the camp icons found (drawing units) */
async function camps() {
  const pic = await loadPicture()
  const list = findCamps(pic, makePicToDrawing(loadFits()))
  for (const c of list) console.log(c.join(','))
  console.log(`${list.length} camps`)
}

const commands = { fetch: fetchPicture, fit, extract, view, probe, camps }
if (!commands[command]) {
  console.log('usage: jindouz.cjs fetch | fit --cache=points.json | extract | view <out.png> --box=u0,v0,u1,v1 [--px=3] [--cache=points.json]')
  process.exit(1)
}
commands[command]().catch((e) => {
  console.log('FAILED', e.message)
  process.exit(1)
})
