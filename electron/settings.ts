/** Tiny JSON settings store in Electron's userData folder. */
import fs from 'node:fs'
import path from 'node:path'
import defaults from '../config/desktop-defaults.json' with { type: 'json' }
import type { DesktopSettings } from '../src/shared/desktop-api'
import { atomicWriteSync } from './atomicWrite'

export interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
  maximized?: boolean
}

export interface StoredSettings extends DesktopSettings {
  /** App version the automatic clean-up last ran for (runs once per new version). */
  lastCleanedVersion: string | null
  /** The one-time "still running in the tray" balloon was shown. */
  trayNoticeShown: boolean
  /** Where the search bar's magnifying glass was dragged to (screen point), or null = top left. */
  searchBarPos: { x: number; y: number } | null
  window: WindowBounds
}

export const DEFAULT_SETTINGS: StoredSettings = defaults as StoredSettings

export class SettingsStore {
  private file: string
  private data: StoredSettings
  /** Set when a settings file exists but could not be read: writes must not overwrite it. */
  private readError: string | null = null

  constructor(userDataDir: string) {
    this.file = path.join(userDataDir, 'settings.json')
    this.data = { ...DEFAULT_SETTINGS }
    let text: string
    try {
      text = fs.readFileSync(this.file, 'utf8')
    } catch (error) {
      // No file yet is a normal first run. Any other read failure means a file exists that we
      // cannot interpret, and saving over it would destroy whatever the user actually has.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.readError = `Settings could not be read: ${error instanceof Error ? error.message : String(error)}. Original file retained; settings writes are disabled until recovery.`
      }
      return
    }
    // Windows Notepad and some editors save UTF-8 with a byte-order mark. JSON.parse
    // rejects it, but the JSON behind it is valid, so a file the user fixed by hand
    // must not be reported as corrupt.
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    let raw: Partial<StoredSettings> & Record<string, unknown>
    try {
      const saved: unknown = JSON.parse(text)
      if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) {
        throw new Error('Settings must contain an object')
      }
      raw = saved as typeof raw
    } catch (error) {
      this.readError = `Settings could not be read: ${error instanceof Error ? error.message : String(error)}. Original file retained; settings writes are disabled until recovery.`
      return
    }
    // The overlay window was removed in 1.8.0: drop its old settings.
    for (const k of ['overlay', 'overlayHotkey', 'overlayOpacity', 'assistantHotkey']) delete raw[k]
    this.data = {
      ...DEFAULT_SETTINGS,
      ...raw,
      window: { ...DEFAULT_SETTINGS.window, ...(raw.window ?? {}) },
    }
    // Installs from before the setup screen existed: an earlier backfill means setup already happened.
    if (raw.setupDone === undefined && raw.initialBackfillDone) this.data.setupDone = true
  }

  /** Why settings cannot be saved, if a file exists that was not readable. */
  get recoveryError(): string | null {
    return this.readError
  }

  get(): StoredSettings {
    return { ...this.data, window: { ...this.data.window } }
  }

  /** The renderer-facing subset (no window bounds). */
  getPublic(): DesktopSettings {
    const { window: _w, trayNoticeShown: _t, lastCleanedVersion: _c, searchBarPos: _p, ...rest } = this.data
    return rest
  }

  /** Applies and persists a patch. Throws when it could not be saved, leaving the old value in memory. */
  update(patch: Partial<StoredSettings>): StoredSettings {
    if (this.readError) throw new Error(this.readError)
    const previous = this.data
    const next = {
      ...this.data,
      ...patch,
      window: { ...this.data.window, ...(patch.window ?? {}) },
    }
    // Keep memory and disk in step: a value that did not reach the file must not look saved.
    this.data = next
    try {
      this.save()
    } catch (error) {
      this.data = previous
      throw error instanceof Error ? error : new Error(String(error))
    }
    return this.get()
  }

  private save() {
    atomicWriteSync(this.file, JSON.stringify(this.data, null, 2))
  }
}
