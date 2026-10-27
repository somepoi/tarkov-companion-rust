/**
 * Settings → Updates → "Clean up after updates": removes what earlier versions of the app
 * left behind. Only the app's own leftovers are touched:
 * - the updater's download cache (old installers), unless an update is waiting to be installed;
 * - content packs of older app versions (userData\packs);
 * - old crash reports (userData\Crashpad\reports);
 * - installers / portable exes of OLDER versions in the Downloads folder, matched by their exact
 *   release file names, moved to the Recycle Bin (so they can be restored).
 * Chromium's compiled-code cache is cleared by main.ts through the session API.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { CleanupResult } from '../src/shared/desktop-api'
import { installerVersion } from './appIdentity'

/** -1, 0 or 1 for dotted version numbers. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return Math.sign(d)
  }
  return 0
}

/** Installer/portable file names of versions older than `current` (newer or equal ones stay). */
export function oldInstallerNames(names: string[], current: string): string[] {
  return names.filter((n) => {
    const v = installerVersion(n)
    return Boolean(v && compareVersions(v, current) < 0)
  })
}

/** Pack folders that are not the current version of their pack (plus half-finished unpacks). */
export function stalePackDirs(names: string[], keep: Set<string>): string[] {
  return names.filter((n) => !keep.has(n) && /^(?:lighthouse|scan|voice|tts|asr|nlu)-[0-9a-f]{16}(?:\.tmp)?$/.test(n))
}

/** Size of a file or folder in bytes (0 when missing). */
export function sizeOf(p: string): number {
  try {
    const st = fs.lstatSync(p)
    if (!st.isDirectory()) return st.size
    let total = 0
    for (const e of fs.readdirSync(p)) total += sizeOf(path.join(p, e))
    return total
  } catch {
    return 0
  }
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

export interface CleanupPlaces {
  currentVersion: string
  /** The fork's updater cache; null = leave it (an update is waiting). */
  updaterCacheDir: string | null
  /** userData\packs and the folder names to keep; null = packs not in use (development, web). */
  packs: { root: string; keep: Set<string> } | null
  crashReportsDir: string
  downloadsDir: string | null
  /** The portable exe this app runs from, if any: never touched. */
  runningExe: string | null
  /** Moves a file to the Recycle Bin. */
  trash: (file: string) => Promise<void>
  /** dry = only measure what would be removed. */
  dry: boolean
}

export async function cleanLeftovers(p: CleanupPlaces): Promise<CleanupResult> {
  const items: CleanupResult['items'] = []
  const remove = (label: string, target: string) => {
    const bytes = sizeOf(target)
    if (!p.dry) fs.rmSync(target, { recursive: true, force: true })
    items.push({ label, bytes })
  }

  if (p.updaterCacheDir) {
    for (const e of listDir(p.updaterCacheDir)) remove(`Update download: ${e}`, path.join(p.updaterCacheDir, e))
  }
  if (p.packs) {
    for (const e of stalePackDirs(listDir(p.packs.root), p.packs.keep)) remove(`Old content pack: ${e}`, path.join(p.packs.root, e))
  }
  for (const e of listDir(p.crashReportsDir)) remove(`Crash report: ${e}`, path.join(p.crashReportsDir, e))
  if (p.downloadsDir) {
    for (const e of oldInstallerNames(listDir(p.downloadsDir), p.currentVersion)) {
      const file = path.join(p.downloadsDir, e)
      if (p.runningExe && path.resolve(file).toLowerCase() === path.resolve(p.runningExe).toLowerCase()) continue
      const bytes = sizeOf(file)
      if (!p.dry) await p.trash(file)
      items.push({ label: `Old installer in Downloads (to Recycle Bin): ${e}`, bytes })
    }
  }
  return { items, bytes: items.reduce((s, i) => s + i.bytes, 0), dry: p.dry, at: Date.now() }
}
