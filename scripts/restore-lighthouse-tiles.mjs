// Restore the licensed map tiles from a pinned upstream build input.
// The fork always supplies its own drawing and generates its own release pack.
import fs from 'node:fs'
import path from 'node:path'
import { atomicBytes, fetchBytes, generatedPath, newAssetStage, publishAssetStage, sha256 } from './lib/content-assets.mjs'

const version = '2.21.0'
const digest = '71ac506c36a4d821578d205c13032a6e13b77f73a656c380cb18878492dac01b'
const size = 50_619_802
const prefix = 'tiles/lighthouse-re3mr/'
const source = `https://github.com/David04-09/tarkov-companion/releases/download/v${version}/lighthouse-${digest.slice(0, 12)}.tcpack`
const cache = generatedPath(`assets-src/lighthouse/upstream-${version}.tcpack`)

function verified(bytes) {
  return bytes.length === size && sha256(bytes) === digest
}

let pack
if (fs.existsSync(cache) && fs.statSync(cache).size === size) {
  const cached = fs.readFileSync(cache)
  if (verified(cached)) pack = cached
}
if (!pack) {
  pack = await fetchBytes(source, size, ['github.com', 'release-assets.githubusercontent.com'], { redirects: 2, timeoutMs: 90_000 })
  if (!verified(pack)) throw new Error('Pinned Lighthouse archive size or SHA-256 does not match')
  atomicBytes(cache, pack)
}

if (pack.toString('ascii', 0, 6) !== 'TCPK1\n') throw new Error('Invalid Lighthouse archive format')
const headerSize = pack.readUInt32BE(6)
if (headerSize === 0 || headerSize > 8 * 1024 * 1024) throw new Error('Invalid Lighthouse archive header size')
let offset = 10 + headerSize
const { files } = JSON.parse(pack.toString('utf8', 10, offset))
if (!Array.isArray(files) || files.length > 50_000) throw new Error('Invalid Lighthouse archive file count')

const entries = new Map()
for (const file of files) {
  if (typeof file.path !== 'string' || !file.path.startsWith(prefix)) throw new Error('Unexpected Lighthouse archive path')
  const relative = file.path.slice(prefix.length)
  if (!/^(?:\d{1,5}\/\d{1,5}\/\d{1,5}\.png|manifest\.json|drawing-2026\.svg)$/.test(relative) || entries.has(relative))
    throw new Error(`Invalid or duplicate Lighthouse archive entry: ${relative}`)
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > 8 * 1024 * 1024 || offset + file.size > pack.length)
    throw new Error(`Invalid Lighthouse archive file size: ${relative}`)
  entries.set(relative, pack.subarray(offset, offset + file.size))
  offset += file.size
}
if (offset !== pack.length || !entries.has('0/0/0.png') || !entries.has('manifest.json')) throw new Error('Incomplete Lighthouse archive')
entries.set('drawing-2026.svg', fs.readFileSync(new URL('./lighthouse-map/lighthouse-2026.svg', import.meta.url), 'utf8').replace(/\r\n/g, '\n'))

const stage = newAssetStage('lighthouse')
for (const [relative, bytes] of entries) {
  const target = path.join(stage, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, bytes, { flag: 'wx' })
}
publishAssetStage(stage, 'lighthouse')
console.log(`Restored ${entries.size} Lighthouse assets from verified v${version} tiles and the fork drawing.`)
