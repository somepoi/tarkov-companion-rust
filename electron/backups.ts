/**
 * Daily automatic backups of the progress file (desktop). Stored in the app's own data
 * folder (userData\backups), one file per day, the newest KEEP files kept.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { BackupInfo } from '../src/shared/desktop-api'
import { atomicWriteSync } from './atomicWrite'

const KEEP = 7
const NAME_RE = /^progress-\d{4}-\d{2}-\d{2}\.json$/

export function backupDir(userData: string): string {
  return path.join(userData, 'backups')
}

export function listBackups(userData: string): BackupInfo[] {
  const dir = backupDir(userData)
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => NAME_RE.test(n))
      .map((name) => {
        const st = fs.statSync(path.join(dir, name))
        return { name, at: st.mtimeMs, size: st.size }
      })
      .sort((a, b) => b.name.localeCompare(a.name))
  } catch (error) {
    // A missing folder is normal (no backup yet). Anything else is a real read failure and is
    // logged, so "no backups" never hides a permission or I/O problem without a trace.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[backups] could not list', dir, error instanceof Error ? error.message : error)
    }
    return []
  }
}

/** Writes today's backup (replacing an earlier one from today) and removes the oldest beyond KEEP. */
export function writeBackup(userData: string, json: string, now = new Date(), keep = KEEP): BackupInfo {
  if (json.length > 50_000_000) throw new Error('Backup too large')
  JSON.parse(json) // only valid JSON is stored
  const dir = backupDir(userData)
  fs.mkdirSync(dir, { recursive: true })
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const name = `progress-${day}.json`
  // Rename over the day's file so a crash never leaves a half-written backup behind.
  atomicWriteSync(path.join(dir, name), json)
  // Retention is best effort. A copy that could not be removed only means an extra old backup
  // stays; the new one is already safely on disk, so this is logged rather than reported as a
  // failed backup.
  for (const old of listBackups(userData).slice(Math.max(1, keep))) {
    try {
      fs.rmSync(path.join(dir, old.name), { force: true })
    } catch (error) {
      console.error('[backups] could not remove', old.name, error instanceof Error ? error.message : error)
    }
  }
  const st = fs.statSync(path.join(dir, name))
  return { name, at: st.mtimeMs, size: st.size }
}

export function readBackup(userData: string, name: string): string {
  if (!NAME_RE.test(name)) throw new Error('Not a backup file')
  return fs.readFileSync(path.join(backupDir(userData), name), 'utf8')
}
