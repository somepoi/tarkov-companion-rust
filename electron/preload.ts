import { contextBridge, ipcRenderer } from 'electron'
import type { BackfillProgress, DesktopApi, DesktopSettings, GameEvent, PackName, PackProgress, PlayerPosition, SearchBarFrame, UpdateStatus, WatcherState, WipeEvent } from '../src/shared/desktop-api'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: DesktopApi = {
  reportUiReady: () => ipcRenderer.invoke('ui:ready'),
  benchmarkMode: process.argv.includes('--tc-benchmark'),
  reportCatalogReady: (summary) => ipcRenderer.invoke('benchmark:catalog-ready', summary),
  platform: process.platform,
  appVersion: process.argv.find((a) => a.startsWith('--tc-version='))?.slice('--tc-version='.length) ?? '',
  windowKind: process.argv.includes('--tc-window=searchbar') ? 'searchbar' : 'main',
  openInApp: (to) => ipcRenderer.invoke('searchbar:open', to),
  getSearchBarFrame: () => ipcRenderer.invoke('searchbar:frame'),
  onSearchBarFrame: (cb) => subscribe<SearchBarFrame>('searchbar:frame', cb),
  searchBarMoved: (x, y) => ipcRenderer.invoke('searchbar:moved', x, y),
  searchBarHome: () => ipcRenderer.invoke('searchbar:home'),
  setSearchBarShape: (rects) => ipcRenderer.invoke('searchbar:shape', rects),
  setSearchBarLocked: (on) => ipcRenderer.invoke('searchbar:lock', on),
  isSearchBarLocked: () => ipcRenderer.invoke('searchbar:locked'),
  onSearchBarLocked: (cb) => subscribe<boolean>('searchbar:locked', cb),
  hideSearchBar: () => ipcRenderer.invoke('searchbar:hide'),
  releaseSearchBar: () => ipcRenderer.invoke('searchbar:release'),
  onSearchBarFocus: (cb) => subscribe<void>('searchbar:focus', () => cb()),
  onSearchBarMap: (cb) => subscribe<void>('searchbar:map', () => cb()),
  searchBarCorner: (corner) => ipcRenderer.invoke('searchbar:corner', corner),
  startSnip: () => ipcRenderer.invoke('searchbar:snip'),
  endSnip: () => ipcRenderer.invoke('searchbar:snipEnd'),
  onSnipCancel: (cb) => subscribe<void>('searchbar:snipCancel', () => cb()),
  getState: () => ipcRenderer.invoke('watcher:getState'),
  ensurePack: (name: PackName) => ipcRenderer.invoke('pack:ensure', name),
  onPackProgress: (cb) => subscribe<PackProgress>('pack:progress', cb),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Partial<DesktopSettings>) => ipcRenderer.invoke('settings:set', patch),
  pickLogsFolder: () => ipcRenderer.invoke('watcher:pickFolder'),
  readPastLogs: () => ipcRenderer.invoke('watcher:backfill'),
  getRecentEvents: () => ipcRenderer.invoke('watcher:recent'),
  openLogsFolder: () => ipcRenderer.invoke('watcher:openFolder'),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  readAppResource: async (rel: string) => {
    const bytes = (await ipcRenderer.invoke('resource:read', rel)) as Uint8Array
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  },
  captureScreen: () => ipcRenderer.invoke('scan:capture'),
  listGameScreenshots: () => ipcRenderer.invoke('scan:listShots'),
  readGameScreenshot: (name: string) => ipcRenderer.invoke('scan:readShot', name),
  onScanCapture: (cb) => subscribe<Uint8Array>('scan:captured', cb),
  onOpenInApp: (cb) => subscribe<string>('app:open', cb),
  getUpdateStatus: () => ipcRenderer.invoke('update:status'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  getUpdateOutcome: () => ipcRenderer.invoke('update:outcome'),
  readLogStats: () => ipcRenderer.invoke('stats:read'),
  getLatestPosition: () => ipcRenderer.invoke('position:latest'),
  writeBackup: (json) => ipcRenderer.invoke('backup:write', json),
  listBackups: () => ipcRenderer.invoke('backup:list'),
  readBackup: (name) => ipcRenderer.invoke('backup:read', name),
  openBackupsFolder: () => ipcRenderer.invoke('backup:openFolder'),
  cleanUp: (dry) => ipcRenderer.invoke('cleanup:run', dry),
  lastCleanup: () => ipcRenderer.invoke('cleanup:last'),
  onPosition: (cb) => subscribe<PlayerPosition>('position:new', cb),
  runInstaller: (version) => ipcRenderer.invoke('update:runInstaller', version),
  onUpdateStatus: (cb) => subscribe<UpdateStatus>('update:status', cb),
  onEvent: (cb) => subscribe<GameEvent>('watcher:event', cb),
  onState: (cb) => subscribe<WatcherState>('watcher:state', cb),
  onBackfillProgress: (cb) => subscribe<BackfillProgress>('watcher:backfillProgress', cb),
  onWipeDetected: (cb) => subscribe<WipeEvent>('wipe:detected', cb),
  onSettingsChanged: (cb) => subscribe<DesktopSettings>('settings:changed', cb),
}

contextBridge.exposeInMainWorld('desktop', api)
