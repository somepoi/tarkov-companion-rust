/**
 * Finds the Escape from Tarkov logs folder without touching the game.
 * Read-only: we only look at the BSG launcher's settings file, Steam's
 * library list and a few default paths. No other program is started.
 */
import fs from 'node:fs'
import path from 'node:path'
import { logFolderTime } from './parser'

export interface LogsDetection {
  path: string | null
  /** Every install root we looked at, for the Settings screen. */
  candidates: string[]
}

/** True when `dir` looks like an EFT Logs folder (contains log_<timestamp> folders). */
export function looksLikeLogsFolder(dir: string): boolean {
  try {
    if (!fs.statSync(dir).isDirectory()) return false
    return fs.readdirSync(dir).some((n) => logFolderTime(n) !== null)
  } catch {
    return false
  }
}

/** Logs folder for an install root, if present (EFT uses <root>\Logs or <root>\build\Logs). */
export function logsFolderForInstall(root: string): string | null {
  for (const candidate of [path.join(root, 'Logs'), path.join(root, 'build', 'Logs')]) {
    if (looksLikeLogsFolder(candidate)) return candidate
  }
  return null
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** Install roots named by the BSG launcher's settings (%APPDATA%\Battlestate Games\BsgLauncher\settings). */
function launcherRoots(): string[] {
  const appData = process.env.APPDATA
  if (!appData) return []
  const out: string[] = []
  for (const name of ['settings', 'settings.json']) {
    const file = path.join(appData, 'Battlestate Games', 'BsgLauncher', name)
    const json = readJson(file) as { gamesRootDir?: unknown; tempFolder?: unknown } | null
    if (!json) continue
    // Only the two path fields are read; the file also holds an auth token we never touch.
    if (typeof json.gamesRootDir === 'string' && json.gamesRootDir) {
      out.push(path.join(json.gamesRootDir, 'EFT'), path.join(json.gamesRootDir, 'EFT (live)'), json.gamesRootDir)
    }
    if (typeof json.tempFolder === 'string' && json.tempFolder) {
      // "...\Escape from Tarkov\launcher\Temp" -> "...\Escape from Tarkov"
      const m = /^(.*)[\\/]launcher[\\/]Temp[\\/]?$/i.exec(json.tempFolder)
      if (m) out.push(m[1])
    }
  }
  return out
}

/** Steam library folders from libraryfolders.vdf, plus the default Steam path. */
function steamRoots(): string[] {
  const steamDirs = [
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Steam'),
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Steam'),
  ]
  const libraries = new Set<string>(steamDirs)
  for (const steam of steamDirs) {
    const vdf = path.join(steam, 'steamapps', 'libraryfolders.vdf')
    try {
      const text = fs.readFileSync(vdf, 'utf8')
      for (const m of text.matchAll(/"path"\s+"([^"]+)"/g)) libraries.add(m[1].replace(/\\\\/g, '\\'))
    } catch {
      // no Steam here
    }
  }
  return [...libraries].map((lib) => path.join(lib, 'steamapps', 'common', 'Escape from Tarkov'))
}

const DEFAULT_ROOTS = ['C:\\Battlestate Games\\EFT', 'C:\\Battlestate Games\\EFT (live)', 'C:\\Games\\EFT', 'D:\\Battlestate Games\\EFT']

export function detectLogsFolder(): LogsDetection {
  const candidates: string[] = []
  const seen = new Set<string>()
  for (const root of [...launcherRoots(), ...steamRoots(), ...DEFAULT_ROOTS]) {
    const key = root.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push(root)
  }
  for (const root of candidates) {
    const logs = logsFolderForInstall(root)
    if (logs) return { path: logs, candidates }
  }
  return { path: null, candidates }
}
