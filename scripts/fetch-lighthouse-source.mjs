// Download the licensed RE3MR Lighthouse render without replacing a usable local copy on failure.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import sharp from 'sharp'
import { generatedPath } from './lib/content-assets.mjs'

const URL_ = 'https://reemr.se/maps/Lighthouse/re3mrLighthouseVERT.png'
const DEST = generatedPath('assets-src/lighthouse/re3mrLighthouseVERT.png')
const MIN_BYTES = 5 * 1024 * 1024
const MAX_BYTES = 128 * 1024 * 1024
const MAX_PIXELS = 300_000_000

async function validate(file) {
  const stat = await fs.promises.stat(file)
  if (!stat.isFile() || stat.size < MIN_BYTES || stat.size > MAX_BYTES) throw new Error('Image size is outside the expected range')
  const image = sharp(file, { limitInputPixels: MAX_PIXELS, failOn: 'error' })
  const metadata = await image.metadata()
  if (metadata.format !== 'png' || !metadata.width || !metadata.height) throw new Error('Source is not a valid PNG image')
  // Decode the complete image: a valid PNG header alone does not prove the download finished.
  await image.stats()
  return stat.size
}

if (fs.existsSync(DEST)) {
  try {
    const size = await validate(DEST)
    console.log(`${DEST} already present (${(size / 1e6).toFixed(1)} MB)`)
    process.exit(0)
  } catch {
    console.warn('Existing Lighthouse source is incomplete or invalid; retaining it until a replacement is ready.')
  }
}
await fs.promises.mkdir(path.dirname(DEST), { recursive: true })
const temporary = generatedPath(`assets-src/lighthouse/.re3mr-${crypto.randomUUID()}.partial`)
const signal = AbortSignal.timeout(90_000)
let created = false
try {
  console.log(`downloading ${URL_}`)
  const res = await fetch(URL_, { headers: { 'User-Agent': 'tarkov-companion-build (map tiles; CC BY-NC-SA credit in app)', 'Accept-Encoding': 'identity' }, signal })
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`)
  const declared = Number(res.headers.get('content-length'))
  if (declared > MAX_BYTES) { await res.body.cancel(); throw new Error('Download exceeds the size limit') }
  let received = 0
  const limit = new Transform({ transform(chunk, _encoding, callback) {
    received += chunk.length
    callback(received > MAX_BYTES ? new Error('Download exceeds the size limit') : null, chunk)
  } })
  const handle = await fs.promises.open(temporary, 'wx')
  created = true
  await pipeline(Readable.fromWeb(res.body), limit, handle.createWriteStream(), { signal })
  if (declared && received !== declared) throw new Error('Download length differs from the server response')
  const size = await validate(temporary)
  const completed = await fs.promises.open(temporary, 'r+')
  try { await completed.sync() } finally { await completed.close() }
  await fs.promises.rename(temporary, DEST)
  created = false
  console.log(`saved ${DEST} (${(size / 1e6).toFixed(1)} MB)`)
} catch (error) {
  const reason = signal.aborted ? 'download timed out' : (error?.cause?.code ?? error?.message ?? String(error))
  console.error(`Lighthouse source download failed (${reason}); existing source was retained. Retry npm run tiles:fetch later.`)
  process.exitCode = 1
} finally {
  if (created) await fs.promises.rm(temporary, { force: true })
}
