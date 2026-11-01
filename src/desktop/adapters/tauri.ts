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
    benchmarkMode: boolean
  }>('desktop_metadata')
  const logs = metadata.windowKind === 'main' ? nativeLogBridge() : null
  const overlaySubscriptions: Promise<void>[] = []
  const overlaySubscribe = <T>(channel: string, cb: (value: T) => void) => {
    let stop = () => {}
    let complete = () => {}
    const ready = new Promise<void>((resolve, reject) => { complete = resolve; stop = subscribe(channel, cb, resolve, reject) })
    overlaySubscriptions.push(ready)
    void ready.catch(() => undefined)
    return () => { stop(); complete() }
  }
  type OverlayJob = { channel: string; args: unknown[]; promise: Promise<unknown>; resolve: (value: unknown) => void; reject: (error: unknown) => void }
  const overlayQueue: OverlayJob[] = []
  let overlayRunning = false
  const drainOverlay = async () => {
    if (overlayRunning) return
    overlayRunning = true
    try {
      while (overlayQueue.length) {
        const next = overlayQueue.shift()!
        try {
          if (next.channel === 'searchbar:move') {
            let dx = Number(next.args[0]), dy = Number(next.args[1])
            while (dx || dy) {
              const x = Math.max(-9999, Math.min(9999, dx)), y = Math.max(-9999, Math.min(9999, dy))
              await call('searchbar:move', x, y); dx -= x; dy -= y
            }
            next.resolve(null)
          } else next.resolve(await call(next.channel, ...next.args))
        } catch (error) { next.reject(error) }
      }
    } finally { overlayRunning = false }
  }
  const overlayCall = <T>(channel: string, ...args: unknown[]): Promise<T> => {
    const pending = overlayQueue.at(-1)
    if (channel === 'searchbar:move') {
      if (!args.every((value) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 10000)) return Promise.reject(new Error('Invalid movement'))
      if (pending?.channel === channel) {
        const x = Number(pending.args[0]) + Number(args[0]), y = Number(pending.args[1]) + Number(args[1])
        if (Math.abs(x) > 1_000_000 || Math.abs(y) > 1_000_000) return Promise.reject(new Error('Searchbar movement queue exceeds its limit'))
        pending.args = [x, y]
        return pending.promise as Promise<T>
      }
    }
    if (pending?.channel === channel && ['searchbar:size', 'searchbar:regions'].includes(channel)) { pending.args = args; return pending.promise as Promise<T> }
    if (overlayQueue.length >= 32) return Promise.reject(new Error('Searchbar is busy; retry shortly'))
    let resolve!: (value: unknown) => void, reject!: (error: unknown) => void
    const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no })
    overlayQueue.push({ channel, args, promise, resolve, reject })
    void drainOverlay()
    return promise as Promise<T>
  }
  const api: DesktopApi = {
    saveExport: async ({ kind, name, text }, isCurrent = () => true) => {
      if (!isCurrent()) return 'cancelled'
      const selected = await call<{ id: string } | null>('export:select', { kind, name })
      if (!selected) return 'cancelled'
      try {
        if (!isCurrent()) return 'cancelled'
        if (await call<boolean>('export:write', { id: selected.id, text }) !== true) throw new Error('Export was not saved')
        return 'saved'
      } finally {
        await call('export:cancel', selected.id).catch(() => undefined)
      }
    },
    reportUiReady: () => call('ui:ready'),
    benchmarkMode: metadata.benchmarkMode,
    reportCatalogReady: (summary) => call('benchmark:catalog-ready', summary),
    platform: metadata.platform,
    appVersion: metadata.appVersion,
    windowKind: metadata.windowKind,
    setSearchBarSize: (width, height) => overlayCall('searchbar:size', width, height),
    setSearchBarRegions: (regions) => overlayCall('searchbar:regions', regions),
    searchBarReady: async () => { await Promise.all(overlaySubscriptions); await overlayCall('searchbar:ready') },
    onSearchBarGeometry: (cb) => overlaySubscribe('searchbar:geometry', cb),
    onSearchBarError: (cb) => subscribe<string>('searchbar:error', cb, () => {
      void overlayCall<string | null>('searchbar:lastError').then((message) => { if (message) cb(message) }).catch(() => undefined)
    }),
    reportSearchBarError: (message) => overlayCall('searchbar:reportError', message),
    openInApp: (to) => overlayCall('searchbar:open', to),
    moveSearchBar: (dx, dy) => overlayCall('searchbar:move', dx, dy),
    searchBarMoved: () => overlayCall('searchbar:moved'),
    searchBarHome: () => overlayCall('searchbar:home'),
    setSearchBarPassthrough: (on) => overlayCall('searchbar:passthrough', on),
    onSearchBarLayout: (cb) =>
      overlaySubscribe<{ left: boolean; up: boolean }>('searchbar:layout', cb),
    setSearchBarLocked: (on) => overlayCall('searchbar:lock', on),
    isSearchBarLocked: () => overlayCall('searchbar:locked'),
    onSearchBarLocked: (cb) => overlaySubscribe<boolean>('searchbar:locked', cb),
    hideSearchBar: () => overlayCall('searchbar:hide'),
    releaseSearchBar: () => overlayCall('searchbar:release'),
    onSearchBarFocus: (cb) => overlaySubscribe<void>('searchbar:focus', () => cb()),
    onSearchBarMap: (cb) => overlaySubscribe<void>('searchbar:map', () => cb()),
    searchBarCorner: (corner) => overlayCall('searchbar:corner', corner),
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
    getLatestPosition: async () => {
      if (metadata.windowKind === 'main') await call('position:connect')
      return call('position:latest')
    },
    writeBackup: (json) => call('backup:write', json),
    listBackups: () => call('backup:list'),
    readBackup: (name) => call('backup:read', name),
    openBackupsFolder: () => call('backup:openFolder'),
    cleanUp: (dry) => call('cleanup:run', dry),
    lastCleanup: () => call('cleanup:last'),
    onPosition: (cb) => subscribe<PlayerPosition>('position:new', cb),
    onPositionError: (cb) => subscribe<string>('position:error', cb),
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
