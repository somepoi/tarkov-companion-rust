/**
 * Auto-update via GitHub Releases (electron-updater).
 *
 * The builds are not code-signed, so electron-updater's signature check is
 * off (`win.verifyUpdateCodeSignature: false` in package.json; it would be
 * skipped anyway because there is no publisherName). Trade-off: the only
 * protection is HTTPS to github.com and the GitHub account that owns the
 * repository. Anyone who can publish a release there can push an update to
 * every user. Keep the account on 2FA and do not add collaborators lightly.
 *
 * Updates download silently in the background; nothing is installed until
 * the user clicks "Restart to update" (or quits the app, when the pending
 * installer runs on exit).
 *
 * The installer runs silently and takes about a minute with nothing on screen
 * (the visible NSIS installer would ask "just me / all users" on every update).
 * Opening the app during that minute makes the installer fail on locked files,
 * which looked like "it only restarted". So the app says what is happening
 * before it closes (bar + Windows notification), writes update-attempt.json,
 * and at the next launch reports whether the version actually changed.
 */
import { Notification, app, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { autoUpdater } from 'electron-updater'
import type { UpdateMode, UpdateOutcome, UpdateStatus } from '../src/shared/desktop-api'
import { APP_IDENTITY, RELEASES_URL, forkUpdaterCachePath, installerFileName } from './appIdentity'

const SIX_HOURS = 6 * 60 * 60 * 1000
/** electron-builder sets this when the app runs as the single-file portable exe. */
const IS_PORTABLE = Boolean(process.env.PORTABLE_EXECUTABLE_FILE)

type Broadcast = (channel: string, payload: unknown) => void

let status: UpdateStatus = { state: 'idle' }
let broadcastFn: Broadcast = () => undefined
let timer: ReturnType<typeof setInterval> | null = null
let updater: typeof autoUpdater | null = null
let outcome: UpdateOutcome | null = null
/** Settings → Updates: auto = download in the background; notify = only say a new version exists; off = no automatic checks. */
let mode: UpdateMode = 'auto'

/** Applies the Settings choice (also at start-up). Manual "Check for updates" always works. */
export function setUpdateMode(next: UpdateMode) {
  mode = next
  if (!updater) return
  updater.autoDownload = !IS_PORTABLE && mode === 'auto'
  updater.autoInstallOnAppQuit = !IS_PORTABLE && mode === 'auto'
}

// A plain text log of every update step (userData/updater.log, last ~200 KB), so a failed
// install leaves a trail. Nothing personal goes in: versions, file names, errors.
const logFile = () => path.join(app.getPath('userData'), 'updater.log')
function logLine(level: string, msg: unknown) {
  try {
    const file = logFile()
    if (fs.existsSync(file) && fs.statSync(file).size > 200_000) fs.renameSync(file, `${file}.old`)
    const text = msg instanceof Error ? `${msg.message}\n${msg.stack ?? ''}` : String(msg)
    fs.appendFileSync(file, `${new Date().toISOString()} [${level}] ${text}\n`)
  } catch {
    // logging must never break updating
  }
}
const fileLogger = {
  info: (m: unknown) => logLine('info', m),
  warn: (m: unknown) => logLine('warn', m),
  error: (m: unknown) => logLine('error', m),
  debug: (m: unknown) => logLine('debug', m),
}

/** The installer electron-updater downloaded for this version (its cache folder, see app-update.yml). */
function downloadedInstaller(version: string): string | null {
  if (!process.env.LOCALAPPDATA) return null
  const file = path.join(forkUpdaterCachePath(process.env.LOCALAPPDATA), 'pending', installerFileName(version))
  return fs.existsSync(file) ? file : null
}

const attemptFile = () => path.join(app.getPath('userData'), 'update-attempt.json')

/** -1, 0 or 1 for dotted version numbers. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return Math.sign(d)
  }
  return 0
}

/** Reads (once) and clears the note left by the last "Restart to update". */
function readAttempt() {
  try {
    const raw = JSON.parse(fs.readFileSync(attemptFile(), 'utf8')) as { version?: unknown; at?: unknown }
    fs.rmSync(attemptFile(), { force: true })
    if (typeof raw.version !== 'string' || typeof raw.at !== 'number' || Date.now() - raw.at > 24 * 60 * 60 * 1000) return
    outcome = { ok: compareVersions(app.getVersion(), raw.version) >= 0, version: raw.version }
    logLine(outcome.ok ? 'info' : 'warn', `Started ${app.getVersion()} after trying to install ${raw.version}: ${outcome.ok ? 'updated' : 'NOT updated'}`)
  } catch {
    // no attempt pending
  }
}

export function getUpdateOutcome(): UpdateOutcome | null {
  return outcome
}

/** First line only: electron-updater errors include whole HTTP header dumps. */
function shortError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? 'Update check failed')
  return msg.split('\n')[0].trim().slice(0, 160) || 'Update check failed'
}

function setStatus(next: UpdateStatus) {
  status = next
  broadcastFn('update:status', status)
}

export function getUpdateStatus(): UpdateStatus {
  return status
}

/** Wires electron-updater; a no-op in development (unpackaged) builds. */
export function setupUpdater(broadcast: Broadcast, initialMode: UpdateMode = 'auto') {
  broadcastFn = broadcast
  mode = initialMode
  if (!APP_IDENTITY.updatesEnabled) {
    setStatus({ state: 'disabled', message: 'Fork updates are disabled until the release channel is verified. Install releases manually.' })
    return
  }
  if (!app.isPackaged) {
    setStatus({ state: 'disabled', message: 'Updates only work in the installed app.' })
    return
  }
  readAttempt()
  updater = autoUpdater
  // The portable exe cannot replace itself: only check, then offer the download page.
  setUpdateMode(mode)
  autoUpdater.allowPrerelease = false
  autoUpdater.logger = fileLogger
  logLine('info', `App ${app.getVersion()} started (${IS_PORTABLE ? 'portable' : 'installed'})`)
  app.on('before-quit', () => logLine('info', 'before-quit'))
  app.on('quit', (_e, code) => logLine('info', `quit, exit code ${code}`))

  autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking' }))
  autoUpdater.on('update-available', (info) =>
    setStatus(IS_PORTABLE || !autoUpdater.autoDownload ? { state: 'available', version: info.version, url: RELEASES_URL, installable: !IS_PORTABLE } : { state: 'downloading', version: info.version, percent: 0 }),
  )
  autoUpdater.on('download-progress', (p) => setStatus({ state: 'downloading', version: status.state === 'downloading' ? status.version : undefined, percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) => setStatus({ state: 'ready', version: info.version }))
  autoUpdater.on('update-not-available', () => setStatus({ state: 'none', checkedAt: Date.now() }))
  autoUpdater.on('error', (err) => setStatus({ state: 'error', message: shortError(err) }))

  // On launch (after a short delay so the window appears first) and every 6 hours.
  setTimeout(() => mode !== 'off' && void checkForUpdates(), 10_000)
  timer = setInterval(() => mode !== 'off' && void checkForUpdates(), SIX_HOURS)
  app.on('before-quit', () => {
    if (timer) clearInterval(timer)
  })
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  if (!APP_IDENTITY.updatesEnabled) return status
  if (!updater) return status
  if (status.state === 'ready' || status.state === 'downloading' || status.state === 'available' || status.state === 'installing') return status
  try {
    await updater.checkForUpdates()
  } catch (err) {
    setStatus({ state: 'error', message: shortError(err) })
  }
  return status
}

/** Installed app: quits and runs the downloaded installer silently, then restarts. Portable: opens the download page. */
export function installUpdate(): void {
  if (!APP_IDENTITY.updatesEnabled) return
  if (status.state === 'available') {
    // Installed app with "only tell me": download now, then "Restart to update" as usual.
    if (!IS_PORTABLE && updater) {
      const version = status.version
      setStatus({ state: 'downloading', version, percent: 0 })
      updater.downloadUpdate().catch((err: unknown) => setStatus({ state: 'error', message: shortError(err) }))
      return
    }
    void shell.openExternal(status.url)
    return
  }
  if (!updater || status.state !== 'ready') return
  const version = status.version
  try {
    fs.writeFileSync(attemptFile(), JSON.stringify({ version, at: Date.now() }))
  } catch {
    // only used for the "updated" note at the next launch
  }
  setStatus({ state: 'installing', version })
  logLine('info', `Restart to update clicked for ${version}`)
  if (Notification.isSupported()) {
    new Notification({
      title: `Updating ${APP_IDENTITY.name} to ${version}`,
      body: "It closes now and opens again by itself in about a minute. Please don't open it in the meantime.",
    }).show()
  }
  // A moment to read the bar before the window closes.
  setTimeout(() => updater?.quitAndInstall(true, true), 2500)
}

/**
 * Fallback when the silent install did not take: opens the downloaded installer normally
 * (the visible setup, which closes the app itself), or the releases page if it is gone.
 */
export function runInstallerManually(version: string): void {
  if (!APP_IDENTITY.updatesEnabled) return
  const file = downloadedInstaller(version)
  logLine('info', `Run the installer by hand for ${version}: ${file ?? 'not downloaded, opening releases page'}`)
  if (!file) {
    void shell.openExternal(RELEASES_URL)
    return
  }
  void shell.openPath(file).then((err) => {
    if (err) {
      logLine('error', `Could not open installer: ${err}`)
      void shell.openExternal(RELEASES_URL)
    }
  })
}
