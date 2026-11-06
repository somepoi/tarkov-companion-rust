/**
 * Write-then-rename for the small JSON files the shell owns (settings, daily backups).
 *
 * A direct `writeFileSync` over the live file leaves a half-written document if the process dies
 * mid-write, and the next start then reads truncated JSON. Writing a uniquely named temporary
 * file, flushing it to disk and renaming it over the target means a reader sees either the whole
 * old document or the whole new one.
 *
 * This mirrors `atomic_write` in `src-tauri/src/desktop.rs` so the Electron reference and the
 * native shell cannot drift: same temporary-name shape, same flush-before-rename, and the
 * temporary file is removed when anything fails so a failure never leaves debris behind.
 */
import fs from 'node:fs'
import path from 'node:path'

let serial = 0

export function atomicWriteSync(file: string, bytes: string): void {
  const temporary = `${file}.${process.pid}.${serial++}.pending`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  try {
    // `wx` never adopts an existing temporary file, so two writers cannot interleave.
    const fd = fs.openSync(temporary, 'wx')
    try {
      fs.writeFileSync(fd, bytes)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(temporary, file)
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true })
    } catch {
      // The original error is the one worth reporting.
    }
    throw error
  }
}
