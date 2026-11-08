import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
export const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

function inside(candidate, parent) {
  const relative = path.relative(parent, candidate)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** Check ancestors too: never follow a generated-dir junction outside the repo. */
export function generatedPath(relative) {
  const result = path.resolve(root, relative)
  if (!inside(result, root)) throw new Error('Generated path escapes the repository')
  for (let ancestor = result; ancestor !== root; ancestor = path.dirname(ancestor)) {
    if (fs.existsSync(ancestor) && !inside(fs.realpathSync(ancestor), fs.realpathSync(root)))
      throw new Error(`Generated path points outside the repository: ${relative}`)
  }
  return result
}

export function atomicBytes(file, bytes) {
  generatedPath(path.relative(root, file))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  const handle = fs.openSync(temporary, 'wx')
  try { fs.writeFileSync(handle, bytes); fs.fsyncSync(handle) } finally { fs.closeSync(handle) }
  fs.renameSync(temporary, file)
}

const publicAssetDirs = new Map([['scan', 'scan'], ['ocr', 'ocr'], ['lighthouse', 'tiles/lighthouse-re3mr']])

export function newAssetStage(name) {
  if (!publicAssetDirs.has(name)) throw new Error('Unknown generated asset directory')
  const stage = generatedPath(`assets-src/builds/${name}-${crypto.randomUUID()}`)
  fs.mkdirSync(stage, { recursive: true })
  return stage
}

/** Retain old generated content outside Vite's public directory. */
export function publishAssetStage(stage, name) {
  const publicDir = publicAssetDirs.get(name)
  if (!publicDir) throw new Error('Unknown generated asset directory')
  const source = generatedPath(path.relative(root, stage))
  if (!inside(source, generatedPath('assets-src/builds')) || !fs.statSync(source).isDirectory())
    throw new Error('Invalid asset staging directory')
  const destination = generatedPath(`public/${publicDir}`)
  const backup = generatedPath(`assets-src/generated-backups/${name}-${crypto.randomUUID()}`)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.mkdirSync(path.dirname(backup), { recursive: true })
  const existed = fs.existsSync(destination)
  if (existed) fs.renameSync(destination, backup)
  try { fs.renameSync(source, destination) } catch (error) {
    if (existed && !fs.existsSync(destination)) fs.renameSync(backup, destination)
    throw error
  }
}

export async function fetchBytes(url, maxBytes, allowedHosts, { redirects = 0, timeoutMs = 25_000 } = {}) {
  let target = new URL(url)
  const signal = AbortSignal.timeout(timeoutMs)
  let response
  for (let followed = 0; ; followed++) {
    if (target.protocol !== 'https:' || target.username || target.password || target.port || !allowedHosts.includes(target.hostname))
      throw new Error(`Unexpected asset origin: ${target.origin}`)
    response = await fetch(target, { signal, redirect: 'manual' })
    if (![301, 302, 303, 307, 308].includes(response.status)) break
    const location = response.headers.get('location')
    await response.body?.cancel()
    if (!location || followed >= redirects) throw new Error('Unexpected asset redirect')
    target = new URL(location, target)
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`HTTP ${response.status}: ${target.pathname}`)
  }
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel()
    throw new Error(`Asset exceeds ${maxBytes} bytes: ${target.pathname}`)
  }
  const chunks = []
  let size = 0
  if (!response.body) throw new Error('Asset response has no body')
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > maxBytes) throw new Error(`Asset exceeds ${maxBytes} bytes: ${target.pathname}`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size)
}

export function fileEntries(directory, names) {
  return Object.fromEntries(names.map((name) => {
    const bytes = fs.readFileSync(path.join(directory, name))
    return [name, { size: bytes.length, sha256: sha256(bytes) }]
  }))
}
