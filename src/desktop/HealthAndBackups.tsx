import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { isTauri } from '@tauri-apps/api/core'
import { AlertTriangle, CheckCircle2, FolderOpen, HardDriveDownload, Info, RotateCcw, Stethoscope } from 'lucide-react'
import { useGameData } from '../api/hooks'
import { formatDateTime, formatTimeAgo } from '../lib/format'
import { buildProgressFile, importProgressFile, parseImportJson } from '../lib/progressFile'
import type { BackupInfo } from '../shared/desktop-api'
import { useProgressStore } from '../store/progress'
import { useNow } from '../story/storyUtils'
import { useDesktopStore } from './useDesktop'

const SIX_HOURS = 6 * 3_600_000
const localDay = (timestamp: number) => new Date(timestamp).toDateString()

/** Desktop, in the layout: writes today's backup once a day (checked at start and every 6 hours). */
export function AutoBackup() {
  useEffect(() => {
    const api = window.desktop
    if (!api?.writeBackup) return
    const run = async () => {
      try {
        const list = await api.listBackups()
        if (list[0] && localDay(list[0].at) === localDay(Date.now())) return
        await api.writeBackup(JSON.stringify(buildProgressFile()))
      } catch {
        // a failed backup is shown in Settings → App health (no backup today)
      }
    }
    const first = setTimeout(() => void run(), 20_000)
    const every = setInterval(() => void run(), SIX_HOURS)
    return () => {
      clearTimeout(first)
      clearInterval(every)
    }
  }, [])
  return null
}

type Check = { ok: boolean | null; label: string; detail: string }

function CheckRow({ c }: { c: Check }) {
  const Icon = c.ok === null ? Info : c.ok ? CheckCircle2 : AlertTriangle
  return (
    <li className="flex items-start gap-2 text-xs">
      <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${c.ok === null ? 'text-info' : c.ok ? 'text-success' : 'text-danger'}`} />
      <span className="min-w-0 flex-1"><span className="text-ink">{c.label}</span> <span className="text-ink-muted">· {c.detail}</span></span>
    </li>
  )
}

/** Settings (desktop): one place that shows whether everything is working, plus the backups. */
export function HealthAndBackups() {
  const state = useDesktopStore((s) => s.state)
  const update = useDesktopStore((s) => s.updateStatus)
  const gameData = useGameData()
  const mode = useProgressStore((s) => s.gameMode)
  const now = useNow(60_000)
  const [backups, setBackups] = useState<BackupInfo[] | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const logs = useQuery({ queryKey: ['logStats'], queryFn: () => window.desktop!.readLogStats(), enabled: false, staleTime: 60_000 })
  const refreshBackups = () => void window.desktop?.listBackups().then(setBackups).catch(() => setBackups([]))
  useEffect(refreshBackups, [])

  const sessionMode = mode === 'pve' ? 'pve' : 'regular'
  const reset = logs.data?.resetAtByMode?.[sessionMode] ?? null
  const checks: Check[] = [
    state?.logsPath && state.status !== 'no-folder' && state.status !== 'error'
      ? { ok: true, label: 'Game logs folder', detail: `${state.status === 'paused' ? 'paused' : 'watching'} ${state.logsPath}` }
      : { ok: false, label: 'Game logs folder', detail: state?.message ?? 'not found: pick it under Game logs above' },
    state?.lastEventAt
      ? { ok: true, label: 'Last game activity read', detail: formatTimeAgo(state.lastEventAt) }
      : { ok: null, label: 'Last game activity read', detail: 'nothing yet this session (start the game and it appears here)' },
    gameData.data
      ? { ok: now - gameData.data.fetchedAt < 6 * SIX_HOURS, label: 'Game data from tarkov.dev', detail: `${mode === 'pve' ? 'PvE' : 'PvP'}, downloaded ${formatTimeAgo(gameData.data.fetchedAt)}` }
      : { ok: gameData.isError ? false : null, label: 'Game data from tarkov.dev', detail: gameData.isError ? 'could not download (offline?)' : 'loading…' },
    logs.data
      ? { ok: true, label: 'Profile reset / wipe', detail: reset ? `detected on ${formatDateTime(reset)}; older logs are ignored` : 'none found in the logs' }
      : { ok: null, label: 'Profile reset / wipe', detail: logs.isFetching ? 'reading the logs…' : 'press "Check logs"' },
    update
      ? { ok: update.state !== 'error', label: 'Updates', detail: update.state === 'none' ? 'up to date' : update.state === 'ready' ? `version ${update.version} downloaded, restart to apply` : update.state === 'error' ? update.message : update.state }
      : { ok: null, label: 'Updates', detail: 'checking…' },
    backups === null
      ? { ok: null, label: 'Daily backup', detail: 'checking…' }
      : backups[0]
        ? { ok: now - backups[0].at < 2 * 24 * 3_600_000, label: 'Daily backup', detail: `last one ${formatTimeAgo(backups[0].at)} (${backups.length} kept)` }
        : { ok: null, label: 'Daily backup', detail: 'none yet (the first one is made a minute after the app starts)' },
  ]

  return (
    <>
      <section className="space-y-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-muted"><Stethoscope className="h-3.5 w-3.5" /> App health</h3>
        <ul className="space-y-1">{checks.map((c) => <CheckRow key={c.label} c={c} />)}</ul>
        <button type="button" onClick={() => void logs.refetch()} className="btn !py-1 text-xs">Check logs</button>
      </section>

      <section className="space-y-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-muted"><HardDriveDownload className="h-3.5 w-3.5" /> Backups</h3>
        <p className="text-xs text-ink-muted">Every day the app saves your whole progress (quests, item collection, keys, hideout, drawings, story, raid log) in its own data folder and keeps the last 7 days.</p>
        {isTauri() && <p className="text-xs text-warning">Daily progress files exclude physical stash containers, scan history, screenshot evidence and recognition corrections. Use <Link className="underline" to="/stash">Stash Manager → Full backup and recovery</Link> to preserve those too.</p>}
        {backups && backups.length > 0 && (
          <ul className="divide-y divide-line rounded border border-line bg-surface text-xs">
            {backups.map((b) => (
              <li key={b.name} className="flex items-center gap-2 px-2 py-1">
                <span className="min-w-0 flex-1">{formatDateTime(b.at)} <span className="text-ink-dim">· {Math.round(b.size / 1024)} KB</span></span>
                <button
                  type="button"
                  onClick={async () => {
                    if (confirm !== b.name) return setConfirm(b.name)
                    setConfirm(null)
                    try {
                      const restored = importProgressFile(parseImportJson(await window.desktop!.readBackup(b.name)))
                      setMessage(`Restored ${restored.join(', ')} from ${new Date(b.at).toLocaleDateString()}.`)
                    } catch (err) {
                      setMessage(`Restore failed: ${err instanceof Error ? err.message : 'invalid file'}`)
                    }
                  }}
                  className={`inline-flex items-center gap-1 ${confirm === b.name ? 'text-danger' : 'text-accent'} underline`}
                >
                  <RotateCcw className="h-3 w-3" /> {confirm === b.name ? 'Click again: replaces your current progress' : 'Restore'}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() =>
              void window.desktop
                ?.writeBackup(JSON.stringify(buildProgressFile()))
                .then(() => {
                  setMessage('Backup saved.')
                  refreshBackups()
                })
                .catch((err: unknown) => setMessage(`Backup failed: ${err instanceof Error ? err.message : 'unknown error'}`))
            }
            className="btn !py-1 text-xs"
          >
            Back up now
          </button>
          <button type="button" onClick={() => void window.desktop?.openBackupsFolder()} className="btn !py-1 text-xs"><FolderOpen className="h-3.5 w-3.5" /> Open folder</button>
        </div>
        {message && <p className="text-xs text-info">{message}</p>}
      </section>
    </>
  )
}
