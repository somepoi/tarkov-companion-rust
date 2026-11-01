/**
 * The progress file: everything the app keeps about you, in one JSON document. Used by
 * Settings → Export/Import and by the daily automatic backups (desktop), so both always
 * contain the same things.
 */
import type { GameMode } from '../api/client'
import { parseDrawings, useDrawingsStore } from '../store/drawings'
import { useInventoryStore, type ModeInventory } from '../store/inventory'
import { validateProgressSections } from './progressImportValidation'
import { parseProgressExport, useProgressStore } from '../store/progress'
import { useRaidLogStore, type ManualRaid, type RaidEntry } from '../store/raidLog'
import { parseStory, useStoryStore } from '../store/story'

export function buildProgressFile() {
  const raid = useRaidLogStore.getState()
  return {
    ...useProgressStore.getState().exportProgress(),
    inventory: useInventoryStore.getState().byMode,
    drawings: useDrawingsStore.getState().byKey,
    story: useStoryStore.getState().byMode,
    raidLog: raid.byMode,
    raidLogManual: raid.manual,
    raidLogHidden: raid.hidden,
  }
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

/** Restores a progress file (export or backup). Returns what was restored, for the message. Throws on an invalid file. */
let importing = false
export function importProgressFile(parsed: unknown): string[] {
  if (importing) throw new Error('Another progress import is running')
  const progress = parseProgressExport(parsed)
  const p = parsed as Record<string, unknown>
  validateProgressSections(p)
  // Parse every optional section before touching any live store.
  const drawings = p.drawings === undefined ? null : parseDrawings(p.drawings)
  const story = p.story === undefined ? null : parseStory(p.story)
  const oldProgress = useProgressStore.getState()
  const oldInventory = useInventoryStore.getState()
  const oldDrawings = useDrawingsStore.getState()
  const oldStory = useStoryStore.getState()
  const oldRaids = useRaidLogStore.getState()
  const keys = ['progress', 'inventory', 'drawings', 'story', 'raid-log'].map((key) => `tarkov-companion-${key}`)
  const saved = keys.map((key) => [key, localStorage.getItem(key)] as const)
  importing = true
  try {
    useProgressStore.setState(progress)
    const restored = ['quests']
    if (isObj(p.inventory)) {
      const inv = p.inventory as Partial<Record<GameMode, Partial<ModeInventory>>>
      useInventoryStore.setState((s) => ({
        byMode: {
          regular: { ...s.byMode.regular, ...(isObj(inv.regular) ? inv.regular : {}) },
          pve: { ...s.byMode.pve, ...(isObj(inv.pve) ? inv.pve : {}) },
        },
      }))
      restored.push('item collection, keys and hideout')
    }
    if (drawings) {
      useDrawingsStore.getState().importAll(drawings)
      restored.push('map drawings')
    }
    if (story) {
      useStoryStore.getState().importAll(story)
      restored.push('story chapters')
    }
    if (isObj(p.raidLog)) {
      const r = p.raidLog as Partial<Record<GameMode, Record<string, RaidEntry>>>
      const m = (isObj(p.raidLogManual) ? p.raidLogManual : {}) as Partial<Record<GameMode, ManualRaid[]>>
      const h = (isObj(p.raidLogHidden) ? p.raidLogHidden : {}) as Partial<Record<GameMode, string[]>>
      useRaidLogStore.getState().importAll(
        { regular: r.regular ?? {}, pve: r.pve ?? {} },
        { regular: Array.isArray(m.regular) ? m.regular : [], pve: Array.isArray(m.pve) ? m.pve : [] },
        { regular: Array.isArray(h.regular) ? h.regular : [], pve: Array.isArray(h.pve) ? h.pve : [] },
      )
      restored.push('raid log')
    }
    return restored
  } catch (cause) {
    const errors: unknown[] = []
    for (const undo of [
      () => useProgressStore.setState(oldProgress),
      () => useInventoryStore.setState(oldInventory),
      () => useDrawingsStore.setState(oldDrawings),
      () => useStoryStore.setState(oldStory),
      () => useRaidLogStore.setState(oldRaids),
    ]) { try { undo() } catch (error) { errors.push(error) } }
    for (const [key, value] of saved) {
      try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value) }
      catch (error) { errors.push(error) }
    }
    throw new Error(`${cause instanceof Error ? cause.message : String(cause)}${errors.length ? '. Rollback could not be fully saved; retain your backup and resolve the storage error before restarting.' : '. Previous progress restored.'}`, { cause })
  } finally { importing = false }
}

/** Files you import are untrusted: refuse huge ones and drop keys that could tamper with objects. */
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
export function parseImportJson(text: string): unknown {
  if (text.length > MAX_IMPORT_BYTES) throw new Error('that file is too large')
  return JSON.parse(text, (key, value: unknown) => (BLOCKED_KEYS.has(key) ? undefined : value))
}
