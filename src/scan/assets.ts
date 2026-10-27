import { FP, type FingerprintHeader } from './core'

export const MAX_FINGERPRINT_BYTES = 256 * 1024 * 1024
export const MAX_FINGERPRINT_HEADER_BYTES = 16 * 1024 * 1024
export const SCANNER_FILES = ['fingerprints.json', 'fingerprints.bin', 'source-manifest.json'] as const
export interface AssetFile { size: number; sha256: string }
export interface ScannerManifest {
  kind: 'tarkov-companion-scan-assets'
  version: 1
  complete: true
  fp: number
  modes: ('pve' | 'regular')[]
  excluded: number
  files: Record<typeof SCANNER_FILES[number], AssetFile>
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = () => new Error('Scanner assets are invalid or incomplete. Prepare matching content assets and retry.')

export function scannerManifest(value: unknown): ScannerManifest {
  if (!object(value) || value.kind !== 'tarkov-companion-scan-assets' || value.version !== 1
    || value.complete !== true || value.fp !== FP || !Array.isArray(value.modes)
    || !value.modes.length || value.modes.some((mode) => mode !== 'pve' && mode !== 'regular')
    || typeof value.excluded !== 'number' || !Number.isSafeInteger(value.excluded) || value.excluded < 0
    || !object(value.files)) throw fail()
  for (const name of SCANNER_FILES) {
    const file = value.files[name]
    if (!object(file) || !Number.isSafeInteger(file.size) || typeof file.size !== 'number'
      || file.size < 1 || file.size > MAX_FINGERPRINT_BYTES
      || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) throw fail()
  }
  return value as unknown as ScannerManifest
}

/** Validate byte offsets and footprints before the worker creates typed indexes. */
export function fingerprintHeader(value: unknown, pixelBytes: number): FingerprintHeader {
  if (!object(value) || value.version !== 1 || value.fp !== FP || typeof value.generated !== 'string'
    || !Array.isArray(value.items) || !value.items.length || value.items.length > 100_000
    || !Number.isSafeInteger(pixelBytes) || pixelBytes < 1 || pixelBytes > MAX_FINGERPRINT_BYTES) throw fail()
  let offset = 0
  for (const item of value.items) {
    if (!object(item) || typeof item.id !== 'string' || !item.id || item.id.length > 512
      || typeof item.w !== 'number' || typeof item.h !== 'number'
      || !Number.isSafeInteger(item.w) || !Number.isSafeInteger(item.h)
      || item.w < 1 || item.w > 32 || item.h < 1 || item.h > 32 || item.w * item.h > 256
      || item.o !== offset || (item.n !== undefined && (typeof item.n !== 'string' || item.n.length > 256))
      || (item.g !== undefined && item.g !== 1)
      || (item.src !== undefined && !['correction', 'confirmed', 'not'].includes(String(item.src)))) throw fail()
    offset += item.w * item.h * FP * FP * 3
    if (offset > pixelBytes) throw fail()
  }
  if (offset !== pixelBytes) throw fail()
  return value as unknown as FingerprintHeader
}
