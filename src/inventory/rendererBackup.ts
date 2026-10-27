import { get, set } from 'idb-keyval'
import { invoke } from '@tauri-apps/api/core'

const CORRECTIONS_KEY = 'tarkov-companion-scan-learned'
const MAX_BYTES = 20 * 1024 * 1024
const allowedKey = (key: string) =>
  /^(?:tarkov-companion-|tc-)[a-z0-9-]+$/i.test(key) &&
  !key.startsWith('tarkov-companion-assistant')
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

interface RendererBackup {
  kind: 'tarkov-companion-rust-renderer-state'
  version: 1
  capturedAt: string
  localStorage: Record<string, string>
  corrections: {
    kind: 'tarkov-companion-scan-corrections'
    version: 1
    fp: number
    records: unknown[]
  }
}

async function validate(value: unknown): Promise<RendererBackup> {
  if (
    !object(value) ||
    value.kind !== 'tarkov-companion-rust-renderer-state' ||
    value.version !== 1 ||
    !object(value.localStorage) ||
    !object(value.corrections)
  )
    throw new Error('Unsupported interface backup')
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_BYTES)
    throw new Error('Interface backup exceeds 20 MiB')
  for (const [key, saved] of Object.entries(value.localStorage)) {
    if (
      !allowedKey(key) ||
      typeof saved !== 'string' ||
      saved.length > MAX_BYTES
    )
      throw new Error(`Invalid saved preference: ${key}`)
  }
  const corrections = value.corrections
  const { FP } = await import('../scan/core')
  if (
    corrections.kind !== 'tarkov-companion-scan-corrections' ||
    corrections.version !== 1 ||
    corrections.fp !== FP ||
    !Array.isArray(corrections.records) ||
    corrections.records.length > 400
  )
    throw new Error('Unsupported scanner correction backup')
  const ids = new Set<string>()
  for (const r of corrections.records) {
    if (
      !object(r) ||
      typeof r.id !== 'string' ||
      !r.id ||
      ids.has(r.id) ||
      typeof r.itemId !== 'string' ||
      !r.itemId ||
      r.itemId.length > 512 ||
      !Number.isSafeInteger(r.w) ||
      !Number.isSafeInteger(r.h) ||
      typeof r.w !== 'number' ||
      typeof r.h !== 'number' ||
      r.w < 1 ||
      r.h < 1 ||
      r.w * r.h > 256 ||
      typeof r.fp !== 'string' ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(r.fp) ||
      typeof r.thumb !== 'string' ||
      !/^data:image\/(?:jpeg|png);base64,/.test(r.thumb) ||
      r.thumb.length > 512 * 1024 ||
      typeof r.pitch !== 'number' ||
      !Number.isFinite(r.pitch) ||
      r.pitch <= 0 ||
      typeof r.createdAt !== 'number' ||
      !Number.isFinite(r.createdAt) ||
      ![undefined, 'correct', 'confirmed', 'not'].includes(
        r.kind as string | undefined,
      )
    )
      throw new Error('Invalid scanner correction record')
    if (atob(r.fp).length !== r.w * r.h * FP * FP * 3)
      throw new Error('Invalid scanner fingerprint size')
    ids.add(r.id)
  }
  return value as unknown as RendererBackup
}

export async function buildRendererBackup(): Promise<RendererBackup> {
  const saved: Record<string, string> = {}
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key && allowedKey(key)) {
      const value = localStorage.getItem(key)
      if (value !== null) saved[key] = value
    }
  }
  const { FP } = await import('../scan/core')
  return validate({
    kind: 'tarkov-companion-rust-renderer-state',
    version: 1,
    capturedAt: new Date().toISOString(),
    localStorage: saved,
    corrections: {
      kind: 'tarkov-companion-scan-corrections',
      version: 1,
      fp: FP,
      records: (await get(CORRECTIONS_KEY)) ?? [],
    },
  })
}

/** Runs before importing any persisted application stores in a recovered WebView. */
export async function restorePendingRenderer(): Promise<void> {
  const pending = await invoke<unknown>('native_backup', {
    operation: { operation: 'pendingRenderer' },
  })
  if (pending === null) return
  const backup = await validate(pending)
  await set(CORRECTIONS_KEY, backup.corrections.records)
  const oldKeys = Array.from({ length: localStorage.length }, (_, i) =>
    localStorage.key(i),
  ).filter((key): key is string => key !== null && allowedKey(key))
  for (const key of oldKeys) localStorage.removeItem(key)
  for (const [key, value] of Object.entries(backup.localStorage))
    localStorage.setItem(key, value)
  await invoke('native_backup', {
    operation: { operation: 'acknowledgeRenderer' },
  })
}
