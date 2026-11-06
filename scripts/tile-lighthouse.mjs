// Slices RE3MR's Lighthouse render into a Leaflet tile pyramid.
// Source: https://reemr.se/maps/Lighthouse/re3mrLighthouseVERT.png (CC BY-NC-SA 4.0, by re3mr / reemr.se)
// Output: public/tiles/lighthouse-re3mr/{z}/{x}/{y}.png  (256 px tiles, zoom 0 = whole image in one tile)
// Usage:  npm run tiles:lighthouse
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import crypto from 'node:crypto'
import { generatedPath, root } from './lib/content-assets.mjs'

const SRC = generatedPath('assets-src/lighthouse/re3mrLighthouseVERT.png')
const DEST = generatedPath('public/tiles/lighthouse-re3mr')
const TILE = 256

if (!fs.existsSync(SRC)) {
  console.error(`Missing ${SRC}. Download it first:\n  curl -L -o ${SRC} https://reemr.se/maps/Lighthouse/re3mrLighthouseVERT.png`)
  process.exit(1)
}
sharp.cache(false)
const meta = await sharp(SRC, { limitInputPixels: false }).metadata()
const zmax = Math.ceil(Math.log2(Math.max(meta.width, meta.height) / TILE))
console.log(`source ${meta.width}x${meta.height}, zoom levels 0-${zmax}`)

const stageRoot = generatedPath('assets-src/builds')
fs.mkdirSync(stageRoot, { recursive: true })
const stage = generatedPath(`assets-src/builds/lighthouse-${crypto.randomUUID()}`)
fs.mkdirSync(stage)
const OUT = path.join(stage, 'tiles')
const tmp = path.join(stage, 'google')
try {
  // libvips "google" layout: top-left anchored square pyramid, {z}/{y}/{x}.png, blank tiles skipped.
  await sharp(SRC, { limitInputPixels: false })
    .png({ compressionLevel: 9 })
    .tile({ size: TILE, layout: 'google', background: { r: 0, g: 0, b: 0, alpha: 0 }, skipBlanks: 0 })
    .toFile(tmp)

  // Re-arrange to Leaflet's default {z}/{x}/{y}.png
  let count = 0
  for (const z of fs.readdirSync(tmp)) {
    const zDir = path.join(tmp, z)
    if (!fs.statSync(zDir).isDirectory()) continue
    for (const y of fs.readdirSync(zDir)) {
      const yDir = path.join(zDir, y)
      if (!fs.statSync(yDir).isDirectory()) continue
      for (const file of fs.readdirSync(yDir)) {
        const x = path.parse(file).name
        const dest = path.join(OUT, z, x)
        fs.mkdirSync(dest, { recursive: true })
        fs.renameSync(path.join(yDir, file), path.join(dest, `${y}.png`))
        count++
      }
    }
  }
  const manifest = {
    source: 'https://reemr.se/maps/Lighthouse/re3mrLighthouseVERT.png',
    license: 'CC BY-NC-SA 4.0 (RE3MR, reemr.se)',
    width: meta.width,
    height: meta.height,
    tileSize: TILE,
    maxZoom: zmax,
    zoom0Size: [meta.width / 2 ** zmax, meta.height / 2 ** zmax],
    tiles: count,
    // no build time here: the content pack is hashed, and a time stamp gave it a new name (and a
    // fresh 48 MB download for every desktop user) on every release
  }
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2))
  console.log(`wrote ${count} tiles to ${OUT}`, manifest.zoom0Size)

  // The updated Lighthouse drawing (scripts/lighthouse-map: Jindouz's layout, CC BY-SA, in the
  // tarkov.dev style, CC BY-NC-SA) travels in the same content pack, so it stays out of the installer too.
  const drawing = fs.readFileSync('scripts/lighthouse-map/lighthouse-2026.svg', 'utf8')
  fs.writeFileSync(path.join(OUT, 'drawing-2026.svg'), drawing.replace(/\r\n/g, '\n'))
  console.log(`copied the updated drawing to ${OUT}/drawing-2026.svg`)

  // Retain the old tile set until the new one is complete and ready for promotion.
  const backup = generatedPath(`assets-src/generated-backups/lighthouse-${crypto.randomUUID()}`)
  fs.mkdirSync(path.dirname(backup), { recursive: true })
  fs.mkdirSync(path.dirname(DEST), { recursive: true })
  const existed = fs.existsSync(DEST)
  if (existed) fs.renameSync(DEST, backup)
  try { fs.renameSync(OUT, DEST) } catch (error) {
    if (existed && !fs.existsSync(DEST)) fs.renameSync(backup, DEST)
    throw error
  }
  console.log(`promoted tiles to ${DEST}${existed ? `; previous tiles retained at ${backup}` : ''}`)
} finally {
  // stage is a freshly created, checked directory owned by this invocation.
  fs.rmSync(generatedPath(path.relative(root, stage)), { recursive: true, force: true })
}
