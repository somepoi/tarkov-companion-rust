import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { subscribe } from './tauriEvents'
import { nativeLogBridge } from '../logs/nativeBridge'
import type {
  BackfillProgress,
  DesktopApi,
  DesktopSettings,
  GameEvent,
  PackName,
  PackProgress,
  PlayerPosition,
  UpdateStatus,
  WatcherState,
  WipeEvent,
} from '../../shared/desktop-api'

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return await invoke<T>('desktop_call', { channel, args })
  } catch (cause) {
    const message =
      typeof cause === 'object' && cause !== null && 'message' in cause
        ? String(cause.message)
        : String(cause)
    throw new Error(message, { cause })
  }
}

export async function createTauriDesktop(): Promise<DesktopApi> {
  let captureErrorHandler: ((message: string) => void) | undefined
  const metadata = await invoke<{
    platform: string
    appVersion: string
    windowKind: 'main' | 'searchbar'
  }>('desktop_metadata')
  const logs = metadata.windowKind === 'main' ? nativeLogBridge() : null
  const api: DesktopApi = {
    reportUiReady: () => call('ui:ready'),
    platform: metadata.platform,
    appVersion: metadata.appVersion,
    windowKind: metadata.windowKind,
    setSearchBarSize: (width, height) => call('searchbar:size', width, height),
    openInApp: (to) => call('searchbar:open', to),
    moveSearchBar: (dx, dy) => call('searchbar:move', dx, dy),
    searchBarMoved: () => call('searchbar:moved'),
    searchBarHome: () => call('searchbar:home'),
    setSearchBarPassthrough: (on) => call('searchbar:passthrough', on),
    onSearchBarLayout: (cb) =>
      subscribe<{ left: boolean; up: boolean }>('searchbar:layout', cb),
    setSearchBarLocked: (on) => call('searchbar:lock', on),
    isSearchBarLocked: () => call('searchbar:locked'),
    onSearchBarLocked: (cb) => subscribe<boolean>('searchbar:locked', cb),
    hideSearchBar: () => call('searchbar:hide'),
    releaseSearchBar: () => call('searchbar:release'),
    onSearchBarFocus: (cb) => subscribe<void>('searchbar:focus', () => cb()),
    onSearchBarMap: (cb) => subscribe<void>('searchbar:map', () => cb()),
    searchBarCorner: (corner) => call('searchbar:corner', corner),
    getState: logs?.getState ?? (() => call('watcher:getState')),
    ensurePack: async (name: PackName) => {
      const rel =
        name === 'scan'
          ? 'scan/fingerprints.json'
          : 'tiles/lighthouse-re3mr/0/0/0.png'
      const response = await fetch(
        new URL(import.meta.env.BASE_URL + rel, location.href),
      ).catch(() => null)
      if (
        !response?.ok ||
        response.headers.get('content-type')?.includes('text/html') ||
        (name === 'scan' &&
          !response.headers.get('content-type')?.includes('json'))
      )
        await call('packs:ensure', name)
    },
    onPackProgress: (cb) => subscribe<PackProgress>('pack:progress', cb),
    getSettings: () => call('settings:get'),
    setSettings: (patch: Partial<DesktopSettings>) =>
      call('settings:set', patch),
    pickLogsFolder: () => call('watcher:pickFolder'),
    readPastLogs: logs?.readPastLogs ?? (() => call('watcher:backfill')),
    getRecentEvents: logs?.getRecentEvents ?? (() => call('watcher:recent')),
    openLogsFolder: () => call('watcher:openFolder'),
    openExternal: (url: string) => call('shell:openExternal', url),
    readAppResource: async (rel: string) => {
      if (
        !/^(scan|ocr|tiles)\//.test(rel) ||
        rel.split(/[\\/]/).some((p) => p === '..' || p === '.') ||
        rel.includes('\\')
      )
        throw new Error('Invalid resource path')
      const response = await fetch(
        new URL(import.meta.env.BASE_URL + rel, location.href),
      ).catch(() => null)
      if (!response?.ok || response.headers.get('content-type')?.includes('text/html'))
        return invoke<ArrayBuffer>('read_pack_resource', { relative: rel })
      return response.arrayBuffer()
    },
    appResourceUrl: (relative) => convertFileSrc(relative, 'tcres'),
    captureScreen: async () =>
      new Uint8Array(await invoke<ArrayBuffer>('capture_screen')),
    listGameScreenshots: () => call('scan:listShots'),
    readGameScreenshot: async (name: string) =>
      new Uint8Array(
        await invoke<ArrayBuffer>('read_game_screenshot', { name }),
      ),
    onScanCapture: (cb) => {
      let disposed = false
      let latest = -1
      const consume = (id: number) => {
        if (disposed || id <= latest) return
        latest = id
        void invoke<ArrayBuffer>('take_scan_capture', { id })
          .then((bytes) => {
            if (!disposed && latest === id) cb(new Uint8Array(bytes))
          })
          .catch((error: unknown) => {
            if (!disposed && latest === id) captureErrorHandler?.(String(error))
          })
      }
      const stop = subscribe<number>('scan-capture-ready', consume, () => {
        void invoke<number | null>('pending_scan_capture_id')
          .then((id) => {
            if (id !== null) consume(id)
          })
          .catch((error: unknown) => {
            if (!disposed) captureErrorHandler?.(String(error))
          })
      })
      return () => {
        disposed = true
        stop()
      }
    },
    onScanCaptureError: (cb) => {
      captureErrorHandler = cb
      const stop = subscribe<string>('scan-capture-error', cb)
      return () => {
        if (captureErrorHandler === cb) captureErrorHandler = undefined
        stop()
      }
    },
    onOpenInApp: (cb) => subscribe<string>('app:open', cb),
    getUpdateStatus: () => call('update:status'),
    checkForUpdates: () => call('update:check'),
    installUpdate: () => call('update:install'),
    getUpdateOutcome: () => call('update:outcome'),
    readLogStats: logs?.readLogStats ?? (() => call('stats:read')),
    getLatestPosition: () => call('position:latest'),
    writeBackup: (json) => call('backup:write', json),
    listBackups: () => call('backup:list'),
    readBackup: (name) => call('backup:read', name),
    openBackupsFolder: () => call('backup:openFolder'),
    cleanUp: (dry) => call('cleanup:run', dry),
    lastCleanup: () => call('cleanup:last'),
    onPosition: (cb) => subscribe<PlayerPosition>('position:new', cb),
    runInstaller: (version) => call('update:runInstaller', version),
    onUpdateStatus: (cb) => subscribe<UpdateStatus>('update:status', cb),
    onEvent:
      logs?.onEvent ?? ((cb) => subscribe<GameEvent>('watcher:event', cb)),
    onState:
      logs?.onState ?? ((cb) => subscribe<WatcherState>('watcher:state', cb)),
    onBackfillProgress:
      logs?.onBackfillProgress ??
      ((cb) => subscribe<BackfillProgress>('watcher:backfillProgress', cb)),
    onWipeDetected: (cb) => subscribe<WipeEvent>('wipe:detected', cb),
    onSettingsChanged: (cb) =>
      subscribe<DesktopSettings>('settings:changed', cb),
  }

  return api
}
