// Coordinate frames for the Lighthouse drawing (scripts/lighthouse-map).
//
//   game (x, z) metres  <->  drawing units (u, v) of tarkov.dev's Lighthouse.svg  <->  RE3MR render pixels
//
// The drawing is placed the way the app (Leaflet's svgOverlay) places it: its viewBox fills the
// pixel box of the map's `bounds` under tarkov.dev's transform, scaled uniformly ("meet") and
// centred. One drawing unit is about one metre: u ≈ 515 − x, v ≈ z + 998.
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')

/** tarkov.dev's Lighthouse entry (src/data/mapConfig.json): transform [0.2, 0, 0.2, 0], rotation 180. */
const TD_AFFINE = [-0.2, 0, 0, 0, 0.2, 0]
const TD_BOUNDS = [[515, -998], [-545, 725]]
/** viewBox of the drawing (old and new keep the same frame, so the app needs no new transform). */
const VIEW = [1059.3752, 1722.9499]

const px = (x, z) => [TD_AFFINE[0] * x + TD_AFFINE[1] * z + TD_AFFINE[2], TD_AFFINE[3] * x + TD_AFFINE[4] * z + TD_AFFINE[5]]
const corners = TD_BOUNDS.map(([x, z]) => px(x, z))
const minX = Math.min(corners[0][0], corners[1][0])
const minY = Math.min(corners[0][1], corners[1][1])
const boxW = Math.abs(corners[0][0] - corners[1][0])
const boxH = Math.abs(corners[0][1] - corners[1][1])
const S = Math.min(boxW / VIEW[0], boxH / VIEW[1])
const OFF = [(boxW - VIEW[0] * S) / 2, (boxH - VIEW[1] * S) / 2]

/** Drawing units → game metres. */
function svgToGame(u, v) {
  const zx = minX + OFF[0] + u * S
  const zy = minY + OFF[1] + v * S
  // invert TD_AFFINE (diagonal)
  return [zx / TD_AFFINE[0], zy / TD_AFFINE[4]]
}

/** Game metres → drawing units. */
function gameToSvg(x, z) {
  const [zx, zy] = px(x, z)
  return [(zx - minX - OFF[0]) / S, (zy - minY - OFF[1]) / S]
}

/** RE3MR render (8259 × 7560 px); zoom-0 pixels × 64 = render pixels. */
const RENDER = path.join(ROOT, 'assets-src', 'lighthouse', 're3mrLighthouseVERT.png')
const RENDER_SIZE = [8259, 7560]

/** The app's current fit of the render (src/maps/mapConfig.ts RE3MR_LIGHTHOUSE_AFFINE), zoom-0 pixels. */
function appRenderAffine() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'maps', 'mapConfig.ts'), 'utf8')
  const m = /RE3MR_LIGHTHOUSE_AFFINE: Affine = \[([^\]]+)\]/.exec(src)
  if (!m) throw new Error('RE3MR_LIGHTHOUSE_AFFINE not found')
  return m[1].split(',').map(Number)
}

/** Game → render pixels for a zoom-0 affine. */
function gameToRender(affine, x, z) {
  const [a, b, c, d, e, f] = affine
  return [64 * (a * x + b * z + c), 64 * (d * x + e * z + f)]
}

/** 2×3 matrix [a, b, c, d, e, f] (x' = a·u + b·v + c, y' = d·u + e·v + f) of drawing units → render pixels × scale. */
function svgToRenderMatrix(affine, scale = 1) {
  const o = gameToRender(affine, ...svgToGame(0, 0))
  const ux = gameToRender(affine, ...svgToGame(1, 0))
  const vy = gameToRender(affine, ...svgToGame(0, 1))
  return [(ux[0] - o[0]) * scale, (vy[0] - o[0]) * scale, o[0] * scale, (ux[1] - o[1]) * scale, (vy[1] - o[1]) * scale, o[1] * scale]
}

function invert([a, b, c, d, e, f]) {
  const det = a * e - b * d
  const ia = e / det
  const ib = -b / det
  const id = -d / det
  const ie = a / det
  return [ia, ib, -(ia * c + ib * f), id, ie, -(id * c + ie * f)]
}

/** The drawing's groups as SVG text (everything inside the outer <svg>), without its own <style>. */
function svgInner(file) {
  const s = fs.readFileSync(file, 'utf8')
  const start = s.indexOf('>', s.indexOf('<svg')) + 1
  const end = s.lastIndexOf('</svg>')
  return s.slice(start, end).replace(/<style[\s\S]*?<\/style>/, '')
}

/** Full-resolution tiles of the render (npm run tiles:lighthouse): reading a few 256 px tiles is far lighter than decoding the 62-megapixel PNG. */
const TILES = path.join(ROOT, 'public', 'tiles', 'lighthouse-re3mr', '6')

/** Raw RGB pixels of a region of the render, from the tiles when they exist, else from the PNG. */
async function renderRegion(left, top, width, height) {
  const sharp = require('sharp')
  sharp.concurrency(1)
  sharp.cache(false)
  if (!fs.existsSync(TILES)) {
    const { data } = await sharp(RENDER, { limitInputPixels: false }).extract({ left, top, width, height }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    return data
  }
  const out = Buffer.alloc(width * height * 3)
  for (let ty = Math.floor(top / 256); ty <= Math.floor((top + height - 1) / 256); ty++)
    for (let tx = Math.floor(left / 256); tx <= Math.floor((left + width - 1) / 256); tx++) {
      const file = path.join(TILES, String(tx), `${ty}.png`)
      if (!fs.existsSync(file)) continue
      const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true })
      for (let y = 0; y < info.height; y++) {
        const gy = ty * 256 + y - top
        if (gy < 0 || gy >= height) continue
        for (let x = 0; x < info.width; x++) {
          const gx = tx * 256 + x - left
          if (gx < 0 || gx >= width) continue
          const s = 3 * (y * info.width + x)
          const d = 3 * (gy * width + gx)
          out[d] = data[s]
          out[d + 1] = data[s + 1]
          out[d + 2] = data[s + 2]
        }
      }
    }
  return out
}

module.exports = { ROOT, VIEW, svgToGame, gameToSvg, RENDER, RENDER_SIZE, appRenderAffine, gameToRender, svgToRenderMatrix, invert, svgInner, renderRegion }
