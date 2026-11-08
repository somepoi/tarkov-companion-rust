import { useEffect, useState } from 'react'
import { CheckCircle2, TriangleAlert, X } from 'lucide-react'
import type { UpdateOutcome } from '../shared/desktop-api'

/** Show the outcome of an explicitly staged native update after launch. */
export function UpdateBanner() {
  const [outcome, setOutcome] = useState<UpdateOutcome | null>(null)
  const [outcomeError, setOutcomeError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void window.desktop?.getUpdateOutcome().then((result) => {
      if (active) setOutcome(result)
    }).catch((cause: unknown) => {
      if (active) setOutcomeError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => { active = false }
  }, [])

  if (outcomeError) return (
    <div role="alert" className="border-b border-danger/50 bg-danger/10 px-4 py-2 text-sm">
      Could not read the update result. {outcomeError}. Recovery copies are available in Stash Manager.
    </div>
  )
  if (!outcome) return null
  return (
    <div role="status" className={`flex flex-wrap items-center gap-3 border-b px-4 py-1.5 text-sm ${outcome.ok ? 'border-success/50 bg-success/10' : 'border-danger/50 bg-danger/10'}`}>
      {outcome.ok ? <CheckCircle2 className="h-4 w-4 shrink-0 text-success" /> : <TriangleAlert className="h-4 w-4 shrink-0 text-danger" />}
      <span className="min-w-0 flex-1">
        {outcome.ok
          ? `Version ${outcome.version} or newer is now running.`
          : `The update to ${outcome.version} did not complete. To restore the recovery copy at ${outcome.recoveryBackup}, open Stash Manager → Full backup and recovery.`}
      </span>
      <button type="button" onClick={() => setOutcome(null)} aria-label="Close" title="Close" className="text-ink-dim hover:text-ink">
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
