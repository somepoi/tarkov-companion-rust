import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanLeftovers, oldInstallerNames, stalePackDirs } from './cleanup'
import { APP_IDENTITY, installerFileName } from './appIdentity'

describe('oldInstallerNames', () => {
  it('picks only release files of older versions', () => {
    const installer = installerFileName('1.17.0')
    const portable = `${APP_IDENTITY.artifactPrefix}-1.9.0-portable.exe`
    const names = [
      installer,
      `${installer}.blockmap`,
      portable,
      installerFileName('1.18.0'),
      installerFileName('1.19.0'),
      installer.replace('.exe', ' (1).exe'),
      `${installer}.txt`,
      'TarkovCompanion-Setup-1.17.0.exe',
      'SomethingElse-Setup-1.0.0.exe',
    ]
    expect(oldInstallerNames(names, '1.18.0')).toEqual([installer, `${installer}.blockmap`, portable])
  })
})

describe('stalePackDirs', () => {
  it('keeps current packs and unknown folders', () => {
    const keep = new Set(['scan-0123456789abcdef'])
    expect(stalePackDirs(['scan-0123456789abcdef', 'scan-fedcba9876543210', 'lighthouse-aaaaaaaaaaaaaaaa.tmp', 'notes', 'scan-short', 'tts-0123456789abcdef'], keep)).toEqual(['scan-fedcba9876543210', 'lighthouse-aaaaaaaaaaaaaaaa.tmp', 'tts-0123456789abcdef'])
  })
})

describe('cleanLeftovers', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cleanup-'))
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it('measures in a dry run and removes for real otherwise', async () => {
    const updater = path.join(tmp, 'updater')
    const downloads = path.join(tmp, 'Downloads')
    const installer = installerFileName('1.17.0')
    const upstreamInstaller = 'TarkovCompanion-Setup-1.17.0.exe'
    fs.mkdirSync(path.join(updater, 'pending'), { recursive: true })
    fs.writeFileSync(path.join(updater, 'pending', installer), 'x'.repeat(100))
    fs.mkdirSync(downloads)
    fs.writeFileSync(path.join(downloads, installer), 'y'.repeat(50))
    fs.writeFileSync(path.join(downloads, upstreamInstaller), 'original')
    fs.writeFileSync(path.join(downloads, 'holiday.jpg'), 'z')
    const trashed: string[] = []
    const places = { currentVersion: '1.18.0', updaterCacheDir: updater, packs: null, crashReportsDir: path.join(tmp, 'none'), downloadsDir: downloads, runningExe: null, trash: async (f: string) => { trashed.push(f); fs.rmSync(f) } }

    const dry = await cleanLeftovers({ ...places, dry: true })
    expect(dry.bytes).toBe(150)
    expect(fs.existsSync(path.join(updater, 'pending'))).toBe(true)

    const real = await cleanLeftovers({ ...places, dry: false })
    expect(real.bytes).toBe(150)
    expect(fs.readdirSync(updater)).toEqual([])
    expect(trashed).toEqual([path.join(downloads, installer)])
    expect(fs.readdirSync(downloads).sort()).toEqual([upstreamInstaller, 'holiday.jpg'].sort())
  })
})
