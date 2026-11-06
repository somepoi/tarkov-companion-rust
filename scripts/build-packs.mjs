// Stream the incumbent TCPK1 format. No previous output is removed before success.
// This prepares local artifacts only; it does not upload or publish a release.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { atomicBytes, generatedPath, root } from './lib/content-assets.mjs'

const LIGHTHOUSE_DRAWING = 'tiles/lighthouse-re3mr/drawing-2026.svg'
const PACKS = [
  { name: 'lighthouse', dir: 'public/tiles/lighthouse-re3mr', prefix: 'tiles/lighthouse-re3mr', label: 'Lighthouse maps' },
  { name: 'scan', dir: 'public/scan', prefix: 'scan', label: 'stash scanner data' },
]
const OUT = generatedPath('release-packs')
const MAGIC = Buffer.from('TCPK1\n')
const MAX_PACK = 300 * 1024 * 1024
const MAX_FILE = 256 * 1024 * 1024
const MAX_HEADER = 8 * 1024 * 1024
const MAX_FILES = 50_000

function safePath(pack, relative) {
  const segments = relative.split('/')
  if (!relative || relative.length > 240 || relative.includes('..') || segments.length > 32 || segments.some((segment) => {
    const stem = segment.split('.')[0].toUpperCase()
    return !/^[a-z0-9][a-z0-9_.-]*$/i.test(segment) || segment.endsWith('.')
      || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)
  })) throw new Error(`Unsafe pack path: ${relative}`)
  const extension = path.posix.extname(relative).toLowerCase()
  const allowed = pack.name === 'scan' ? ['.json', '.bin'] : ['.png', '.jpg', '.jpeg', '.webp', '.json', '.txt', '.md']
  const drawing = pack.name === 'lighthouse' && relative === LIGHTHOUSE_DRAWING
  if (!relative.startsWith(`${pack.prefix}/`) || (!allowed.includes(extension) && !drawing)) throw new Error(`Not data for this pack: ${relative}`)
}

function entries(pack) {
  const directory = generatedPath(pack.dir)
  if (!fs.existsSync(directory)) throw new Error(`${pack.dir} is missing: build it first`)
  const files = []
  const names = new Set()
  let total = 0
  function walk(current, depth) {
    if (depth > 32) throw new Error('Pack directory nesting exceeds its limit')
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = generatedPath(path.relative(root, path.join(current, entry.name)))
      if (entry.isSymbolicLink()) throw new Error(`Pack input must not be a link: ${full}`)
      if (entry.isDirectory()) { walk(full, depth + 1); continue }
      if (!entry.isFile()) throw new Error(`Unsupported pack input: ${full}`)
      // Preserve the incumbent tile-builder exclusion of auxiliary XML files.
      if (entry.name.toLowerCase().endsWith('.xml')) continue
      const relative = `${pack.prefix}/${path.relative(directory, full).split(path.sep).join('/')}`
      safePath(pack, relative)
      const key = relative.toLowerCase()
      const stat = fs.statSync(full)
      if (names.has(key) || files.length >= MAX_FILES || stat.size > MAX_FILE || !Number.isSafeInteger(stat.size))
        throw new Error(`Duplicate/oversized/excessive pack input: ${relative}`)
      total += stat.size
      if (total > MAX_PACK) throw new Error('Pack contents exceed 300 MiB')
      names.add(key)
      files.push({ full, path: relative, size: stat.size, modified: stat.mtimeMs })
    }
  }
  walk(directory, 0)
  const required = pack.name === 'scan'
    ? ['scan/manifest.json', 'scan/source-manifest.json', 'scan/fingerprints.json', 'scan/fingerprints.bin']
    : ['tiles/lighthouse-re3mr/0/0/0.png', LIGHTHOUSE_DRAWING]
  if (required.some((file) => !names.has(file))) throw new Error(`Pack ${pack.name} is missing required content`)
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

async function digestFile(file, limit) {
  const hash = crypto.createHash('sha256')
  let received = 0
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 64 * 1024 })) {
    received += chunk.length
    if (received > limit) throw new Error('Existing pack grew while its checksum was read')
    hash.update(chunk)
  }
  return hash.digest('hex')
}
async function build(pack, files) {
  const header = Buffer.from(JSON.stringify({ files: files.map((file) => ({ path: file.path, size: file.size })) }))
  const size = MAGIC.length + 4 + header.length + files.reduce((sum, file) => sum + file.size, 0)
  if (!files.length || header.length > MAX_HEADER || size > MAX_PACK) throw new Error(`Pack ${pack.name} exceeds its format budget`)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(header.length)
  const temporary = generatedPath(`release-packs/.partial-${pack.name}-${crypto.randomUUID()}`)
  const output = await fs.promises.open(temporary, 'wx')
  const hash = crypto.createHash('sha256')
  let written = 0
  async function write(bytes) {
    written += bytes.length
    if (written > size) throw new Error('Pack source grew during preparation')
    hash.update(bytes)
    let offset = 0
    while (offset < bytes.length) {
      const result = await output.write(bytes, offset, bytes.length - offset, null)
      if (!result.bytesWritten) throw new Error('Pack output write made no progress')
      offset += result.bytesWritten
    }
  }
  try {
    await write(MAGIC)
    await write(length)
    await write(header)
    for (const file of files) {
      const before = fs.statSync(file.full)
      if (before.size !== file.size || before.mtimeMs !== file.modified) throw new Error(`Pack input changed before reading: ${file.path}`)
      let received = 0
      for await (const chunk of fs.createReadStream(file.full, { highWaterMark: 64 * 1024 })) {
        received += chunk.length
        if (received > file.size) throw new Error(`Pack input grew: ${file.path}`)
        await write(chunk)
      }
      const after = fs.statSync(file.full)
      if (received !== file.size || after.size !== file.size || after.mtimeMs !== file.modified)
        throw new Error(`Pack input changed while reading: ${file.path}`)
    }
    if (written !== size) throw new Error('Pack byte count does not add up')
    await output.sync()
  } finally { await output.close() }
  const sha256 = hash.digest('hex')
  const file = `${pack.name}-${sha256.slice(0, 12)}.tcpack`
  const destination = generatedPath(`release-packs/${file}`)
  // Both resolved paths remain in the intended output directory before promotion.
  if (path.dirname(fs.realpathSync(temporary)) !== fs.realpathSync(OUT) || path.dirname(destination) !== OUT)
    throw new Error('Pack output escaped its directory')
  if (fs.existsSync(destination)) {
    if (!fs.lstatSync(destination).isFile() || fs.statSync(destination).size !== size || await digestFile(destination, size) !== sha256)
      throw new Error('Pack filename collision; old output retained')
    fs.unlinkSync(temporary) // Only this job's verified redundant temporary file.
  } else fs.renameSync(temporary, destination)
  console.log(`${file}: ${files.length} files, ${(size / 1e6).toFixed(1)} MB`)
  return { file, sha256, size, files: files.length, label: pack.label }
}

// Validate all input trees before creating a new pack. The old generated manifest
// remains in place until every new pack has been flushed and promoted.
const sources = PACKS.map((pack) => ({ pack, files: entries(pack) }))
fs.mkdirSync(OUT, { recursive: true })
const manifest = { packs: {} }
for (const { pack, files } of sources) manifest.packs[pack.name] = await build(pack, files)
atomicBytes(generatedPath('packs.generated.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log('wrote packs.generated.json')
