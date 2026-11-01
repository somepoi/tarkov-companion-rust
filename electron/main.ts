/**
 * Tarkov Companion desktop shell: main window + tray + the read-only EFT log
 * watcher. The React app runs in the renderer with
 * contextIsolation; the only bridge is the typed API in preload.ts.
 *
 * Nothing here touches the game, and nothing is shown on top of it (the old
 * overlay window was removed in 1.8.0).
 */
import { BrowserWindow, Menu, Tray, app, dialog, globalShortcut, ipcMain, nativeImage, protocol, screen, session, shell } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import fs from 'node:fs'
import { claimBenchmarkProfile } from './benchmarkProfile'
import path from 'node:path'
import type { DesktopSettings, GameEvent, LogStatsData, PlayerPosition, WipeEvent } from '../src/shared/desktop-api'
import { detectLogsFolder } from './logs/locator'
import { LogWatcher } from './logs/watcher'
import { SettingsStore } from './settings'
import { latestPosition, parseScreenshotName, watchScreenshots } from './position'
import { createRaidClock, trashWhenWritten } from './positionShots'
import { backupDir, listBackups, readBackup, writeBackup } from './backups'
import { captureScreenUnderCursor, gameScreenshotsDir, listGameScreenshots, readAppResource, readGameScreenshot, resourceResponse } from './capture'

// Read-only access to the app's own bundled scanner/OCR files (the page is a local file and
// Chromium cannot fetch() file:// URLs). Must be registered before the app is ready.
protocol.registerSchemesAsPrivileged([{ scheme: 'tcres', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }])
import { checkForUpdates, getUpdateOutcome, getUpdateStatus, installUpdate, runInstallerManually, setUpdateMode, setupUpdater } from './updater'
import { cleanSettingsPatch, isAppPath, isSafeDirectory, isSameFileUrl, isScreenshotName, isTrustedSender, isWebUrl, lockPermissions } from './security'
import { PACK_NAMES, currentPackDirNames, ensurePack, packsEnabled } from './packs'
import { cleanLeftovers, sizeOf } from './cleanup'
import type { CleanupResult } from '../src/shared/desktop-api'
import type { PackName } from '../src/shared/desktop-api'
import { APP_IDENTITY, forkDataPath, forkUpdaterCachePath } from './appIdentity'
import { validBenchmarkCatalog } from '../src/shared/benchmark'

const DEV_URL = process.env.VITE_DEV_SERVER_URL
// Isolate browser storage and the instance lock before any startup side effect.
// Explicit --user-data-dir remains available for development and isolated diagnostics.
app.setName(APP_IDENTITY.name)
const customUserData = app.commandLine.getSwitchValue('user-data-dir')
const BENCHMARK_MODE = process.env.TC_BENCH_DISABLE_INTEGRATIONS === '1'
if (BENCHMARK_MODE && !customUserData) throw new Error('Benchmark mode requires an explicit isolated --user-data-dir')
if (BENCHMARK_MODE) claimBenchmarkProfile(customUserData)
app.setPath('userData', customUserData ? path.resolve(customUserData) : forkDataPath(app.getPath('appData')))

let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
/** The search bar over the game (only while switched on in Settings). */
let searchBar: BrowserWindow | null = null
let settings: SettingsStore
const watcher = new LogWatcher()
let stopScreenshots: (() => void) | null = null
/** Raid in progress, from the live game log (for clearing position screenshots). */
const raidClock = createRaidClock()
/** The last screenshot position: still known after its file went to the Recycle Bin. */
let lastPosition: PlayerPosition | null = null

if (!BENCHMARK_MODE && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  if (!BENCHMARK_MODE) app.on('second-instance', () => showWindow())
  app.whenReady().then(bootstrap)
}

function resourcePath(...p: string[]): string {
  return path.join(__dirname, '..', ...p)
}

function appIcon(): Electron.NativeImage {
  const img = nativeImage.createFromPath(resourcePath('build', 'icon.png'))
  return img.isEmpty() ? nativeImage.createEmpty() : img
}

/** Sends to every open renderer window. */
function broadcast(channel: string, payload: unknown) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload)
}

function bootstrap() {
  // Same id as the installer's shortcuts, so Windows shows the app's notifications under its name.
  if (process.platform === 'win32') app.setAppUserModelId(APP_IDENTITY.appId)
  protocol.handle('tcres', (req) => resourceResponse(req.url, Boolean(DEV_URL)))
  lockPermissions(session.defaultSession)
  // The wiki's image server (Cloudflare) answers picture requests without a referrer with a bot
  // check instead of the picture, and a file:// page never sends one: name the wiki itself.
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['https://static.wikia.nocookie.net/*'] }, (details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders, Referer: 'https://escapefromtarkov.fandom.com/' } })
  })
  // Installed builds: no menu (it carries Reload and the developer tools).
  if (app.isPackaged) Menu.setApplicationMenu(null)
  settings = new SettingsStore(app.getPath('userData'))
  if (BENCHMARK_MODE) settings.update({ paused: true, startMinimized: true, startWithWindows: false, trackPosition: false, clearPositionShots: false, searchBar: false, scanHotkey: '', updateMode: 'off', cleanAfterUpdate: false })
  const startHidden = settings.get().startMinimized || process.argv.includes('--minimized')

  createWindow(!startHidden)
  createTray()
  registerIpc()
  registerHotkey()
  setupUpdater(broadcast, settings.get().updateMode)
  applyWatcherSettings()
  scheduleCleanupAfterUpdate()
  if (!BENCHMARK_MODE) app.setLoginItemSettings({ name: APP_IDENTITY.name, openAtLogin: settings.get().startWithWindows, args: ['--minimized'] })

  watcher.on('event', (e: GameEvent) => {
    broadcast('watcher:event', e)
    detectWipe(e)
    raidClock.onEvent(e, Date.now())
  })
  watcher.on('state', (s) => broadcast('watcher:state', s))
  applyPositionTracking()
  applySearchBar()

  app.on('before-quit', () => {
    quitting = true
    if (searchBar && !searchBar.isDestroyed()) searchBar.destroy()
    watcher.stop()
    globalShortcut.unregisterAll()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && quitting) app.quit()
  })
  app.on('activate', () => showWindow())
  // No embedded browsers and no pop-up windows, whatever a page tries.
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (ev) => ev.preventDefault())
    contents.setWindowOpenHandler(({ url }) => {
      if (isWebUrl(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
  })
}

/** "Where am I": positions from the names of new in-game screenshots (read-only), if switched on. */
function applyPositionTracking() {
  if (BENCHMARK_MODE) return
  const on = settings.get().trackPosition
  if (on && !stopScreenshots) {
    stopScreenshots = watchScreenshots((p) => {
      lastPosition = p
      broadcast('position:new', p)
      if (settings.get().clearPositionShots && raidClock.inRaid(Date.now())) void clearPositionShot(p.file)
    })
  }
  if (!on && stopScreenshots) {
    stopScreenshots()
    stopScreenshots = null
  }
}

/**
 * Moves a read position screenshot to the Recycle Bin (opt-in). Only plain screenshot names that
 * carry a position, only in the game's Screenshots folder, and only after the game has finished
 * writing the file. Nothing is deleted outright: the Recycle Bin keeps it.
 */
async function clearPositionShot(name: string) {
  if (!isScreenshotName(name) || !parseScreenshotName(name, 0)) return
  const file = path.join(gameScreenshotsDir(), name)
  try {
    await trashWhenWritten(file, {
      size: (f) => {
        try {
          return fs.statSync(f).size
        } catch {
          return null
        }
      },
      // Some setups refuse the Recycle Bin ("Failed to perform delete operation"): then the file
      // goes into a folder next to the others instead, so it is still out of the way and never lost.
      trash: (f) => shell.trashItem(f).catch(() => moveAside(f)),
      wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    })
  } catch {
    // Locked or already gone: leave it.
  }
}

/** The Recycle Bin's stand-in: a folder inside the Screenshots folder (an existing name is never overwritten). */
const READ_SHOTS_FOLDER = `Read by ${APP_IDENTITY.name}`
function moveAside(file: string) {
  const dir = path.join(path.dirname(file), READ_SHOTS_FOLDER)
  const target = path.join(dir, path.basename(file))
  fs.mkdirSync(dir, { recursive: true })
  if (!fs.existsSync(target)) fs.renameSync(file, target)
}

// ---------------------------------------------------------------------------
// Wipe detection: a new profile id, or a jump in the game's major version.
// ---------------------------------------------------------------------------

function majorVersion(v: string): string {
  const parts = v.split('.')
  return parts.slice(0, 2).join('.')
}

function detectWipe(e: GameEvent) {
  const s = settings.get()
  if (e.kind === 'profile') {
    if (s.knownProfileId && s.knownProfileId !== e.profileId) {
      const ev: WipeEvent = { reason: 'profile', previous: s.knownProfileId, current: e.profileId }
      settings.update({ knownProfileId: e.profileId })
      broadcast('wipe:detected', ev)
    } else if (!s.knownProfileId) {
      settings.update({ knownProfileId: e.profileId })
    }
  } else if (e.kind === 'gameVersion') {
    if (s.knownGameVersion && majorVersion(s.knownGameVersion) !== majorVersion(e.version)) {
      const ev: WipeEvent = { reason: 'version', previous: s.knownGameVersion, current: e.version }
      settings.update({ knownGameVersion: e.version })
      broadcast('wipe:detected', ev)
    } else if (!s.knownGameVersion || s.knownGameVersion !== e.version) {
      settings.update({ knownGameVersion: e.version })
    }
  }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

function rendererUrl(hash: string): { url?: string; file?: string } {
  if (DEV_URL) return { url: `${DEV_URL}#${hash}` }
  return { file: resourcePath('dist', 'index.html') }
}

function load(w: BrowserWindow, hash: string) {
  const target = rendererUrl(hash)
  if (target.url) void w.loadURL(target.url)
  else void w.loadFile(target.file as string, { hash })
}

/**
 * Windows only ever show the app itself: navigating to any other page (a link that slipped
 * through, a redirect) is blocked, and web links open in the user's browser instead.
 */
function lockNavigation(w: BrowserWindow) {
  w.webContents.on('will-navigate', (e, url) => {
    if (isOwnUrl(url)) return
    e.preventDefault()
    if (isWebUrl(url)) void shell.openExternal(url)
  })
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
}

/** The app's own page: exactly its index.html (any #route), or the dev server. Not any local file. */
function isOwnUrl(url: string): boolean {
  if (DEV_URL) return url.startsWith(DEV_URL)
  // Compared as real paths: a text compare refused everything when Windows used the short 8.3
  // folder name on one side (the portable app unpacked in %TEMP%, fixed in 1.14.1).
  return isSameFileUrl(url, resourcePath('dist', 'index.html'))
}

function createWindow(show: boolean) {
  const b = settings.get().window
  win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    minWidth: 900,
    minHeight: 600,
    show,
    title: APP_IDENTITY.name,
    backgroundColor: '#0c0c0b',
    icon: appIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: !app.isPackaged,
      additionalArguments: ['--tc-window=main', `--tc-version=${app.getVersion()}`, ...(BENCHMARK_MODE ? ['--tc-benchmark'] : [])],
    },
  })
  if (b.maximized) win.maximize()

  const saveBounds = () => {
    if (!win) return
    const maximized = win.isMaximized()
    const bounds = maximized ? settings.get().window : win.getBounds()
    settings.update({ window: { ...bounds, maximized } })
  }
  win.on('resize', saveBounds)
  win.on('move', saveBounds)
  win.on('close', (e) => {
    if (quitting) return
    if (settings.get().minimizeToTray) {
      e.preventDefault()
      win?.hide()
      // Tell people once where the window went, so closing never looks like a crash.
      if (!settings.get().trayNoticeShown && tray) {
        tray.displayBalloon({
          title: `${APP_IDENTITY.name} is still running`,
          content: 'It keeps tracking your quests from the tray. Right-click the tray icon to open it again or quit.',
          iconType: 'info',
        })
        settings.update({ trayNoticeShown: true })
      }
    } else {
      quitting = true
    }
  })
  lockNavigation(win)
  load(win, '/')
}

// ---------------------------------------------------------------------------
// The search bar over the game
// ---------------------------------------------------------------------------

/** The magnifying glass with its margin: the window's size when nothing is open. */
const SEARCH_GLASS = 48
const SEARCH_MARGIN = 16

/** Top-left corner of the glass on screen; the window grows right/down from it, or left/up near a screen edge. */
let searchAnchor = { x: 0, y: 0 }
let searchSize = { width: SEARCH_GLASS, height: SEARCH_GLASS }
let searchFlip = { left: false, up: false }

/** Keeps the glass on a screen (a monitor may have been unplugged since it was dragged there). */
function clampAnchor(p: { x: number; y: number }) {
  const area = screen.getDisplayNearestPoint({ x: Math.round(p.x), y: Math.round(p.y) }).workArea
  return {
    x: Math.round(Math.min(Math.max(p.x, area.x), area.x + area.width - SEARCH_GLASS)),
    y: Math.round(Math.min(Math.max(p.y, area.y), area.y + area.height - SEARCH_GLASS)),
  }
}

/** Puts the window around the glass at its current size, flipping towards the room on the screen. */
function placeSearchBar() {
  if (!searchBar || searchBar.isDestroyed()) return
  const area = screen.getDisplayNearestPoint(searchAnchor).workArea
  const w = Math.max(40, Math.min(Math.round(searchSize.width), area.width))
  const h = Math.max(40, Math.min(Math.round(searchSize.height), area.height))
  const left = searchAnchor.x + w > area.x + area.width
  const up = searchAnchor.y + h > area.y + area.height
  const x = left ? Math.max(area.x, searchAnchor.x + SEARCH_GLASS - w) : searchAnchor.x
  const y = up ? Math.max(area.y, searchAnchor.y + SEARCH_GLASS - h) : searchAnchor.y
  const b = searchBar.getBounds()
  if (b.x !== x || b.y !== y || b.width !== w || b.height !== h) searchBar.setBounds({ x, y, width: w, height: h })
  if (left !== searchFlip.left || up !== searchFlip.up) {
    searchFlip = { left, up }
    searchBar.webContents.send('searchbar:layout', searchFlip)
  }
}

/**
 * A small magnifying glass above the game (borderless or windowed), top left of the main screen
 * or wherever it was dragged. It shows only the app's own page: click it and type an item, key,
 * quest or map. It never takes focus by itself; clicking into it does, like any window. The empty
 * parts of the window let clicks through to the game. Nothing about the game is read or touched.
 */
function applySearchBar() {
  if (BENCHMARK_MODE) return
  const on = settings.get().searchBar
  if (!on) {
    if (searchBar && !searchBar.isDestroyed()) searchBar.destroy()
    searchBar = null
    return
  }
  if (searchBar && !searchBar.isDestroyed()) return
  const area = screen.getPrimaryDisplay().workArea
  searchAnchor = clampAnchor(settings.get().searchBarPos ?? { x: area.x + SEARCH_MARGIN, y: area.y + SEARCH_MARGIN })
  searchSize = { width: SEARCH_GLASS, height: SEARCH_GLASS }
  searchFlip = { left: false, up: false }
  const w = new BrowserWindow({
    x: searchAnchor.x,
    y: searchAnchor.y,
    width: SEARCH_GLASS,
    height: SEARCH_GLASS,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: `${APP_IDENTITY.name} search`,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: !app.isPackaged,
      spellcheck: false,
      additionalArguments: ['--tc-window=searchbar', `--tc-version=${app.getVersion()}`],
    },
  })
  // Above full-screen-window games.
  w.setAlwaysOnTop(true, 'screen-saver')
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  lockNavigation(w)
  w.webContents.once('did-finish-load', () => {
    w.showInactive()
    w.webContents.send('searchbar:layout', searchFlip)
  })
  load(w, '/searchbar')
  w.on('closed', () => {
    if (searchBar === w) searchBar = null
    searchLocked = false
    refreshTrayMenu()
  })
  // The tray says Show or Hide to match (hotkeys and the first load show it too).
  w.on('show', refreshTrayMenu)
  w.on('hide', refreshTrayMenu)
  searchBar = w
  refreshTrayMenu()
}

/** The window follows the search bar: the glass, the bar, a card, a map, side panels. */
function sizeSearchBar(width: number, height: number) {
  searchSize = { width, height }
  placeSearchBar()
}

/** Dragging the glass: moves it by the pointer's movement (saved when the drag ends). */
function moveSearchBar(dx: number, dy: number) {
  searchAnchor = clampAnchor({ x: searchAnchor.x + dx, y: searchAnchor.y + dy })
  placeSearchBar()
}

/** Locked = the whole bar lets every click through to the game (a map you only look at). */
let searchLocked = false

function setSearchLocked(on: boolean) {
  if (!searchBar || searchBar.isDestroyed()) return
  searchLocked = on
  searchBar.setIgnoreMouseEvents(on, on ? undefined : { forward: true })
  searchBar.webContents.send('searchbar:locked', on)
  refreshTrayMenu()
}

/** Hotkey / tray: hide the bar completely, or bring it back where it was. */
function toggleSearchBarVisible() {
  if (!searchBar || searchBar.isDestroyed()) return
  if (searchBar.isVisible()) searchBar.hide()
  else searchBar.showInactive()
  refreshTrayMenu()
}

/** Hotkey: show the bar and put the cursor in the search box (this takes focus from the game). */
function focusSearchBar() {
  if (!searchBar || searchBar.isDestroyed()) return
  if (searchLocked) setSearchLocked(false)
  if (!searchBar.isVisible()) searchBar.showInactive()
  searchBar.focus()
  searchBar.webContents.send('searchbar:focus')
}

/** Hotkey: open or close the map in the bar (the game keeps the keyboard). */
function toggleSearchMap() {
  if (!searchBar || searchBar.isDestroyed()) return
  if (!searchBar.isVisible()) searchBar.showInactive()
  searchBar.webContents.send('searchbar:map')
}

/** Snap the glass into a corner of the screen it is on. */
function cornerSearchBar(corner: 'tl' | 'tr' | 'bl' | 'br') {
  const area = screen.getDisplayNearestPoint(searchAnchor).workArea
  const right = corner === 'tr' || corner === 'br'
  const bottom = corner === 'bl' || corner === 'br'
  searchAnchor = {
    x: right ? area.x + area.width - SEARCH_MARGIN - SEARCH_GLASS : area.x + SEARCH_MARGIN,
    y: bottom ? area.y + area.height - SEARCH_MARGIN - SEARCH_GLASS : area.y + SEARCH_MARGIN,
  }
  settings.update({ searchBarPos: { ...searchAnchor } })
  placeSearchBar()
}

let lastCleanup: CleanupResult | null = null

/** Leftovers of older versions (old installers, packs, crash reports, compiled-code cache). */
async function cleanUp(dry: boolean): Promise<CleanupResult> {
  const update = getUpdateStatus().state
  // An update that is downloading or waiting to be installed keeps its installer.
  const updateWaiting = update === 'downloading' || update === 'ready' || update === 'installing' || update === 'available'
  const userData = app.getPath('userData')
  const codeCache = path.join(userData, 'Code Cache')
  const codeBytes = sizeOf(codeCache)
  const result = await cleanLeftovers({
    currentVersion: app.getVersion(),
    updaterCacheDir: !app.isPackaged || updateWaiting || !process.env.LOCALAPPDATA ? null : forkUpdaterCachePath(process.env.LOCALAPPDATA),
    packs: packsEnabled() ? { root: path.join(userData, 'packs'), keep: currentPackDirNames() } : null,
    crashReportsDir: path.join(userData, 'Crashpad', 'reports'),
    downloadsDir: app.isPackaged ? app.getPath('downloads') : null,
    runningExe: process.env.PORTABLE_EXECUTABLE_FILE ?? null,
    trash: (f) => shell.trashItem(f),
    dry,
  })
  if (codeBytes > 0) {
    if (!dry) await session.defaultSession.clearCodeCaches({})
    result.items.push({ label: 'Compiled code from older versions (rebuilt when needed)', bytes: codeBytes })
    result.bytes += codeBytes
  }
  return result
}

/** Once per new version, a minute after start (the update has finished by then). */
function scheduleCleanupAfterUpdate() {
  const s = settings.get()
  if (!APP_IDENTITY.automaticCleanupEnabled || !s.cleanAfterUpdate || !app.isPackaged || s.lastCleanedVersion === app.getVersion()) return
  setTimeout(() => {
    void cleanUp(false)
      .then((r) => {
        lastCleanup = r
        settings.update({ lastCleanedVersion: app.getVersion() })
      })
      .catch(() => undefined)
  }, 60_000)
}

function showWindow() {
  if (!win) return
  if (!win.isVisible()) win.show()
  if (win.isMinimized()) win.restore()
  win.focus()
}

function registerHotkey() {
  globalShortcut.unregisterAll()
  if (BENCHMARK_MODE) return
  const tryRegister = (key: string, fn: () => void) => {
    if (!key) return
    try {
      globalShortcut.register(key, fn)
    } catch {
      // Invalid accelerator: ignore; the Settings screen shows the current value.
    }
  }
  const s = settings.get()
  tryRegister(s.scanHotkey, () => void captureForScan())
  // The search bar's hotkeys only exist while the bar is switched on (they would block those keys elsewhere).
  if (s.searchBar) {
    tryRegister(s.searchBarHotkey, toggleSearchBarVisible)
    tryRegister(s.searchBarSearchHotkey, focusSearchBar)
    tryRegister(s.searchBarLockHotkey, () => setSearchLocked(!searchLocked))
    tryRegister(s.searchBarMapHotkey, toggleSearchMap)
  }
}

/** Scan hotkey: capture the game screen first, then bring the app up with the scan. */
async function captureForScan() {
  try {
    const png = await captureScreenUnderCursor()
    showWindow()
    win?.webContents.send('scan:captured', png)
  } catch {
    // Capture failed (no screen permission or display): nothing to show.
  }
}

// ---------------------------------------------------------------------------
// Tray + settings + IPC
// ---------------------------------------------------------------------------

function createTray() {
  const img = nativeImage.createFromPath(resourcePath('build', 'tray.png'))
  tray = new Tray(img.isEmpty() ? appIcon().resize({ width: 16, height: 16 }) : img)
  tray.setToolTip(APP_IDENTITY.name)
  tray.on('double-click', showWindow)
  refreshTrayMenu()
}

function refreshTrayMenu() {
  if (!tray) return
  const paused = settings.get().paused
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Open ${APP_IDENTITY.name}`, click: showWindow },
      { label: paused ? 'Resume log watching' : 'Pause log watching', click: () => updateSettings({ paused: !settings.get().paused }) },
      ...(searchBar && !searchBar.isDestroyed()
        ? ([
            { type: 'separator' },
            { label: searchBar.isVisible() ? 'Hide the search bar' : 'Show the search bar', click: toggleSearchBarVisible },
            { label: searchLocked ? 'Unlock the search bar' : 'Lock the search bar (clicks go through)', click: () => setSearchLocked(!searchLocked) },
            { label: 'Put the search bar back top left', click: () => cornerSearchBar('tl') },
          ] as Electron.MenuItemConstructorOptions[])
        : []),
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true
          app.quit()
        },
      },
    ]),
  )
}

function applyWatcherSettings() {
  if (BENCHMARK_MODE) {
    watcher.configure({ logsPath: null, detectedPath: null, paused: true })
    refreshTrayMenu()
    return
  }
  const s = settings.get()
  const detected = detectLogsFolder()
  // A saved folder that is gone (or was never a folder) falls back to the detected one.
  const custom = s.logsPath && isSafeDirectory(s.logsPath) ? s.logsPath : null
  watcher.configure({ logsPath: custom ?? detected.path, detectedPath: detected.path, paused: s.paused })
  refreshTrayMenu()
}

function updateSettings(patch: Partial<DesktopSettings>): DesktopSettings {
  const before = settings.get()
  settings.update(patch)
  const after = settings.get()
  if (patch.startWithWindows !== undefined && patch.startWithWindows !== before.startWithWindows) {
    app.setLoginItemSettings({ name: APP_IDENTITY.name, openAtLogin: after.startWithWindows, args: ['--minimized'] })
  }
  if (patch.logsPath !== undefined || patch.paused !== undefined) applyWatcherSettings()
  if (patch.scanHotkey !== undefined) registerHotkey()
  if (patch.searchBar !== undefined) applySearchBar()
  if (patch.searchBar !== undefined || patch.searchBarHotkey !== undefined || patch.searchBarSearchHotkey !== undefined || patch.searchBarLockHotkey !== undefined || patch.searchBarMapHotkey !== undefined) registerHotkey()
  if (patch.updateMode !== undefined) setUpdateMode(after.updateMode)
  if (patch.trackPosition !== undefined) applyPositionTracking()
  broadcast('watcher:state', watcher.getState())
  broadcast('settings:changed', settings.getPublic())
  return settings.getPublic()
}

function registerIpc() {
  // Every request must come from the app's own page; anything else is refused.
  const handle = (channel: string, fn: (e: IpcMainInvokeEvent, ...args: any[]) => unknown) =>
    ipcMain.handle(channel, (e, ...args) => {
      if (!isTrustedSender(e.sender, isOwnUrl)) throw new Error('Refused')
      return fn(e, ...args)
    })
  handle('ui:ready', () => {
    const readyFile = process.env.TC_BENCH_READY_FILE
    if (!BENCHMARK_MODE || !readyFile || !path.isAbsolute(readyFile)) return
    const relative = path.relative(path.dirname(app.getPath('userData')), readyFile)
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Benchmark output must be inside its isolated measurement directory')
    if (!fs.existsSync(readyFile)) fs.writeFileSync(readyFile, JSON.stringify({ milestone: 'react-layout-mounted', at: Date.now() }), { flag: 'wx' })
  })
  handle('benchmark:catalog-ready', (event, summary: unknown) => {
    if (!BENCHMARK_MODE || !win || event.sender !== win.webContents) return
    if (!validBenchmarkCatalog(summary)) throw new Error('Invalid benchmark catalog summary')
    const readyFile = process.env.TC_BENCH_READY_FILE
    if (!readyFile || !path.isAbsolute(readyFile)) throw new Error('Missing benchmark output')
    const root = fs.realpathSync(path.dirname(app.getPath('userData')))
    if (fs.realpathSync(path.dirname(readyFile)) !== root) throw new Error('Invalid benchmark output directory')
    const output = path.join(root, 'catalog-ready.json')
    if (!fs.existsSync(output)) {
      const pending = path.join(root, 'catalog-ready.pending')
      fs.writeFileSync(pending, JSON.stringify({ milestone: 'catalog-queries-success-idle', at: Date.now(), ...summary }), { flag: 'wx' })
      fs.renameSync(pending, output)
    }
  })
  handle('searchbar:size', (e, width: unknown, height: unknown) => {
    // Only the search bar itself says how big it is.
    if (!searchBar || searchBar.isDestroyed() || e.sender !== searchBar.webContents) return
    if (typeof width !== 'number' || typeof height !== 'number' || !Number.isFinite(width) || !Number.isFinite(height)) return
    sizeSearchBar(width, height)
  })
  const fromSearchBar = (e: IpcMainInvokeEvent) => Boolean(searchBar && !searchBar.isDestroyed() && e.sender === searchBar.webContents)
  const isDelta = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 10000
  handle('searchbar:move', (e, dx: unknown, dy: unknown) => {
    if (fromSearchBar(e) && isDelta(dx) && isDelta(dy)) moveSearchBar(dx, dy)
  })
  handle('searchbar:moved', (e) => {
    if (fromSearchBar(e)) settings.update({ searchBarPos: { ...searchAnchor } })
  })
  handle('searchbar:home', (e) => {
    if (!fromSearchBar(e)) return
    const area = screen.getPrimaryDisplay().workArea
    searchAnchor = { x: area.x + SEARCH_MARGIN, y: area.y + SEARCH_MARGIN }
    settings.update({ searchBarPos: null })
    placeSearchBar()
  })
  handle('searchbar:passthrough', (e, on: unknown) => {
    // Clicks on the see-through parts go to the game; mouse moves still arrive so the bar knows when to take them back.
    if (fromSearchBar(e) && typeof on === 'boolean' && !searchLocked) searchBar!.setIgnoreMouseEvents(on, { forward: true })
  })
  handle('searchbar:lock', (e, on: unknown) => {
    if (fromSearchBar(e) && typeof on === 'boolean') setSearchLocked(on)
  })
  handle('searchbar:locked', (e) => fromSearchBar(e) && searchLocked)
  handle('searchbar:hide', (e) => {
    if (fromSearchBar(e)) toggleSearchBarVisible()
  })
  handle('searchbar:release', (e) => {
    // Esc in the bar: hand the keyboard back to the game.
    if (fromSearchBar(e)) searchBar!.blur()
  })
  handle('searchbar:corner', (e, corner: unknown) => {
    if (fromSearchBar(e) && (corner === 'tl' || corner === 'tr' || corner === 'bl' || corner === 'br')) cornerSearchBar(corner)
  })
  handle('searchbar:open', (e, to: unknown) => {
    // "Open in the app" from a search result: only the app's own tab pages.
    if (!searchBar || e.sender !== searchBar.webContents || !isAppPath(to)) return
    showWindow()
    win?.webContents.send('app:open', to)
  })
  handle('watcher:getState', () => watcher.getState())
  handle('pack:ensure', async (_e, name: unknown) => {
    if (!PACK_NAMES.includes(name as PackName)) throw new Error('Unknown pack')
    await ensurePack(name as PackName, (p) => broadcast('pack:progress', p))
  })
  handle('settings:get', () => settings.getPublic())
  handle('settings:set', (_e, patch: unknown) => updateSettings(cleanSettingsPatch(patch)))
  handle('watcher:recent', () => watcher.getRecentEvents())
  handle('watcher:pickFolder', async () => {
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      title: 'Select the Escape from Tarkov Logs folder',
      properties: ['openDirectory'],
      defaultPath: watcher.getState().logsPath ?? undefined,
    })
    if (res.canceled || res.filePaths.length === 0) return null
    const picked = res.filePaths[0]
    updateSettings({ logsPath: picked })
    return picked
  })
  handle('watcher:backfill', async () => {
    const result = await watcher.backfillAsync((p) => broadcast('watcher:backfillProgress', p))
    settings.update({ initialBackfillDone: true })
    const summary = {
      at: new Date().toISOString(),
      logsPath: watcher.getState().logsPath,
      folders: result.folders,
      files: result.files,
      events: result.events.length,
      finishedTasks: {
        pvp: result.finishedByMode.regular.length,
        pve: result.finishedByMode.pve.length,
        seasonal: result.finishedByMode.seasonal.length,
        unknownMode: result.finishedByMode.unknown.length,
      },
    }
    console.log('[backfill]', JSON.stringify(summary))
    try {
      fs.writeFileSync(path.join(app.getPath('userData'), 'last-backfill.json'), JSON.stringify(summary, null, 2))
    } catch {
      // not fatal
    }
    return result
  })
  // Stats tab: the same read-only pass over all log folders, without touching settings.
  handle('stats:read', async (): Promise<LogStatsData> => {
    const result = await watcher.backfillAsync()
    const keep = new Set(['mapLoading', 'raidMatched', 'raidStarted', 'raidEnded', 'matchingAborted', 'fleaSold', 'fleaExpired', 'fleaRating', 'taskFinished', 'taskStarted', 'taskFailed'])
    const sessions = result.sessions ?? []
    return {
      events: result.events.filter((e) => keep.has(e.kind)),
      sessions,
      accountId: watcher.getState().accountId ?? null,
      from: sessions.length ? Math.min(...sessions.map((s) => s.start)) : null,
      to: sessions.length ? Math.max(...sessions.map((s) => s.end)) : null,
      resetAtByMode: result.resetAtByMode ?? { regular: null, pve: null, seasonal: null, unknown: null },
    }
  })
  handle('watcher:openFolder', async () => {
    // openPath runs files: only ever open a real folder.
    const p = watcher.getState().logsPath
    if (isSafeDirectory(p)) await shell.openPath(p)
  })
  handle('update:status', () => getUpdateStatus())
  handle('update:check', () => checkForUpdates())
  handle('update:install', () => installUpdate())
  handle('update:outcome', () => getUpdateOutcome())
  handle('position:latest', () => latestPosition() ?? (lastPosition && Date.now() - lastPosition.at <= 30 * 60_000 ? lastPosition : null))
  handle('backup:write', (_e, json: unknown) => {
    if (typeof json !== 'string') throw new Error('Not a backup')
    return writeBackup(app.getPath('userData'), json, new Date(), settings.get().backupKeep)
  })
  handle('backup:list', () => listBackups(app.getPath('userData')))
  handle('backup:read', (_e, name: unknown) => readBackup(app.getPath('userData'), String(name)))
  handle('cleanup:run', (_e, dry: unknown) => cleanUp(dry !== false))
  handle('cleanup:last', () => lastCleanup)
  handle('backup:openFolder', async () => {
    const dir = backupDir(app.getPath('userData'))
    fs.mkdirSync(dir, { recursive: true })
    await shell.openPath(dir)
  })
  handle('update:runInstaller', (_e, version: unknown) => {
    if (typeof version === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) runInstallerManually(version)
  })
  handle('resource:read', (_e, rel: unknown) => {
    if (typeof rel !== 'string' || rel.length > 300) throw new Error('Not allowed')
    return readAppResource(rel, Boolean(DEV_URL))
  })
  handle('scan:capture', () => captureScreenUnderCursor())
  handle('scan:listShots', () => listGameScreenshots())
  handle('scan:readShot', (_e, name: unknown) => readGameScreenshot(String(name)))
  handle('shell:openExternal', async (_e, url: unknown) => {
    if (isWebUrl(url)) await shell.openExternal(url)
  })
}
