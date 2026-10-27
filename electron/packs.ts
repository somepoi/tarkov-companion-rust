/**
 * Content packs (see scripts/build-packs.mjs): the Lighthouse tiles and the scanner data are
 * downloaded from this version's GitHub release the first time they are needed, checked against
 * the SHA-256 built into the app (inside the signed program), and unpacked into
 * userData\packs\<name>-<hash>. Nothing from a pack is ever run: tiles are pictures, the scanner
 * data is numbers.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { app, net } from 'electron'
import type { PackName, PackProgress } from '../src/shared/desktop-api'
import { APP_IDENTITY } from './appIdentity'

interface PackInfo {
  file: string
  sha256: string
  size: number
  files: number
  label: string
}
interface PackManifest {
  packs: Partial<Record<PackName, PackInfo>>
}
/** Built in at compile time from electron/packs.generated.json (null in development). */
declare const __TC_PACKS__: PackManifest | null

const RELEASES = `${APP_IDENTITY.contentPackRepository}/releases/download`
const MAGIC = 'TCPK1\n'
const MAX_PACK_BYTES = 300 * 1024 * 1024
export const PACK_NAMES: PackName[] = ['lighthouse', 'scan']

const manifest: PackManifest | null = typeof __TC_PACKS__ === 'undefined' ? null : __TC_PACKS__
const packsRoot = () => path.join(app.getPath('userData'), 'packs')
const packDir = (name: PackName, info: PackInfo) => path.join(packsRoot(), `${name}-${info.sha256.slice(0, 16)}`)
const READY = '.complete'

/** Folder holding the pack's files when it is installed, else null. Development builds never use packs. */
export function installedPackDir(name: PackName): string | null {
  const info = manifest?.packs[name]
  if (!info) return null
  const dir = packDir(name, info)
  return fs.existsSync(path.join(dir, READY)) ? dir : null
}

/** Folder names of the packs this version uses (older ones are leftovers). */
export function currentPackDirNames(): Set<string> {
  return new Set(PACK_NAMES.flatMap((n) => {
    const info = manifest?.packs[n]
    return info ? [path.basename(packDir(n, info))] : []
  }))
}

export function packsEnabled(): boolean {
  return Boolean(manifest && app.isPackaged)
}

const running = new Map<PackName, Promise<void>>()

/** Downloads and installs a pack once; later calls return straight away. */
export function ensurePack(name: PackName, onProgress: (p: PackProgress) => void): Promise<void> {
  if (!packsEnabled() || installedPackDir(name)) return Promise.resolve()
  let job = running.get(name)
  if (!job) {
    job = install(name, onProgress).finally(() => running.delete(name))
    running.set(name, job)
  }
  return job
}

async function install(name: PackName, onProgress: (p: PackProgress) => void) {
  const info = manifest?.packs[name]
  if (!info) throw new Error(`Unknown pack ${name}`)
  if (info.size > MAX_PACK_BYTES) throw new Error('Pack too large')
  // TC_PACKS_BASE_URL is for testing a build before its release exists; the SHA-256 check below
  // still decides what gets installed, so another source cannot change the content.
  const base = process.env.TC_PACKS_BASE_URL || `${RELEASES}/v${app.getVersion()}`
  const url = `${base}/${info.file}`
  onProgress({ name, label: info.label, received: 0, total: info.size, state: 'downloading' })
  const res = await net.fetch(url)
  if (!res.ok || !res.body) throw new Error(`Content pack unavailable for this fork release (HTTP ${res.status}). Install the matching fork content pack or build the assets locally.`)
  const chunks: Buffer[] = []
  let received = 0
  let lastReport = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > info.size) throw new Error('The download is larger than expected')
    chunks.push(Buffer.from(value))
    if (received - lastReport > 512 * 1024) {
      lastReport = received
      onProgress({ name, label: info.label, received, total: info.size, state: 'downloading' })
    }
  }
  const data = Buffer.concat(chunks)
  const hash = crypto.createHash('sha256').update(data).digest('hex')
  if (data.length !== info.size || hash !== info.sha256) throw new Error('The download is damaged or not the expected file; nothing was installed')
  onProgress({ name, label: info.label, received, total: info.size, state: 'installing' })
  unpack(data, packDir(name, info))
  // Older versions of the same pack are no longer needed.
  for (const other of fs.readdirSync(packsRoot())) {
    if (other.startsWith(`${name}-`) && path.join(packsRoot(), other) !== packDir(name, info)) fs.rmSync(path.join(packsRoot(), other), { recursive: true, force: true })
  }
  onProgress({ name, label: info.label, received, total: info.size, state: 'done' })
}

/** Writes the pack's files under `dir` (only plain relative paths inside it are accepted). */
function unpack(data: Buffer, dir: string) {
  if (data.subarray(0, MAGIC.length).toString('latin1') !== MAGIC) throw new Error('Not a content pack')
  const headerLen = data.readUInt32BE(MAGIC.length)
  const start = MAGIC.length + 4
  const header = JSON.parse(data.subarray(start, start + headerLen).toString('utf8')) as { files: { path: string; size: number }[] }
  const tmp = `${dir}.partial`
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })
  let offset = start + headerLen
  for (const f of header.files) {
    if (typeof f.path !== 'string' || !/^[a-z0-9][a-z0-9_\-./]*$/i.test(f.path) || f.path.includes('..') || !Number.isInteger(f.size) || f.size < 0) throw new Error('Bad entry in pack')
    const target = path.join(tmp, ...f.path.split('/'))
    if (!target.startsWith(tmp + path.sep)) throw new Error('Bad entry in pack')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, data.subarray(offset, offset + f.size))
    offset += f.size
  }
  if (offset !== data.length) throw new Error('Pack size does not add up')
  fs.writeFileSync(path.join(tmp, READY), new Date().toISOString())
  fs.rmSync(dir, { recursive: true, force: true })
  fs.renameSync(tmp, dir)
}
