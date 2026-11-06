// Puts several pictures side by side in a grid (to look at many crops at once).
// Usage: tile.cjs <out.png> <cols> <a.png> <b.png> …
const sharp = require('sharp')

;(async () => {
  const [out, colsArg, ...files] = process.argv.slice(2)
  const cols = Number(colsArg)
  const metas = await Promise.all(files.map((f) => sharp(f).metadata()))
  const w = Math.max(...metas.map((m) => m.width))
  const h = Math.max(...metas.map((m) => m.height))
  const rows = Math.ceil(files.length / cols)
  await sharp({ create: { width: cols * (w + 6) - 6, height: rows * (h + 6) - 6, channels: 3, background: '#000' } })
    .composite(files.map((f, i) => ({ input: f, left: (i % cols) * (w + 6), top: Math.floor(i / cols) * (h + 6) })))
    .png()
    .toFile(out)
  console.log(out)
})().catch((e) => console.log('FAILED', e.message))
