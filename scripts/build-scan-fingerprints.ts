// Prepare mode-aware, deterministic references; the incumbent RGB12 sampler is unchanged.
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { FP, sampleRegion, type FingerprintHeader } from '../src/scan/core'
import { fingerprintHeader, MAX_FINGERPRINT_BYTES, MAX_FINGERPRINT_HEADER_BYTES } from '../src/scan/assets'
import { atomicBytes, fetchBytes, fileEntries, generatedPath, newAssetStage, publishAssetStage, root, sha256 } from './lib/content-assets.mjs'

const options = { offline: false, refresh: false, concurrency: 4 }
for (let i = 2; i < process.argv.length; i++) {
  const argument = process.argv[i]
  if (argument === '--offline') options.offline = true
  else if (argument === '--refresh') options.refresh = true
  else if (argument === '--concurrency') options.concurrency = Number(process.argv[++i])
  else throw new Error(`Unknown option: ${argument}. Use --offline, --refresh or --concurrency 1..8.`)
}
if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 8 || (options.offline && options.refresh))
  throw new Error('Invalid asset options: concurrency must be 1..8; offline and refresh are mutually exclusive')
sharp.concurrency(1)
sharp.cache(false)
const cache = generatedPath('assets-src/scan/v2')
const modes = ['pve', 'regular'] as const
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
let reservedBytes = 0
let reservedRecords = 0
function reserveReference(w: number, h: number) {
  const bytes = w * h * FP * FP * 3
  if (reservedRecords >= 100_000 || reservedBytes + bytes > MAX_FINGERPRINT_BYTES)
    throw new Error('Aggregate reference/correction budget exceeded before allocation')
  reservedRecords++
  reservedBytes += bytes
}

async function download(url: string, limit: number, hosts: string[]): Promise<Buffer> {
  for (let attempt = 0; ; attempt++) {
    try { return await fetchBytes(url, limit, hosts) } catch (error) {
      if (attempt >= 2 || /HTTP (400|401|403|404)/.test(String(error))) throw error
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
    }
  }
}

interface DocumentSource { url: string; sha256: string; size: number }
const documents: DocumentSource[] = []
async function document(url: string, key: string, limit: number, valid: (value: unknown) => boolean): Promise<Record<string, unknown>> {
  const pointer = path.join(cache, `${key}.json`)
  let bytes: Buffer
  if (options.offline) {
    const saved = JSON.parse(fs.readFileSync(pointer, 'utf8')) as DocumentSource
    if (saved.url !== url || !/^[a-f0-9]{64}$/.test(saved.sha256) || saved.size < 1 || saved.size > limit)
      throw new Error(`Invalid cached catalog pointer: ${key}`)
    const file = generatedPath(`assets-src/scan/v2/documents/${saved.sha256}.json`)
    if (fs.statSync(file).size > limit) throw new Error(`Cached catalog too large: ${key}`)
    bytes = fs.readFileSync(file)
    if (bytes.length !== saved.size || sha256(bytes) !== saved.sha256) throw new Error(`Cached catalog checksum differs: ${key}`)
  } else {
    bytes = await download(url, limit, ['json.tarkov.dev'])
  }
  const parsed: unknown = JSON.parse(bytes.toString('utf8'))
  if (!valid(parsed)) throw new Error(`Unexpected catalog shape: ${url}`)
  const source = { url, sha256: sha256(bytes), size: bytes.length }
  if (!options.offline) {
    atomicBytes(path.join(cache, 'documents', `${source.sha256}.json`), bytes)
    atomicBytes(pointer, JSON.stringify(source))
  }
  documents.push(source)
  return parsed as Record<string, unknown>
}

interface RawItem {
  id: string
  width?: number
  height?: number
  gridImageLink?: string
  shortName?: string
  types?: string[]
  properties?: { baseItem?: string }
}
interface Reference { mode: typeof modes[number]; sourceId: string; id: string; url: string; w: number; h: number; n: string; g: boolean }
const items: Reference[] = []
const excluded: { mode: string; id: string; reason: string }[] = []
for (const mode of modes) {
  const res = await document(`https://json.tarkov.dev/${mode}/items`, `${mode}-items`, 64 * 1024 * 1024,
    (value) => object(value) && object(value.data) && object(value.data.items) && Object.keys(value.data.items).length > 0)
  const en = await document(`https://json.tarkov.dev/${mode}/items_en`, `${mode}-items_en`, 16 * 1024 * 1024,
    (value) => object(value) && object(value.data) && Object.keys(value.data).length > 0)
  const all = (res.data as { items: Record<string, RawItem> }).items
  const names = en.data as Record<string, unknown>
  for (const [key, value] of Object.entries(all).sort(([a], [b]) => order(a, b))) {
    const item = value as RawItem
    const types = Array.isArray(item?.types) ? item.types : []
    const base = types.includes('preset') ? all[item.properties?.baseItem ?? ''] : item
    let reason = ''
    if (!object(value) || !identifier(key) || item.id !== key || !base || !identifier(base.id)) reason = 'invalid identity or preset base'
    else if (!Number.isSafeInteger(item.width) || !Number.isSafeInteger(item.height)
      || (item.width ?? 0) < 1 || (item.height ?? 0) < 1 || (item.width ?? 0) > 32
      || (item.height ?? 0) > 32 || (item.width ?? 0) * (item.height ?? 0) > 256) reason = 'missing or unsupported footprint'
    else if (typeof item.gridImageLink !== 'string' || !item.gridImageLink || item.gridImageLink.includes('/unknown-item')) reason = 'missing/placeholder grid image'
    if (reason) { excluded.push({ mode, id: key, reason }); continue }
    const url = new URL(item.gridImageLink as string)
    if (url.protocol !== 'https:' || url.hostname !== 'assets.tarkov.dev' || url.username || url.password)
      throw new Error(`Unexpected grid image origin for ${key}`)
    const translated = names[base.shortName ?? '']
    // Reserve all mode variants before any image worker starts, including its
    // in-flight output. Deduplication later cannot justify unbounded retention.
    reserveReference(item.width as number, item.height as number)
    items.push({ mode, sourceId: key, id: base.id, url: url.href, w: item.width as number, h: item.height as number,
      n: typeof translated === 'string' ? translated.slice(0, 256) : '', g: (base.types ?? []).includes('gun') })
  }
}
console.log(`${items.length} mode-specific image references; ${excluded.length} explicit exclusions; concurrency ${options.concurrency}`)

interface ImageSource { url: string; sha256: string; size: number }
const inFlight = new Map<string, Promise<{ bytes: Buffer; source: ImageSource }>>()
async function gridImage(url: string): Promise<{ bytes: Buffer; source: ImageSource }> {
  const running = inFlight.get(url)
  if (running) return running
  const job = (async () => {
    const pointer = path.join(cache, 'urls', `${sha256(url)}.json`)
    if (fs.existsSync(pointer) && !options.refresh) {
      const source = JSON.parse(fs.readFileSync(pointer, 'utf8')) as ImageSource
      if (source.url !== url || !/^[a-f0-9]{64}$/.test(source.sha256) || source.size < 1 || source.size > 4 * 1024 * 1024)
        throw new Error('Invalid cached image pointer; use --refresh to reacquire it')
      const file = generatedPath(`assets-src/scan/v2/images/${source.sha256}.image`)
      if (fs.statSync(file).size > 4 * 1024 * 1024) throw new Error('Cached image exceeds size limit')
      const bytes = fs.readFileSync(file)
      if (bytes.length !== source.size || sha256(bytes) !== source.sha256) throw new Error('Cached image checksum differs; use --refresh to reacquire it')
      return { bytes, source }
    }
    if (options.offline) throw new Error('Image is not cached for an offline build')
    const bytes = await download(url, 4 * 1024 * 1024, ['assets.tarkov.dev'])
    const source = { url, sha256: sha256(bytes), size: bytes.length }
    atomicBytes(path.join(cache, 'images', `${source.sha256}.image`), bytes)
    atomicBytes(pointer, JSON.stringify(source))
    return { bytes, source }
  })()
  inFlight.set(url, job)
  try { return await job } finally { inFlight.delete(url) }
}

const results: (Reference & { px: Uint8Array; image: ImageSource })[] = []
const failures: { mode: string; id: string; error: string }[] = []
let next = 0
async function worker() {
  while (next < items.length) {
    const item = items[next++]
    try {
      const { bytes, source } = await gridImage(item.url)
      const { data, info } = await sharp(bytes, { limitInputPixels: 4_000_000 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      const fp = sampleRegion({ width: info.width, height: info.height, data }, 0, 0, info.width, info.height, item.w * FP, item.h * FP)
      results.push({ ...item, px: Uint8Array.from(fp, (v) => Math.round(v)), image: source })
    } catch (error) {
      failures.push({ mode: item.mode, id: item.sourceId, error: String(error) })
    }
    const done = results.length + failures.length
    if (done % 500 === 0) console.log(`  ${done} / ${items.length}; ${failures.length} failed`)
  }
}
await Promise.all(Array.from({ length: options.concurrency }, worker))
results.sort((a, b) => order(`${a.id}:${a.mode}:${a.sourceId}`, `${b.id}:${b.mode}:${b.sourceId}`))
const stage = newAssetStage('scan')
if (failures.length) {
  fs.writeFileSync(path.join(stage, 'failures.json'), JSON.stringify(failures.sort((a, b) => order(`${a.mode}:${a.id}`, `${b.mode}:${b.id}`)), null, 2))
  throw new Error(`${failures.length} references failed; previous public/scan retained. Details: ${stage}/failures.json`)
}

// Corrections exported from the app (scan-corrections/*.json) ship as extra references.
const corrections: { id: string; w: number; h: number; px: Uint8Array; src: 'correction' | 'confirmed' | 'not' }[] = []
const correctionSources: { file: string; sha256: string; records: number }[] = []
const correctionRoot = generatedPath('scan-corrections')
if (fs.existsSync(correctionRoot)) {
  for (const f of fs.readdirSync(correctionRoot).filter((n) => n.endsWith('.json')).sort(order)) {
    const full = generatedPath(`scan-corrections/${f}`)
    if (fs.statSync(full).size > 20 * 1024 * 1024) throw new Error(`Correction file too large: ${f}`)
    const bytes = fs.readFileSync(full)
    const file = JSON.parse(bytes.toString('utf8')) as { fp?: number; records?: { itemId: string; kind?: 'correct' | 'confirmed' | 'not'; w: number; h: number; fp: string }[] }
    if (file.fp !== FP || !Array.isArray(file.records) || file.records.length > 100_000) throw new Error(`Invalid/incompatible corrections: ${f}`)
    for (const r of file.records) {
      if (!identifier(r.itemId) || !Number.isSafeInteger(r.w) || !Number.isSafeInteger(r.h)
        || r.w < 1 || r.h < 1 || r.w > 32 || r.h > 32 || r.w * r.h > 256
        || typeof r.fp !== 'string' || r.fp.length > 200_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(r.fp)
        || (r.kind !== undefined && !['correct', 'confirmed', 'not'].includes(r.kind))) throw new Error(`Invalid correction in ${f}`)
      reserveReference(r.w, r.h)
      const px = new Uint8Array(Buffer.from(r.fp, 'base64'))
      if (px.length !== r.w * FP * r.h * FP * 3) throw new Error(`Wrong correction byte length in ${f}`)
      corrections.push({ id: r.itemId, w: r.w, h: r.h, px, src: r.kind === 'confirmed' ? 'confirmed' : r.kind === 'not' ? 'not' : 'correction' })
    }
    correctionSources.push({ file: f, sha256: sha256(bytes), records: file.records.length })
  }
}
corrections.sort((a, b) => order(`${a.id}:${a.w}:${a.h}:${a.src}:${sha256(a.px)}`, `${b.id}:${b.w}:${b.h}:${b.src}:${sha256(b.px)}`))
const seen = new Set<string>()
const references = results.filter((r) => {
  const key = `${r.id}:${r.w}:${r.h}:${r.n}:${r.g}:${sha256(r.px)}`
  if (seen.has(key)) return false
  seen.add(key)
  return true
})
const header: FingerprintHeader = { version: 1, fp: FP, generated: '', items: [] }
const total = references.reduce((n, r) => n + r.px.length, 0) + corrections.reduce((n, r) => n + r.px.length, 0)
if (total > MAX_FINGERPRINT_BYTES) throw new Error('Reference bytes exceed the scanner asset budget')
const pixels = new Uint8Array(total)
let o = 0
for (const r of references) {
  header.items.push({ id: r.id, w: r.w, h: r.h, o, n: r.n || undefined, g: r.g ? 1 : undefined })
  pixels.set(r.px, o)
  o += r.px.length
}
for (const c of corrections) {
  header.items.push({ id: c.id, w: c.w, h: c.h, o, src: c.src })
  pixels.set(c.px, o)
  o += c.px.length
}
fingerprintHeader(header, pixels.byteLength)
const headerBytes = Buffer.from(JSON.stringify(header))
if (headerBytes.length > MAX_FINGERPRINT_HEADER_BYTES) throw new Error('Fingerprint header exceeds the runtime metadata budget')
fs.writeFileSync(path.join(stage, 'fingerprints.json'), headerBytes)
fs.writeFileSync(path.join(stage, 'fingerprints.bin'), pixels)
const sources = { modes, documents, excluded, corrections: correctionSources,
  generatorSha256: sha256(fs.readFileSync(path.join(root, 'scripts/build-scan-fingerprints.ts'))),
  samplerSha256: sha256(fs.readFileSync(path.join(root, 'src/scan/core.ts'))),
  references: results.map(({ px: _px, ...r }) => r) }
fs.writeFileSync(path.join(stage, 'source-manifest.json'), JSON.stringify(sources))
const manifest = { kind: 'tarkov-companion-scan-assets', version: 1, complete: true, fp: FP, modes,
  references: references.length, corrections: corrections.length, excluded: excluded.length,
  files: fileEntries(stage, ['fingerprints.json', 'fingerprints.bin', 'source-manifest.json']) }
fs.writeFileSync(path.join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
publishAssetStage(stage, 'scan')
console.log(`Scanner assets ready: ${references.length} unique references + ${corrections.length} corrections; ${(total / 1e6).toFixed(1)} MB; ${excluded.length} catalog exclusions`)
