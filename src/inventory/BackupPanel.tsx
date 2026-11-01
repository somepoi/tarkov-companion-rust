import { useState } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { useQuery } from '@tanstack/react-query'
import { buildRendererBackup } from './rendererBackup'

interface BackupProgress {
  stage: string
  bytes: number
  total: number | null
}
interface BackupList {
  backups: { name: string; createdAt: number; path: string }[]
  activeProfile: string
  originalProfile: string
  issues: string[]
  startupIssues: string[]
  canRevert: boolean
}
interface Recovery {
  recovery: string
  path: string
}
const call = <T,>(operation: Record<string, unknown>) =>
  invoke<T>('native_backup', { operation })

export function BackupPanel() {
  const list = useQuery({
    queryKey: ['nativeBackups'],
    queryFn: () => call<BackupList>({ operation: 'list' }),
  })
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<BackupProgress | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [recovery, setRecovery] = useState<Recovery | null>(null)
  const [confirmRevert, setConfirmRevert] = useState(false)
  async function act(work: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setError('')
    setMessage('')
    setProgress(null)
    let unlisten: UnlistenFn | undefined
    try {
      // Subscribe before invoking so fast jobs cannot outrun registration.
      unlisten = await listen<BackupProgress>('backup-progress', (event) => {
        setProgress(event.payload)
      })
      await work()
    } catch (e) {
      setError(String(e))
    } finally {
      unlisten?.()
      setProgress(null)
      setBusy(false)
    }
  }
  return (
    <section
      className="space-y-3 border-t border-line pt-5"
      aria-labelledby="stash-backup-title"
    >
      <h2 id="stash-backup-title" className="text-lg font-semibold">
        Full backup and recovery
      </h2>
      {list.data?.startupIssues.map((issue, i) => (
        <p key={i} role="alert" className="text-sm text-warning">
          {issue}
        </p>
      ))}
      <p className="text-sm text-ink-muted">
        Includes every native profile, container, scan history, reserves,
        archived screenshots, settings and saved interface data with recognition
        corrections. Game-data caches are downloaded again. These backups are
        kept until you remove them yourself. Export to another disk or folder
        to keep a copy outside the app data directory. The list reads backup manifests;
        full checksums and database validation run when preparing recovery.
      </p>
      <p className="text-xs text-ink-muted">
        The SQLite snapshot is transactional. Interface progress is captured
        separately at the start of the backup. Keep this app idle until it
        finishes. Save open scan drafts first; unsaved form edits are excluded.
      </p>
      {busy && (
        <div role="status" className="space-y-1 text-sm text-ink-muted">
          <p>{progress?.stage ?? 'Preparing saved interface data…'}</p>
          {progress?.total != null && (
            <>
              <progress className="w-full" aria-label="Current file progress"
                max={Math.max(1, progress.total)} value={progress.bytes} />
              <p className="text-xs">Current file: {(progress.bytes / 1048576).toFixed(1)} / {(progress.total / 1048576).toFixed(1)} MiB</p>
            </>
          )}
        </div>
      )}
      {!!list.data?.issues.length && (
        <div role="status" className="space-y-1 text-sm text-warning">
          <p>Some backup entries could not be listed. Their files have been retained.</p>
          <ul className="max-h-40 list-inside list-disc overflow-auto break-words text-xs">
            {list.data.issues.map((issue, i) => <li key={i}>{issue}</li>)}
          </ul>
        </div>
      )}
      <fieldset disabled={busy} className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <button
            className="btn"
            onClick={() =>
              void act(async () => {
                const result = await call<{ path: string }>({
                  operation: 'create',
                  rendererState: await buildRendererBackup(),
                })
                setMessage(`Backup saved: ${result.path}`)
                await list.refetch()
              })
            }
          >
            Create full backup
          </button>
          <button
            className="btn"
            onClick={() =>
              void act(async () => {
                const result = await call<{ path: string } | null>({
                  operation: 'export',
                  rendererState: await buildRendererBackup(),
                })
                if (result) setMessage(`Full backup exported: ${result.path}. Use Restore from a folder to recover it.`)
              })
            }
          >
            Export full backup…
          </button>
          <button
            className="btn"
            onClick={() =>
              void act(async () => {
                await call({ operation: 'openFolder' })
              })
            }
          >
            Open backup folder
          </button>
          <button
            className="btn"
            onClick={() =>
              void act(async () => {
                const result = await call<Recovery | null>({
                  operation: 'import',
                })
                if (result) setRecovery(result)
              })
            }
          >
            Restore from a folder…
          </button>
        </div>
        {list.data?.backups.length ? (
          <ul className="max-h-48 divide-y divide-line overflow-auto border-y border-line text-sm">
            {list.data.backups.map((backup) => (
              <li
                key={backup.name}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <span>{new Date(backup.createdAt).toLocaleString()}</span>
                <button
                  className="btn"
                  onClick={() =>
                    void act(async () => {
                      setRecovery(
                        await call<Recovery>({
                          operation: 'restore',
                          name: backup.name,
                        }),
                      )
                    })
                  }
                >
                  Prepare recovery
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-ink-dim">
            {list.isPending
              ? 'Loading full backups…'
              : list.isError
                ? 'Backup list could not be loaded.'
                : list.data?.issues.length
                  ? 'No readable backups found. Review the errors above or select a backup folder.'
                  : 'No full backups saved yet.'}
          </p>
        )}
        {list.isError && (
          <p role="alert" className="text-sm text-danger">
            {list.error.message}{' '}
            <button className="btn" onClick={() => void list.refetch()}>
              Retry
            </button>
          </p>
        )}
        {recovery && (
          <div role="status" className="space-y-2 border-l-2 border-info pl-3">
            <p className="break-all text-sm">
              Recovery prepared at {recovery.path}. Current saved data is
              retained. Save open drafts before activating. Activating restarts
              the app in a separate restored profile.
            </p>
            <button
              className="btn"
              onClick={() =>
                void act(async () => {
                  await call({
                    operation: 'activate',
                    recovery: recovery.recovery,
                  })
                })
              }
            >
              Activate restored profile and restart
            </button>
          </div>
        )}
        {list.data?.canRevert && (
          <div className="space-y-2">
            <p className="break-all text-xs text-ink-muted">
              Active recovered profile: {list.data.activeProfile}
            </p>
            <button
              className="btn"
              onClick={() => {
                if (!confirmRevert) {
                  setConfirmRevert(true)
                  return
                }
                void act(async () => {
                  await call({ operation: 'revert' })
                })
              }}
            >
              {confirmRevert
                ? 'Confirm: restart with the retained original profile'
                : 'Return to original profile…'}
            </button>
          </div>
        )}
      </fieldset>
      {error && (
        <p role="alert" className="break-words text-sm text-danger">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="break-all text-sm text-ink-muted">
          {message}
        </p>
      )}
    </section>
  )
}
