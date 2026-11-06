import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { DEFAULT_SETTINGS, SettingsStore } from './settings'

it('starts with defaults and preserves a settings file containing JSON null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-settings-'))
  const file = path.join(dir, 'settings.json')
  try {
    fs.writeFileSync(file, 'null')
    const settings = new SettingsStore(dir)
    expect(settings.get()).toEqual(DEFAULT_SETTINGS)
    expect(settings.recoveryError).toContain('Settings must contain an object')
    expect(() => settings.update({ paused: true })).toThrow('settings writes are disabled')
    expect(fs.readFileSync(file, 'utf8')).toBe('null')
  } finally {
    fs.rmSync(file, { force: true })
    fs.rmdirSync(dir)
  }
})
