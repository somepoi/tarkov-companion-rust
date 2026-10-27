import path from 'node:path'
import pkg from '../package.json' with { type: 'json' }

/** Package metadata is shared by the installer, desktop host and Vite renderer. */
export const APP_IDENTITY = {
  name: pkg.productName,
  appId: pkg.build.appId,
  repositoryUrl: pkg.repository.url.replace(/\.git$/, ''),
  ...pkg.companion,
} as const

export const RELEASES_URL = `${APP_IDENTITY.repositoryUrl}/releases/latest`

export function forkDataPath(appData: string): string {
  return path.join(appData, APP_IDENTITY.dataDirectoryName)
}

export function forkUpdaterCachePath(localAppData: string): string {
  return path.join(localAppData, APP_IDENTITY.updaterCacheDirectoryName)
}

export function installerFileName(version: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid installer version')
  return `${APP_IDENTITY.artifactPrefix}-Setup-${version}.exe`
}

/** Anchored to the fork's exact artifact prefix; original installers never match. */
export function installerVersion(name: string): string | null {
  const prefix = APP_IDENTITY.artifactPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`^${prefix}-(?:Setup-(\\d+\\.\\d+\\.\\d+)\\.exe(?:\\.blockmap)?|(\\d+\\.\\d+\\.\\d+)-portable\\.exe)$`, 'i').exec(name)
  return match?.[1] ?? match?.[2] ?? null
}
