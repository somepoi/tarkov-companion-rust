import { useEffect, useState } from 'react'
import { CheckCircle2, Download, Loader2, TriangleAlert, X } from 'lucide-react'
import type { UpdateOutcome } from '../shared/desktop-api'
import { useDesktopStore } from './useDesktop'

/** Thin bar under the top of the window: "Update available, restart to apply". */
export function UpdateBanner() {
  const status = useDesktopStore((s) => s.updateStatus)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [outcomeError, setOutcomeError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<UpdateOutcome | null>(null)
  useEffect(() => {
    void window.desktop?.getUpdateOutcome?.().then(setOutcome).catch((cause: unknown) => setOutcomeError(String(cause)))
  }, [])

  if (status?.state === 'installing') {
    return (
      <div role="status" className="flex flex-wrap items-center gap-3 border-b border-info/50 bg-info/10 px-4 py-1.5 text-sm">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-info" />
        <span className="min-w-0 flex-1 break-words">
          Installing {status.version}… Tarkov Companion closes now and <strong>opens again by itself in about a minute</strong>. Please don't open it in the meantime.
        </span>
      </div>
    )
  }

  const outcomeBar = outcome ? (
    <div role="status" className={`flex flex-wrap items-center gap-3 border-b px-4 py-1.5 text-sm ${outcome.ok ? 'border-success/50 bg-success/10' : 'border-danger/50 bg-danger/10'}`}>
      {outcome.ok ? <CheckCircle2 className="h-4 w-4 shrink-0 text-success" /> : <TriangleAlert className="h-4 w-4 shrink-0 text-danger" />}
      <span className="min-w-0 flex-1">
        {outcome.native
          ? outcome.ok ? `Version ${outcome.version} or newer is now running.`
            : `The update to ${outcome.version} did not complete. Recovery copy: ${outcome.recoveryBackup ?? 'see Full backup and recovery in Stash Manager'}. Open Stash Manager → Full backup and recovery if you need to restore it.`
          : outcome.ok ? `Updated to ${outcome.version}.`
          : `The update to ${outcome.version} didn't finish. Click "Run the installer" to install it with the normal setup window (it closes the app itself), or "Restart to update" to try the automatic way again.`}
      </span>
      {!outcome.ok && !outcome.native && (
        <button type="button" onClick={() => void window.desktop?.runInstaller?.(outcome.version)} className="btn !py-1">
          Run the installer
        </button>
      )}
      <button type="button" onClick={() => setOutcome(null)} aria-label="Close" title="Close" className="text-ink-dim hover:text-ink">
        <X className="h-4 w-4" />
      </button>
    </div>
  ) : outcomeError ? <div role="alert" className="border-b border-danger/50 bg-danger/10 px-4 py-2 text-sm">
    Could not read the update result: {outcomeError}. Existing recovery copies are retained in Stash Manager.
  </div> : null

  if (!status || (status.state !== 'ready' && status.state !== 'available') || dismissed === status.version) return outcomeBar || null
  const portable = status.state === 'available' && !status.installable
  const notDownloaded = status.state === 'available' && status.installable
  return (
    <>
      {outcomeBar}
      <div role="status" className="flex flex-wrap items-center gap-3 border-b border-info/50 bg-info/10 px-4 py-1.5 text-sm">
        <Download className="h-4 w-4 shrink-0 text-info" />
        <span className="min-w-0 flex-1">
          {portable
            ? `Tarkov Companion ${status.version} is out. This is the portable version, so download the new exe (or use the installer to get automatic updates).`
            : notDownloaded
              ? `Tarkov Companion ${status.version} is out. "Download" fetches it in the background; you choose when to restart.`
              : `Tarkov Companion ${status.version} is downloaded. "Restart to update" closes the app, installs it (about a minute, nothing on screen) and opens it again.`}
        </span>
        <button type="button" onClick={() => void window.desktop?.installUpdate()} className="btn !py-1">
          {portable || notDownloaded ? 'Download' : 'Restart to update'}
        </button>
        <button type="button" onClick={() => setDismissed(status.version)} aria-label="Later" title="Later" className="text-ink-dim hover:text-ink">
          <X className="h-4 w-4" />
        </button>
      </div>
    </>
  )
}
