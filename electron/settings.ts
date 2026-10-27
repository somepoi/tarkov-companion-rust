/** Tiny JSON settings store in Electron's userData folder. */
import fs from 'node:fs'
import path from 'node:path'
import defaults from '../config/desktop-defaults.json' with { type: 'json' }
import type { DesktopSettings } from '../src/shared/desktop-api'

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

  constructor(userDataDir: string) {
    this.file = path.join(userDataDir, 'settings.json')
    this.data = { ...DEFAULT_SETTINGS }
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<StoredSettings> & Record<string, unknown>
      // The overlay window was removed in 1.8.0: drop its old settings.
      for (const k of ['overlay', 'overlayHotkey', 'overlayOpacity', 'assistantHotkey']) delete raw[k]
      this.data = {
        ...DEFAULT_SETTINGS,
        ...raw,
        window: { ...DEFAULT_SETTINGS.window, ...(raw.window ?? {}) },
      }
      // Installs from before the setup screen existed: an earlier backfill means setup already happened.
      if (raw.setupDone === undefined && raw.initialBackfillDone) this.data.setupDone = true
    } catch {
      // first run
    }
  }

  get(): StoredSettings {
    return { ...this.data, window: { ...this.data.window } }
  }

  /** The renderer-facing subset (no window bounds). */
  getPublic(): DesktopSettings {
    const { window: _w, trayNoticeShown: _t, lastCleanedVersion: _c, searchBarPos: _p, ...rest } = this.data
    return rest
  }

  update(patch: Partial<StoredSettings>): StoredSettings {
    this.data = {
      ...this.data,
      ...patch,
      window: { ...this.data.window, ...(patch.window ?? {}) },
    }
    this.save()
    return this.get()
  }

  private save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2))
    } catch {
      // Not fatal: settings just won't persist this time.
    }
  }
}
