// The whole RE3MR render resampled into the drawing's frame: one pixel per drawing unit × PX
// (1 unit ≈ 1 m, north up), the size of the drawing's viewBox. Everything later (terrain masks,
// tracing) works in this picture, so its pixel coordinates are drawing coordinates.
// Usage: straighten.cjs <out.png> [--px=1]
const sharp = require('sharp')
const F = require('./frames.cjs')

const args = process.argv.slice(2)
const [out] = args.filter((a) => !a.startsWith('--'))
const PX = Number(args.find((a) => a.startsWith('--px='))?.split('=')[1] ?? '1')

;(async () => {
  const W = Math.ceil(F.VIEW[0] * PX)
  const H = Math.ceil(F.VIEW[1] * PX)
  const [RW, RH] = F.RENDER_SIZE
  const { data } = await sharp(F.RENDER, { limitInputPixels: false }).raw().toBuffer({ resolveWithObject: true })
  const m = F.svgToRenderMatrix(F.appRenderAffine(), 1)
  // average a small box of render pixels per output pixel (the render has ~5 px per metre)
  const fx = Math.hypot(m[0], m[3]) / PX
  const fy = Math.hypot(m[1], m[4]) / PX
  const hx = Math.max(0, Math.floor(fx / 2))
  const hy = Math.max(0, Math.floor(fy / 2))
  const img = Buffer.alloc(W * H * 4)
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const u = (i + 0.5) / PX
      const v = (j + 0.5) / PX
      const x = Math.round(m[0] * u + m[1] * v + m[2])
      const y = Math.round(m[3] * u + m[4] * v + m[5])
      const o = 4 * (j * W + i)
      if (x - hx < 0 || y - hy < 0 || x + hx >= RW || y + hy >= RH) continue
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let dy = -hy; dy <= hy; dy++)
        for (let dx = -hx; dx <= hx; dx++) {
          const k = 3 * ((y + dy) * RW + x + dx)
          r += data[k]
          g += data[k + 1]
          b += data[k + 2]
          n++
        }
      img[o] = r / n
      img[o + 1] = g / n
      img[o + 2] = b / n
      img[o + 3] = 255
    }
  await sharp(img, { raw: { width: W, height: H, channels: 4 } }).png().toFile(out)
  console.log(out, W, 'x', H)
})().catch((e) => console.log('FAILED', e.message))
