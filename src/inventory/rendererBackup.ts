import { get, set } from 'idb-keyval'
import { invoke } from '@tauri-apps/api/core'
import type { LearnedRecord } from '../scan/learned'

const CORRECTIONS_KEY = 'tarkov-companion-scan-learned'
const MAX_BYTES = 20 * 1024 * 1024
const allowedKey = (key: string) =>
  /^(?:tarkov-companion-|tc-)[a-z0-9-]+$/i.test(key) &&
  !key.startsWith('tarkov-companion-assistant')

interface RendererBackup {
  kind: 'tarkov-companion-rust-renderer-state'
  version: 1
  capturedAt: string
  localStorage: Record<string, string>
  corrections: {
    kind: 'tarkov-companion-scan-corrections'
    version: 1
    fp: number
    records: LearnedRecord[]
  }
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
  const backup: RendererBackup = {
    kind: 'tarkov-companion-rust-renderer-state',
    version: 1,
    capturedAt: new Date().toISOString(),
    localStorage: saved,
    corrections: {
      kind: 'tarkov-companion-scan-corrections',
      version: 1,
      fp: FP,
      records: (await get<LearnedRecord[]>(CORRECTIONS_KEY)) ?? [],
    },
  }
  if (new TextEncoder().encode(JSON.stringify(backup)).byteLength > MAX_BYTES)
    throw new Error('Interface backup exceeds 20 MiB')
  return backup
}

/** Apply the Rust-validated snapshot before importing persisted application stores. */
export async function restorePendingRenderer(): Promise<void> {
  const backup = await invoke<RendererBackup | null>('native_backup', {
    operation: { operation: 'pendingRenderer' },
  })
  if (backup === null) return
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
