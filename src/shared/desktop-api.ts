/**
 * Types shared between the Electron main process, the preload bridge and the
 * React renderer. Keep this file free of runtime imports.
 */

/** EFT "Session mode" as the log reports it, normalised. */
export type SessionMode = 'regular' | 'pve' | 'seasonal' | 'unknown'

export type GameEventKind =
  | 'sessionMode'
  | 'profile'
  | 'gameVersion'
  | 'taskStarted'
  | 'taskFinished'
  | 'taskFailed'
  | 'mapLoading'
  | 'raidMatched'
  | 'raidStarting'
  | 'raidStarted'
  | 'raidEnded'
  | 'matchingAborted'
  | 'fleaSold'
  | 'fleaExpired'
  | 'fleaRating'

export interface GameEventBase {
  id: string
  /** Event time in ms since epoch (from the log timestamp). */
  at: number
  /** Session mode in effect when the event happened. */
  mode: SessionMode
  /** True when read from an old log during start-up or a backfill (no live reactions). */
  historical: boolean
  /** Which file and line produced it, for troubleshooting. */
  source: { file: string; line: number }
}

export type GameEvent = GameEventBase &
  (
    | { kind: 'sessionMode'; raw: string }
    | { kind: 'profile'; profileId: string; accountId: string }
    | { kind: 'gameVersion'; version: string }
    | {
        kind: 'taskStarted' | 'taskFinished' | 'taskFailed'
        taskId: string
        /** Game profile that was selected when the message arrived (PvP and PvE profiles differ). */
        profileId: string | null
        /** Trader who sent the message. */
        traderId: string | null
      }
    | { kind: 'mapLoading'; scenePath: string }
    | { kind: 'raidMatched'; location: string; raidId: string; online: boolean; gameMode: string }
    | { kind: 'raidStarting' }
    | { kind: 'raidStarted' }
    | { kind: 'raidEnded'; location: string; raidId: string }
    | { kind: 'matchingAborted' }
    | { kind: 'fleaSold'; itemId: string; count: number; buyer: string; income: number; currency: 'RUB' | 'USD' | 'EUR' | null }
    | { kind: 'fleaRating'; rating: number; growing: boolean }
    | { kind: 'fleaExpired'; itemId: string; count: number }
  )

export type WatcherStatus = 'watching' | 'paused' | 'no-folder' | 'error'

export interface WatcherState {
  status: WatcherStatus
  /** Folder being watched (custom or auto-detected). */
  logsPath: string | null
  /** Auto-detected folder, even when a custom one is in use. */
  detectedPath: string | null
  /** Session log folder currently tailed. */
  currentFolder: string | null
  lastEventAt: number | null
  /** Current session mode / profile as last seen in the logs. */
  sessionMode: SessionMode
  profileId: string | null
  /** Numeric BSG account id from the logs (what tarkov.dev's player pages key on). */
  accountId: string | null
  message?: string
}

export interface DesktopSettings {
  /** Custom logs folder; null = auto-detect. */
  logsPath: string | null
  startWithWindows: boolean
  startMinimized: boolean
  minimizeToTray: boolean
  openMapOnRaid: boolean
  /** Set after the first automatic backfill so it only runs once. */
  initialBackfillDone: boolean
  paused: boolean
  /** Electron accelerator that captures the screen and opens the stash scanner. */
  scanHotkey: string
  /** A small search bar over the game, top left of the main screen. */
  searchBar: boolean
  /** Search bar hotkeys: show/hide it, open the search box (takes focus), lock it so clicks go through. '' = off. */
  searchBarHotkey: string
  searchBarSearchHotkey: string
  searchBarLockHotkey: string
  /** Opens (or closes) the raid's map in the bar without taking the keyboard from the game. */
  searchBarMapHotkey: string
  /** Last profile id / game version seen in the logs, for wipe detection. */
  knownProfileId: string | null
  knownGameVersion: string | null
  /** First-run setup screen completed (logs folder, mode, faction). */
  setupDone: boolean
  /** auto = download updates in the background; notify = only show that one exists; off = no automatic checks. */
  updateMode: UpdateMode
  /** "Where am I": read positions from the names of new in-game screenshots. */
  trackPosition: boolean
  /** Move those screenshots to the Recycle Bin once read (raid screenshots only; off by default). */
  clearPositionShots: boolean
  /** Daily progress backups kept in userData\backups. */
  backupKeep: number
  /** After an update, remove what older versions left behind (old installers, packs, crash reports). */
  cleanAfterUpdate: boolean
}

/** What "Clean up" removed (or, for a dry run, would remove). */
export interface CleanupResult {
  items: { label: string; bytes: number }[]
  bytes: number
  dry: boolean
  at: number
}

export type UpdateMode = 'auto' | 'notify' | 'off'

export type UpdateStatus =
  | { state: 'idle' | 'checking' }
  | { state: 'disabled'; message: string }
  | { state: 'none'; checkedAt: number }
  | { state: 'downloading'; version?: string; percent: number }
  | { state: 'ready'; version: string }
  /** "Restart to update" clicked: the app is about to close and the installer to run. */
  | { state: 'installing'; version: string }
  /** A newer release exists and was not downloaded: portable exe (download by hand) or Settings → Updates "Only tell me" (installable: true). */
  | { state: 'available'; version: string; url: string; installable?: boolean }
  | { state: 'error'; message: string }

/** What became of the last "Restart to update" (checked once at the next launch). */
export interface UpdateOutcome {
  ok: boolean
  /** Version that was being installed. */
  version: string
}

export interface WipeEvent {
  reason: 'profile' | 'version'
  previous: string | null
  current: string
}

export interface BackfillProgress {
  done: number
  total: number
  folder: string
}

/** One game launch (one log folder): first and last log time. */
export interface PlaySession {
  start: number
  end: number
}

/** Everything the Stats tab needs, read from all log folders (read-only). */
export interface LogStatsData {
  events: GameEvent[]
  sessions: PlaySession[]
  accountId: string | null
  /** Oldest and newest log folder times. */
  from: number | null
  to: number | null
  /** Start of the current wipe/profile reset per mode; earlier events belong to the old profile. */
  resetAtByMode: Record<SessionMode, number | null>
}

/** One automatic progress backup (userData\backups). */
export interface BackupInfo {
  name: string
  at: number
  size: number
}

/** Player position from an in-game screenshot's file name (game coordinates, y = height). */
export interface PlayerPosition {
  x: number
  y: number
  z: number
  /** Heading in degrees around the vertical axis, 0 = facing +z. */
  yaw: number
  /** When the screenshot was taken (ms). */
  at: number
  file: string
}

export interface BackfillResult {
  /** First/last log line time per log folder (game launch). */
  sessions?: PlaySession[]
  /** Start of the current wipe/profile reset per mode (detected from quests restarting), or null. */
  resetAtByMode?: Record<SessionMode, number | null>
  folders: number
  files: number
  events: GameEvent[]
  /** Distinct finished task ids per mode, current profile only. */
  finishedByMode: Record<SessionMode, string[]>
  /** The profile treated as "you" per mode (the most recently selected one). */
  currentProfileByMode: Record<SessionMode, string | null>
  /** Completions ignored because they belong to another profile (older wipe, second account). */
  skippedOtherProfile: number
}

/** Content packs downloaded on first use (scripts/build-packs.mjs). */
export type PackName = 'lighthouse' | 'scan'
export interface PackProgress {
  name: PackName
  label: string
  received: number
  total: number
  state: 'downloading' | 'installing' | 'done'
}

export interface DesktopApi {
  /** Optional instrumentation: marks React layout mounted in an isolated benchmark run. */
  reportUiReady?: () => Promise<void>
  benchmarkMode?: boolean
  reportCatalogReady?: (summary: import('./benchmark').BenchmarkCatalogReady) => Promise<void>
  onScanCaptureError?: (cb: (message: string) => void) => () => void
  platform: string
  appVersion: string
  /** 'main' for the app window, 'searchbar' for the search bar over the game. */
  windowKind: 'main' | 'searchbar'
  /** Search bar only: its size once drawn (the window follows it). */
  setSearchBarSize: (width: number, height: number) => Promise<void>
  setSearchBarRegions?: (regions: { x: number; y: number; width: number; height: number }[]) => Promise<void>
  searchBarReady?: () => Promise<void>
  onSearchBarGeometry?: (cb: () => void) => () => void
  onSearchBarError?: (cb: (message: string) => void) => () => void
  reportSearchBarError?: (message: string) => Promise<void>
  /** Search bar only: drag the glass by this many pixels; `searchBarMoved` saves where it ended. */
  moveSearchBar: (dx: number, dy: number) => Promise<void>
  searchBarMoved: () => Promise<void>
  /** Search bar only: back to the top left of the main screen. */
  searchBarHome: () => Promise<void>
  /** Search bar only: true = clicks go through the window to the game (the see-through parts). */
  setSearchBarPassthrough: (on: boolean) => Promise<void>
  /** Search bar only: lock (every click goes through to the game) or unlock; hide; hand the keyboard back. */
  setSearchBarLocked: (on: boolean) => Promise<void>
  isSearchBarLocked: () => Promise<boolean>
  onSearchBarLocked: (cb: (on: boolean) => void) => () => void
  hideSearchBar: () => Promise<void>
  releaseSearchBar: () => Promise<void>
  /** Search bar only: the map hotkey was pressed. */
  onSearchBarMap: (cb: () => void) => () => void
  /** Search bar only: the search hotkey was pressed (open the box and type). */
  onSearchBarFocus: (cb: () => void) => () => void
  /** Search bar only: snap the glass into a screen corner. */
  searchBarCorner: (corner: 'tl' | 'tr' | 'bl' | 'br') => Promise<void>
  /** Search bar only: which way the window grows from the glass (it flips near a screen edge). */
  onSearchBarLayout: (cb: (flip: { left: boolean; up: boolean }) => void) => () => void
  /** Search bar only: show the app window on this page. */
  openInApp: (to: string) => Promise<void>
  /** Makes sure a content pack is downloaded and installed (no-op in development). */
  ensurePack: (name: PackName) => Promise<void>
  onPackProgress: (cb: (p: PackProgress) => void) => () => void
  onWipeDetected: (cb: (e: WipeEvent) => void) => () => void
  onSettingsChanged: (cb: (s: DesktopSettings) => void) => () => void
  getState: () => Promise<WatcherState>
  getSettings: () => Promise<DesktopSettings>
  setSettings: (patch: Partial<DesktopSettings>) => Promise<DesktopSettings>
  pickLogsFolder: () => Promise<string | null>
  readPastLogs: () => Promise<BackfillResult>
  /** Raids, flea sales and quest hand-ins from all log folders, for the Stats tab. */
  readLogStats: () => Promise<LogStatsData>
  /** Newest in-game screenshot position from the last 30 minutes, if any. */
  getLatestPosition: () => Promise<PlayerPosition | null>
  /** Daily progress backups in the app's data folder. */
  writeBackup: (json: string) => Promise<BackupInfo>
  listBackups: () => Promise<BackupInfo[]>
  readBackup: (name: string) => Promise<string>
  openBackupsFolder: () => Promise<void>
  /** Removes leftovers of older app versions; dry = only report what would go. */
  cleanUp: (dry: boolean) => Promise<CleanupResult>
  /** The automatic clean-up after the last update, if one ran since the app started. */
  lastCleanup: () => Promise<CleanupResult | null>
  /** A new in-game screenshot was taken: the position from its file name. */
  onPosition: (cb: (p: PlayerPosition) => void) => () => void
  onPositionError?: (cb: (message: string) => void) => () => void
  getRecentEvents: () => Promise<GameEvent[]>
  openLogsFolder: () => Promise<void>
  openExternal: (url: string) => Promise<void>
  /** Reads a bundled scanner data file (desktop: file:// cannot be fetched). */
  readAppResource: (rel: string) => Promise<ArrayBuffer>
  /** Native data-only URL resolver; append map tile template components afterwards. */
  appResourceUrl?: (rel: string) => string
  /** Captures the screen under the mouse (PNG bytes). */
  captureScreen: () => Promise<Uint8Array>
  /** Newest screenshots from Documents\Escape from Tarkov\Screenshots. */
  listGameScreenshots: () => Promise<{ name: string; modified: number }[]>
  readGameScreenshot: (name: string) => Promise<Uint8Array>
  /** Scan hotkey pressed: a fresh capture to scan. */
  onScanCapture: (cb: (png: Uint8Array) => void) => () => void
  /** Main window: the search bar asked to open a page ("/flea?…", "/quests?q=…"). */
  onOpenInApp: (cb: (to: string) => void) => () => void
  getUpdateStatus: () => Promise<UpdateStatus>
  checkForUpdates: () => Promise<UpdateStatus>
  installUpdate: () => Promise<void>
  getUpdateOutcome: () => Promise<UpdateOutcome | null>
  /** Opens the downloaded installer normally (fallback when the silent install failed). */
  runInstaller: (version: string) => Promise<void>
  onUpdateStatus: (cb: (s: UpdateStatus) => void) => () => void
  onEvent: (cb: (event: GameEvent) => void) => () => void
  onState: (cb: (state: WatcherState) => void) => () => void
  onBackfillProgress: (cb: (p: BackfillProgress) => void) => () => void
}

declare global {
  interface Window {
    desktop?: DesktopApi
  }
}
